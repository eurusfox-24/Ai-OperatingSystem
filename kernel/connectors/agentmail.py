"""Manager-owned AgentMail gateway with server-enforced draft approval."""
from __future__ import annotations

import json
import os
import uuid
import base64
import binascii
import html
import re
from contextlib import closing
from typing import Any, Dict, List, Optional

from kernel.db.local_manager import db_manager


class AgentMailUnavailable(RuntimeError):
    pass


def _as_dict(item: Any) -> Dict[str, Any]:
    if isinstance(item, dict):
        return item
    for method in ("model_dump", "dict"):
        converter = getattr(item, method, None)
        if callable(converter):
            return converter()
    return dict(getattr(item, "__dict__", {}))


def _message_body(item: Dict[str, Any]) -> str:
    """Prefer complete message content, but retain the inbox-list preview as a safe fallback."""
    for field in ("extracted_text", "text", "text_body", "body", "preview"):
        value = item.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for field in ("extracted_html", "html"):
        value = item.get(field)
        if isinstance(value, str) and value.strip():
            plain = re.sub(r"<[^>]+>", " ", value)
            return html.unescape(re.sub(r"\s+", " ", plain)).strip()
    return ""


class AgentMailService:
    def _client(self) -> tuple[Any, str]:
        api_key = os.getenv("AGENTMAIL_API_KEY", "").strip()
        inbox_id = os.getenv("AGENTMAIL_MANAGER_INBOX", "").strip()
        if not api_key or not inbox_id:
            raise AgentMailUnavailable("Set AGENTMAIL_API_KEY and AGENTMAIL_MANAGER_INBOX in .env to enable Email Center")
        try:
            from agentmail import AgentMail  # type: ignore[import-not-found]
        except ImportError as exc:
            raise AgentMailUnavailable("AgentMail SDK is not installed. Run pip install agentmail.") from exc
        return AgentMail(api_key=api_key), inbox_id

    def status(self) -> Dict[str, Any]:
        configured = bool(os.getenv("AGENTMAIL_API_KEY", "").strip() and os.getenv("AGENTMAIL_MANAGER_INBOX", "").strip())
        return {"configured": configured, "inbox_id": os.getenv("AGENTMAIL_MANAGER_INBOX", "").strip() if configured else "", "mode": "draft_approval_required", "manager_only": True}

    def get_sync_preferences(self, username: str) -> Dict[str, Any]:
        """Return the user's persisted auto-sync preference, creating the MVP default."""
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute(
                "INSERT OR IGNORE INTO email_sync_preferences (username) VALUES (?)",
                (username[:100],),
            )
            row = conn.execute(
                "SELECT username, poll_minutes, last_synced_at, last_error FROM email_sync_preferences WHERE username = ?",
                (username[:100],),
            ).fetchone()
        return dict(row) if row else {"username": username, "poll_minutes": 15, "last_synced_at": None, "last_error": ""}

    def set_sync_preferences(self, username: str, poll_minutes: int) -> Dict[str, Any]:
        if poll_minutes not in {0, 5, 15, 30, 60}:
            raise ValueError("Choose Manual, 5, 15, 30, or 60 minutes for inbox auto-sync")
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute(
                """INSERT INTO email_sync_preferences (username, poll_minutes, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(username) DO UPDATE SET poll_minutes=excluded.poll_minutes, updated_at=datetime('now')""",
                (username[:100], poll_minutes),
            )
        return self.get_sync_preferences(username)

    def list_pollable_preferences(self) -> List[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute(
                "SELECT username, poll_minutes, last_synced_at FROM email_sync_preferences WHERE poll_minutes > 0"
            ).fetchall()
        return [dict(row) for row in rows]

    def record_sync_result(self, username: str, error: str = "") -> None:
        with closing(db_manager._get_connection()) as conn, conn:
            if error:
                conn.execute(
                    "UPDATE email_sync_preferences SET last_error=?, updated_at=datetime('now') WHERE username=?",
                    (error[:1000], username[:100]),
                )
            else:
                conn.execute(
                    "UPDATE email_sync_preferences SET last_synced_at=datetime('now'), last_error='', updated_at=datetime('now') WHERE username=?",
                    (username[:100],),
                )

    def _audit(self, username: str, action: str, message_id: str = "", draft_id: str = "", detail: str = "") -> None:
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("INSERT INTO email_audit (username, action, message_id, draft_id, detail) VALUES (?, ?, ?, ?, ?)", (username[:100], action[:80], message_id[:500], draft_id[:500], detail[:4000]))

    def sync(self, username: str, limit: int = 50) -> Dict[str, Any]:
        client, inbox_id = self._client()
        response = client.inboxes.messages.list(inbox_id, limit=max(1, min(limit, 100)))
        messages = getattr(response, "messages", response.get("messages", []) if isinstance(response, dict) else []) or []
        stored = 0
        with closing(db_manager._get_connection()) as conn, conn:
            for raw in messages:
                item = _as_dict(raw)
                message_id = str(item.get("message_id") or item.get("id") or "")
                if not message_id:
                    continue
                # List results often contain only a preview. Retrieve the detail when
                # necessary so the reading pane gets the full body.
                if not _message_body(item) or not any(item.get(key) for key in ("text", "html", "extracted_text", "extracted_html")):
                    try:
                        detail = _as_dict(client.inboxes.messages.get(inbox_id, message_id))
                        item = {**item, **detail}
                    except Exception:
                        # The preview still provides a useful, safe reading fallback.
                        pass
                recipients = item.get("to") or []
                if isinstance(recipients, str):
                    recipients = [recipients]
                sender = str(item.get("from") or item.get("from_") or "")
                conn.execute("""INSERT INTO email_messages (message_id, thread_id, inbox_id, username, sender, recipients_json, subject, text_body, received_at, direction, raw_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(message_id) DO UPDATE SET thread_id=excluded.thread_id, sender=excluded.sender, recipients_json=excluded.recipients_json, subject=excluded.subject, text_body=excluded.text_body, raw_json=excluded.raw_json""",
                    (message_id, str(item.get("thread_id") or ""), inbox_id, username[:100], sender, json.dumps(recipients), str(item.get("subject") or ""), _message_body(item)[:100000], str(item.get("received_at") or item.get("timestamp") or item.get("created_at") or ""), "outbound" if sender.lower() == inbox_id.lower() else "inbound", json.dumps(item, default=str)[:250000]))
                stored += 1
        self._audit(username, "sync", detail=f"Stored {stored} message(s)")
        return {"status": "success", "stored": stored, "inbox_id": inbox_id}

    def list_messages(self, username: str, limit: int = 100) -> List[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute("SELECT * FROM email_messages WHERE username = ? ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?", (username, max(1, min(limit, 200)))).fetchall()
        messages = [dict(row) for row in rows]
        # Backward-compatible recovery for messages stored before full-body
        # extraction was added. Their original AgentMail preview is preserved.
        for message in messages:
            if not str(message.get("text_body") or "").strip():
                try:
                    message["text_body"] = _message_body(json.loads(str(message.get("raw_json") or "{}")))
                except (TypeError, ValueError, json.JSONDecodeError):
                    pass
        return messages

    def create_draft(self, username: str, *, to: List[str], subject: str, text: str, in_reply_to: str = "") -> Dict[str, Any]:
        client, inbox_id = self._client()
        recipients = sorted({value.strip().lower() for value in to if value and value.strip()})
        if not recipients and not in_reply_to:
            raise ValueError("At least one recipient is required")
        if not subject.strip() and not in_reply_to:
            raise ValueError("A subject is required")
        if not text.strip():
            raise ValueError("Draft body is required")
        kwargs: Dict[str, Any] = {"inbox_id": inbox_id, "text": text.strip()}
        if in_reply_to:
            kwargs["in_reply_to"] = in_reply_to
        else:
            kwargs.update({"to": recipients, "subject": subject.strip()})
        remote = client.inboxes.drafts.create(**kwargs)
        remote_data = _as_dict(remote)
        draft_id = str(remote_data.get("draft_id") or remote_data.get("id") or f"local_{uuid.uuid4().hex}")
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("INSERT INTO email_drafts (draft_id, inbox_id, username, message_id, recipients_json, subject, text_body, status, remote_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)", (draft_id, inbox_id, username[:100], in_reply_to, json.dumps(recipients), subject.strip(), text.strip(), json.dumps(remote_data, default=str)[:250000]))
        self._audit(username, "draft_created", draft_id=draft_id, detail=subject.strip())
        return self.get_draft(username, draft_id) or {}

    def get_draft(self, username: str, draft_id: str) -> Optional[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            row = conn.execute("SELECT * FROM email_drafts WHERE draft_id = ? AND username = ?", (draft_id, username)).fetchone()
        return dict(row) if row else None

    def list_drafts(self, username: str) -> List[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute("SELECT * FROM email_drafts WHERE username = ? ORDER BY created_at DESC", (username,)).fetchall()
        return [dict(row) for row in rows]

    def approve_and_send(self, username: str, draft_id: str) -> Dict[str, Any]:
        draft = self.get_draft(username, draft_id)
        if not draft:
            raise KeyError("Draft not found")
        if draft["status"] != "pending_approval":
            raise ValueError("Only a pending draft can be sent")
        client, inbox_id = self._client()
        sent_data = _as_dict(client.inboxes.drafts.send(inbox_id=inbox_id, draft_id=draft_id))
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("UPDATE email_drafts SET status='sent', approved_by=?, approved_at=datetime('now'), sent_at=datetime('now'), remote_json=? WHERE draft_id=?", (username[:100], json.dumps(sent_data, default=str)[:250000], draft_id))
        self._audit(username, "draft_sent", draft_id=draft_id, detail=str(sent_data.get("message_id") or ""))
        return {"status": "sent", "draft_id": draft_id, "message_id": sent_data.get("message_id") or sent_data.get("id")}

    def reject_draft(self, username: str, draft_id: str) -> Dict[str, Any]:
        draft = self.get_draft(username, draft_id)
        if not draft:
            raise KeyError("Draft not found")
        if draft["status"] != "pending_approval":
            raise ValueError("Only a pending draft can be rejected")
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("UPDATE email_drafts SET status='rejected', approved_by=?, approved_at=datetime('now') WHERE draft_id=?", (username[:100], draft_id))
        self._audit(username, "draft_rejected", draft_id=draft_id)
        return {"status": "rejected", "draft_id": draft_id}

    def get_attachment(self, username: str, message_id: str, attachment_id: str) -> tuple[str, bytes]:
        """Fetch an attachment only for a message already mirrored to this user."""
        with closing(db_manager._get_connection()) as conn:
            exists = conn.execute("SELECT 1 FROM email_messages WHERE message_id=? AND username=?", (message_id, username)).fetchone()
        if not exists:
            raise KeyError("Email message not found")
        client, inbox_id = self._client()
        payload = _as_dict(client.inboxes.messages.get_attachment(inbox_id, message_id, attachment_id))
        filename = str(payload.get("filename") or payload.get("name") or f"email-attachment-{attachment_id}")
        content = payload.get("content") or payload.get("data") or ""
        if isinstance(content, bytes):
            raw = content
        else:
            encoded = str(content).split(",", 1)[-1]
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("AgentMail returned an attachment with invalid base64 content") from exc
        if not raw:
            raise ValueError("The attachment was empty")
        self._audit(username, "attachment_downloaded", message_id=message_id, detail=filename)
        return filename, raw


agentmail_service = AgentMailService()

__all__ = ["AgentMailUnavailable", "agentmail_service"]
