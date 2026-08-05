import os
import json
import logging
from typing import Dict, Any, Optional
from kernel.db.local_manager import db_manager

logger = logging.getLogger("user_manager")

USERS_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "users.json"))

DEFAULT_USERS = {
    "mikko": {
        "username": "mikko",
        "password": "joensuu123",
        "display_name": "Mikko Järvilehto",
        "role": "Executive Board Lead (Business Joensuu)",
        "tone_style": "formal_executive",
        "custom_instructions": "Focus on high-level strategic alignment, private-sector job creation, and Susicorn scaling. Keep intro short and actionable."
    },
    "analyst": {
        "username": "analyst",
        "password": "joensuu123",
        "display_name": "Regional Research Analyst",
        "role": "Bioeconomy Data Analyst",
        "tone_style": "data_analytical",
        "custom_instructions": "Provide detailed data breakdowns, numerical statistics, citations, and structured bulleted scorecards."
    },
    "investor": {
        "username": "investor",
        "password": "joensuu123",
        "display_name": "Venture Capital Partner",
        "role": "Inward Investment Director",
        "tone_style": "direct_financial",
        "custom_instructions": "Focus on financial ROI, venture capital deal flow, risks, and 3-year revenue potential."
    }
}

class UserManager:
    """Manages multi-user authentication, user contexts, and syncs custom profiles to local SQLite user_profiles table."""

    def __init__(self):
        os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
        self.users = self.load_users()

    def load_users(self) -> Dict[str, Any]:
        if not os.path.exists(USERS_FILE):
            self.save_users(DEFAULT_USERS)
            return DEFAULT_USERS
        try:
            with open(USERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error loading users file: {e}")
            return DEFAULT_USERS

    def save_users(self, data: Dict[str, Any]):
        self.users = data
        with open(USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(self.users, f, indent=2)

    def authenticate(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        user = self.users.get(username.lower())
        if user and user["password"] == password:
            profile = dict(user)
            profile.pop("password", None)
            
            # Sync session to local SQLite user_profiles table
            db_manager.save_user_profile(
                user_id=profile["username"],
                display_name=profile["display_name"],
                role=profile["role"],
                tone_style=profile.get("tone_style", "formal_executive"),
                custom_instructions=profile.get("custom_instructions", "")
            )

            return profile
        return None

    def get_user_profile(self, username: str) -> Optional[Dict[str, Any]]:
        user = self.users.get(username.lower())
        if user:
            profile = dict(user)
            profile.pop("password", None)
            return profile
        return None

    def update_customization(self, username: str, tone_style: str, custom_instructions: str) -> Dict[str, Any]:
        username = username.lower()
        if username not in self.users:
            raise ValueError(f"User '{username}' not found.")
        
        self.users[username]["tone_style"] = tone_style
        self.users[username]["custom_instructions"] = custom_instructions
        self.save_users(self.users)
        
        profile = dict(self.users[username])
        profile.pop("password", None)

        # Sync profile customization to local SQLite user_profiles table
        db_manager.save_user_profile(
            user_id=profile["username"],
            display_name=profile["display_name"],
            role=profile["role"],
            tone_style=tone_style,
            custom_instructions=custom_instructions
        )

        return profile

user_manager = UserManager()
