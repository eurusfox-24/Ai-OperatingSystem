import os
import json
import logging
import base64
import hashlib
import hmac
import secrets
from typing import Dict, Any, Optional
from kernel.db.local_manager import db_manager

logger = logging.getLogger("user_manager")

DEFAULT_USERS_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "data", "users.json")
USERS_FILE = os.path.abspath(os.getenv("AI_OS_USERS_FILE", "").strip() or DEFAULT_USERS_FILE)

DEFAULT_USERS = {
    "alex": {
        "username": "alex",
        "display_name": "Alex Virtanen",
        "role": "Executive Board Lead",
        "tone_style": "formal_executive",
        "custom_instructions": "Focus on high-level strategic alignment, private-sector job creation, and Susicorn scaling. Keep intro short and actionable."
    },
    "analyst": {
        "username": "analyst",
        "display_name": "Regional Research Analyst",
        "role": "Bioeconomy Data Analyst",
        "tone_style": "data_analytical",
        "custom_instructions": "Provide detailed data breakdowns, numerical statistics, citations, and structured bulleted scorecards."
    },
    "investor": {
        "username": "investor",
        "display_name": "Venture Capital Partner",
        "role": "Inward Investment Director",
        "tone_style": "direct_financial",
        "custom_instructions": "Focus on financial ROI, venture capital deal flow, risks, and 3-year revenue potential."
    }
}

PASSWORD_ITERATIONS = 600_000


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    if not password:
        raise ValueError("Password cannot be empty")
    actual_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), actual_salt, PASSWORD_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(actual_salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.urlsafe_b64decode(salt.encode("ascii")),
            int(iterations),
        )
        return hmac.compare_digest(base64.urlsafe_b64encode(actual).decode("ascii"), expected)
    except (ValueError, TypeError):
        return False

class UserManager:
    """Manages multi-user authentication, user contexts, and syncs custom profiles to local SQLite user_profiles table."""

    def __init__(self):
        os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
        self.users = self.load_users()

    def load_users(self) -> Dict[str, Any]:
        if not os.path.exists(USERS_FILE):
            bootstrap_password = os.getenv("AI_OS_BOOTSTRAP_PASSWORD", "").strip()
            if not bootstrap_password:
                raise RuntimeError(
                    "No user database exists. Set AI_OS_BOOTSTRAP_PASSWORD once to initialize secure local accounts."
                )
            defaults = {
                name: {**profile, "password_hash": hash_password(bootstrap_password)}
                for name, profile in DEFAULT_USERS.items()
            }
            self.save_users(defaults)
            return defaults
        try:
            with open(USERS_FILE, "r", encoding="utf-8") as f:
                users = json.load(f)
            migrated = False
            for user in users.values():
                plaintext = user.pop("password", None)
                if plaintext and not user.get("password_hash"):
                    user["password_hash"] = hash_password(str(plaintext))
                    migrated = True
                try:
                    session_version = max(0, int(user.get("session_version", 0)))
                except (TypeError, ValueError):
                    session_version = 0
                if user.get("session_version") != session_version:
                    user["session_version"] = session_version
                    migrated = True
            if migrated:
                logger.warning("Migrated local user records to the secure password/session schema.")
                self.save_users(users)
            return users
        except Exception as e:
            raise RuntimeError(f"The local user database is invalid: {e}") from e

    def save_users(self, data: Dict[str, Any]):
        sanitized = {
            username: {key: value for key, value in profile.items() if key != "password"}
            for username, profile in data.items()
        }
        self.users = sanitized
        temporary_path = f"{USERS_FILE}.tmp"
        with open(temporary_path, "w", encoding="utf-8") as f:
            json.dump(self.users, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, USERS_FILE)

    def authenticate(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        user = self.users.get(username.lower())
        if user and verify_password(password, str(user.get("password_hash") or "")):
            profile = dict(user)
            profile.pop("password_hash", None)
            
            # Sync session to local SQLite user_profiles table
            db_manager.save_user_profile(
                user_id=profile["username"],
                display_name=profile["display_name"],
                role=profile["role"],
                tone_style=profile.get("tone_style", "formal_executive"),
                custom_instructions=profile.get("custom_instructions", ""),
                language=profile.get("language", "en")
            )

            return profile
        return None

    def get_user_profile(self, username: str) -> Optional[Dict[str, Any]]:
        user = self.users.get(username.lower())
        if user:
            profile = dict(user)
            profile.pop("password", None)
            profile.pop("password_hash", None)
            return profile
        return None

    def change_password(self, username: str, current_password: str, new_password: str) -> bool:
        username = (username or "").strip().lower()
        user = self.users.get(username)
        if not user or not verify_password(current_password, str(user.get("password_hash") or "")):
            return False
        if len(new_password) < 12:
            raise ValueError("The new password must be at least 12 characters long.")
        if hmac.compare_digest(current_password, new_password):
            raise ValueError("The new password must be different from the current password.")
        user["password_hash"] = hash_password(new_password)
        user["session_version"] = int(user.get("session_version", 0)) + 1
        self.save_users(self.users)
        return True

    def update_customization(self, username: str, tone_style: str, custom_instructions: str, language: str = "en") -> Dict[str, Any]:
        username = username.lower()
        if username not in self.users:
            raise ValueError(f"User '{username}' not found.")
        
        self.users[username]["tone_style"] = tone_style
        self.users[username]["custom_instructions"] = custom_instructions
        self.users[username]["language"] = language
        self.save_users(self.users)
        
        profile = dict(self.users[username])
        profile.pop("password", None)
        profile.pop("password_hash", None)

        # Sync profile customization to local SQLite user_profiles table
        db_manager.save_user_profile(
            user_id=profile["username"],
            display_name=profile["display_name"],
            role=profile["role"],
            tone_style=tone_style,
            custom_instructions=custom_instructions,
            language=language
        )

        return profile

user_manager = UserManager()
