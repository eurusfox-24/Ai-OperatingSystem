"""Small, dependency-free authentication boundary for the local AI OS API."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict, Optional


logger = logging.getLogger("auth")


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class AuthService:
    """Issues signed bearer tokens and applies a bounded login-attempt policy."""

    def __init__(self) -> None:
        configured_secret = os.getenv("AI_OS_AUTH_SECRET", "").strip()
        if configured_secret:
            self._secret = configured_secret.encode("utf-8")
        else:
            self._secret = secrets.token_bytes(48)
            logger.warning(
                "AI_OS_AUTH_SECRET is not configured; using a process-local secret. "
                "Existing sessions will expire when the kernel restarts."
            )
        self.ttl_seconds = max(300, min(int(os.getenv("AI_OS_AUTH_TTL_SECONDS", "28800")), 604800))
        self._revoked: Dict[str, int] = {}
        self._revoked_subjects: Dict[str, int] = {}
        self._last_issued_ns = 0
        self._attempts: Dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    @staticmethod
    def _is_admin_role(role: str) -> bool:
        value = (role or "").lower()
        return "executive board lead" in value or "administrator" in value

    def issue_token(self, profile: Dict[str, Any]) -> str:
        now = int(time.time())
        with self._lock:
            issued_ns = max(time.time_ns(), self._last_issued_ns + 1)
            self._last_issued_ns = issued_ns
        payload = {
            "sub": str(profile.get("username") or ""),
            "role": str(profile.get("role") or ""),
            "admin": self._is_admin_role(str(profile.get("role") or "")),
            "ver": int(profile.get("session_version") or 0),
            "iat": now,
            "iat_ns": issued_ns,
            "exp": now + self.ttl_seconds,
            "jti": secrets.token_urlsafe(18),
        }
        encoded = _b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        signature = _b64encode(hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).digest())
        return f"{encoded}.{signature}"

    def verify_token(self, token: str) -> Optional[Dict[str, Any]]:
        try:
            encoded, supplied_signature = token.split(".", 1)
            expected = _b64encode(hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).digest())
            if not hmac.compare_digest(supplied_signature, expected):
                return None
            payload = json.loads(_b64decode(encoded).decode("utf-8"))
            now = int(time.time())
            if not payload.get("sub") or int(payload.get("exp") or 0) <= now:
                return None
            jti = str(payload.get("jti") or "")
            with self._lock:
                self._prune_revocations(now)
                if jti in self._revoked:
                    return None
                revoked_at = self._revoked_subjects.get(str(payload["sub"]), 0)
                if revoked_at and int(payload.get("iat_ns") or 0) <= revoked_at:
                    return None
            return payload
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
            return None

    @staticmethod
    def matches_session(payload: Dict[str, Any], profile: Optional[Dict[str, Any]]) -> bool:
        """Confirm a signed token still matches the user's persisted session version."""
        if not profile:
            return False
        try:
            return int(payload.get("ver", -1)) == int(profile.get("session_version", 0))
        except (TypeError, ValueError):
            return False

    def revoke_token(self, token: str) -> bool:
        payload = self.verify_token(token)
        if not payload:
            return False
        with self._lock:
            self._revoked[str(payload["jti"])] = int(payload["exp"])
        return True

    def revoke_subject(self, username: str) -> None:
        """Invalidate every token already issued for a user."""
        with self._lock:
            cutoff = max(time.time_ns(), self._last_issued_ns)
            self._revoked_subjects[username] = max(self._revoked_subjects.get(username, 0), cutoff)

    def allow_login_attempt(self, remote_id: str) -> bool:
        """Allow at most ten login attempts per remote address in five minutes."""
        now = time.monotonic()
        key = remote_id or "unknown"
        with self._lock:
            attempts = self._attempts[key]
            while attempts and now - attempts[0] > 300:
                attempts.popleft()
            if len(attempts) >= 10:
                return False
            attempts.append(now)
            return True

    def clear_login_attempts(self, remote_id: str) -> None:
        with self._lock:
            self._attempts.pop(remote_id or "unknown", None)

    def _prune_revocations(self, now: int) -> None:
        for jti, expiry in list(self._revoked.items()):
            if expiry <= now:
                self._revoked.pop(jti, None)


auth_service = AuthService()


__all__ = ["AuthService", "auth_service"]
