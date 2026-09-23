import os
import tempfile
import unittest
from unittest.mock import patch

from kernel.core.auth import AuthService
import kernel.core.users as users_module
from kernel.core.users import UserManager, hash_password, verify_password
from kernel.db.local_manager import db_manager
import kernel.rag.doc_store as doc_store_module


class SecurityAndDocumentTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db_manager.db_path
        self.original_docs_dir = doc_store_module.DOCS_STORAGE_DIR
        db_manager.db_path = os.path.join(self.tempdir.name, "documents-test.db")
        db_manager._init_database()
        doc_store_module.DOCS_STORAGE_DIR = os.path.join(self.tempdir.name, "documents")
        os.makedirs(doc_store_module.DOCS_STORAGE_DIR, exist_ok=True)

    def tearDown(self):
        db_manager.db_path = self.original_db_path
        doc_store_module.DOCS_STORAGE_DIR = self.original_docs_dir
        self.tempdir.cleanup()

    def test_password_hashes_do_not_store_plaintext(self):
        encoded = hash_password("correct horse battery staple")
        self.assertNotIn("correct horse battery staple", encoded)
        self.assertTrue(verify_password("correct horse battery staple", encoded))
        self.assertFalse(verify_password("wrong", encoded))

    def test_password_change_replaces_hash_without_touching_real_users(self):
        users_path = os.path.join(self.tempdir.name, "users.json")
        original_password = "correct horse battery staple"
        replacement_password = "new battery staple 2026"
        with open(users_path, "w", encoding="utf-8") as handle:
            handle.write(
                '{"alex":{"username":"alex","display_name":"Alex","role":"Analyst",'
                '"tone_style":"formal","custom_instructions":"","password_hash":"'
                + hash_password(original_password)
                + '"}}'
            )
        with patch.object(users_module, "USERS_FILE", users_path):
            manager = UserManager()
            self.assertFalse(manager.change_password("alex", "wrong password", replacement_password))
            with self.assertRaises(ValueError):
                manager.change_password("alex", original_password, "too short")
            self.assertTrue(manager.change_password("alex", original_password, replacement_password))
            self.assertEqual(manager.get_user_profile("alex")["session_version"], 1)
            self.assertIsNone(manager.authenticate("alex", original_password))
            self.assertEqual(manager.authenticate("alex", replacement_password)["username"], "alex")
        with open(users_path, "r", encoding="utf-8") as handle:
            persisted = handle.read()
        self.assertNotIn(original_password, persisted)
        self.assertNotIn(replacement_password, persisted)

    def test_signed_token_rejects_tampering_and_revocation(self):
        with patch.dict(os.environ, {"AI_OS_AUTH_SECRET": "unit-test-secret"}):
            service = AuthService()
        token = service.issue_token({"username": "alex", "role": "Executive Board Lead"})
        self.assertEqual(service.verify_token(token)["sub"], "alex")
        self.assertIsNone(service.verify_token(token + "tampered"))
        self.assertTrue(service.revoke_token(token))
        self.assertIsNone(service.verify_token(token))

    def test_persisted_session_version_survives_auth_service_restart(self):
        profile = {"username": "alex", "role": "Analyst", "session_version": 3}
        with patch.dict(os.environ, {"AI_OS_AUTH_SECRET": "unit-test-secret"}):
            first_service = AuthService()
            token = first_service.issue_token(profile)
            restarted_service = AuthService()
        payload = restarted_service.verify_token(token)
        self.assertTrue(restarted_service.matches_session(payload, profile))
        changed_profile = {**profile, "session_version": 4}
        self.assertFalse(restarted_service.matches_session(payload, changed_profile))

    def test_subject_revocation_invalidates_old_sessions_only(self):
        with patch.dict(os.environ, {"AI_OS_AUTH_SECRET": "unit-test-secret"}):
            service = AuthService()
        first = service.issue_token({"username": "alex", "role": "Analyst"})
        second = service.issue_token({"username": "alex", "role": "Analyst"})
        service.revoke_subject("alex")
        self.assertIsNone(service.verify_token(first))
        self.assertIsNone(service.verify_token(second))
        replacement = service.issue_token({"username": "alex", "role": "Analyst"})
        self.assertEqual(service.verify_token(replacement)["sub"], "alex")

    def test_login_rate_limit_is_bounded(self):
        with patch.dict(os.environ, {"AI_OS_AUTH_SECRET": "unit-test-secret"}):
            service = AuthService()
        self.assertTrue(all(service.allow_login_attempt("client") for _ in range(10)))
        self.assertFalse(service.allow_login_attempt("client"))

    def test_document_ingestion_is_atomic_and_deletes_raw_file(self):
        engine = doc_store_module.DocumentIngestionEngine()
        engine.generate_ai_summary = lambda *_args: "Summary"
        with patch.object(doc_store_module.azure_client, "get_embedding", return_value=[0.0] * 1536):
            result = engine.ingest_document("brief.txt", b"Evidence for the board. " * 180)
        self.assertEqual(result["status"], "success")
        detail = db_manager.get_document_details("brief.txt")
        self.assertIsNotNone(detail)
        self.assertGreater(detail["chunks_indexed"], 0)
        self.assertEqual(detail["chunks_indexed"], len(detail["chunks"]))
        raw_path = os.path.join(doc_store_module.DOCS_STORAGE_DIR, "brief.txt")
        self.assertTrue(os.path.isfile(raw_path))
        self.assertTrue(engine.delete_document("brief.txt"))
        self.assertFalse(os.path.exists(raw_path))
        self.assertIsNone(db_manager.get_document_details("brief.txt"))

    def test_document_filename_cannot_escape_storage(self):
        engine = doc_store_module.DocumentIngestionEngine()
        result = engine.ingest_document("../outside.txt", b"blocked")
        self.assertEqual(result["status"], "error")
        self.assertFalse(os.path.exists(os.path.join(self.tempdir.name, "outside.txt")))


if __name__ == "__main__":
    unittest.main()
