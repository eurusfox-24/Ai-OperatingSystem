"""Connector registry, persistence, scheduling and signal relevance scoring."""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import re
import uuid
from contextlib import closing
from typing import Any, Callable, Dict, List, Optional

from kernel.core.event_bus import event_bus
from kernel.db.local_manager import db_manager

from .rss import FeedValidationError, fetch_feed, validate_public_feed_url


UTC = datetime.timezone.utc
TOKEN_RE = re.compile(r"[a-zA-ZÀ-ž0-9][a-zA-ZÀ-ž0-9_-]{2,}")
STOPWORDS = {"and", "the", "for", "with", "from", "that", "this", "your", "into", "about", "ovat", "sekä", "joka", "tämä"}

# Public, no-login sources selected for strategic priorities, local, economic,
# research and forest-policy radar.  They are presets, not automatically
# activated: each user explicitly adds them from the product UI.
RECOMMENDED_RSS_FEEDS = [
    {"id": "yle-north-karelia", "name": "Yle North Karelia", "feed_url": "https://yle.fi/rss/t/18-141936/fi", "interest_query": "Joensuu North Karelia investment company jobs startup forestry bioeconomy infrastructure funding", "poll_minutes": 60, "minimum_relevance": 45},
    {"id": "yle-economy", "name": "Yle Economy", "feed_url": "https://yle.fi/rss/t/18-19274/fi", "interest_query": "forest industry industrial investment exports financing startup energy clean technology", "poll_minutes": 120, "minimum_relevance": 50},
    {"id": "yle-science", "name": "Yle Science", "feed_url": "https://yle.fi/rss/t/18-819/fi", "interest_query": "forestry biomaterials circular economy wood construction AI robotics clean technology", "poll_minutes": 360, "minimum_relevance": 45},
    {"id": "yle-nature", "name": "Yle Nature", "feed_url": "https://yle.fi/rss/t/18-35354/fi", "interest_query": "forest biodiversity carbon sinks land use climate policy bioeconomy", "poll_minutes": 360, "minimum_relevance": 45},
    {"id": "oph-latest", "name": "Finnish National Agency for Education", "feed_url": "https://oph.fi/fi/latest.rss", "interest_query": "funding grant workforce education internationalization digital skills Erasmus", "poll_minutes": 720, "minimum_relevance": 40},
    {"id": "eurostat-updates", "name": "Eurostat Statistics Updates", "feed_url": "https://ec.europa.eu/eurostat/api/dissemination/catalogue/rss/en/statistics-update.rss", "interest_query": "forestry employment regional economy research development energy business", "poll_minutes": 720, "minimum_relevance": 40},
]


def _now() -> datetime.datetime:
    return datetime.datetime.now(UTC)


def _iso(value: datetime.datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _row(row: Any) -> Dict[str, Any]:
    return dict(row) if row is not None else {}


def _tokens(value: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(value or "") if token.lower() not in STOPWORDS}


def score_signal(item: Dict[str, Any], interest_query: str, project_id: str) -> tuple[int, str]:
    interests = _tokens(interest_query)
    content_tokens = _tokens(f"{item.get('title', '')} {item.get('summary', '')} {item.get('content', '')}")
    if interests:
        matched = interests & content_tokens
        topic_score = round(60 * len(matched) / max(1, len(interests)))
        match_text = ", ".join(sorted(matched)[:8]) if matched else "no requested topics matched"
    else:
        topic_score = 30
        match_text = "no interest filter configured"

    freshness = 5
    published = str(item.get("published_at") or "")
    if published:
        try:
            age = _now() - datetime.datetime.fromisoformat(published.replace("Z", "+00:00"))
            freshness = 15 if age.days <= 7 else 10 if age.days <= 30 else 5 if age.days <= 180 else 0
        except ValueError:
            pass
    source_score = 15
    project_score = 10 if project_id else 5
    total = max(0, min(100, topic_score + freshness + source_score + project_score))
    return total, f"Topic match: {match_text}; freshness {freshness}/15; source 15/15; project context {project_score}/10."


class ConnectorService:
    def __init__(self, feed_fetcher: Callable[[str], Dict[str, Any]] = fetch_feed) -> None:
        self.feed_fetcher = feed_fetcher
        self._scheduler_task: Optional[asyncio.Task] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._active_syncs: set[str] = set()

    @staticmethod
    def registry() -> List[Dict[str, Any]]:
        return [{
            "id": "rss",
            "name": "RSS and Atom Feeds",
            "version": "1.0.0",
            "description": "Read public RSS/Atom feeds and turn entries into project-scoped signals.",
            "capabilities": ["read_external", "scheduled_sync", "signal_creation"],
            "auth": "none",
            "operational": True,
        }]

    @staticmethod
    def recommended_feeds() -> List[Dict[str, Any]]:
        """Return copy-safe preset metadata; the user still chooses to add it."""
        return [dict(feed) for feed in RECOMMENDED_RSS_FEEDS]

    def add_recommended_feeds(self, username: str, project_id: str = "") -> List[Dict[str, Any]]:
        existing = {str(item.get("config", {}).get("feed_url") or "") for item in self.list_instances(username=username)}
        created: List[Dict[str, Any]] = []
        for feed in self.recommended_feeds():
            if feed["feed_url"] in existing:
                continue
            created.append(self.create_instance(username=username, project_id=project_id, enabled=True, **{key: value for key, value in feed.items() if key != "id"}))
        return created

    def create_instance(self, *, name: str, feed_url: str, username: str = "alex", project_id: str = "",
                        interest_query: str = "", poll_minutes: int = 60, minimum_relevance: int = 40,
                        enabled: bool = True) -> Dict[str, Any]:
        safe_url = validate_public_feed_url(feed_url, resolve=False)
        if not name.strip():
            raise ValueError("Connector name is required")
        if not 5 <= poll_minutes <= 10080:
            raise ValueError("Poll interval must be between 5 minutes and 7 days")
        if not 0 <= minimum_relevance <= 100:
            raise ValueError("Minimum relevance must be between 0 and 100")
        if project_id and not db_manager.get_notebook(project_id):
            raise ValueError("Selected project does not exist")
        instance_id = f"connector_{uuid.uuid4().hex}"
        next_sync = _iso(_now() + datetime.timedelta(minutes=poll_minutes)) if enabled else None
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute(
                """INSERT INTO connector_instances
                   (id, connector_type, name, username, project_id, config_json, interest_query,
                    poll_minutes, minimum_relevance, enabled, next_sync_at)
                   VALUES (?, 'rss', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (instance_id, name.strip()[:200], (username or "alex")[:100], project_id,
                 json.dumps({"feed_url": safe_url}), interest_query.strip()[:4000], poll_minutes,
                 minimum_relevance, int(enabled), next_sync),
            )
        return self.get_instance(instance_id) or {}

    def get_instance(self, instance_id: str) -> Optional[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            item = _row(conn.execute("SELECT * FROM connector_instances WHERE id = ?", (instance_id,)).fetchone())
            if not item:
                return None
            item["config"] = json.loads(item.pop("config_json") or "{}")
            item["enabled"] = bool(item.get("enabled"))
            return item

    def list_instances(self, username: str = "", project_id: str = "") -> List[Dict[str, Any]]:
        clauses, params = [], []
        if username:
            clauses.append("username = ?")
            params.append(username)
        if project_id:
            clauses.append("project_id = ?")
            params.append(project_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute(f"SELECT id FROM connector_instances {where} ORDER BY created_at DESC", params).fetchall()
        return [item for item in (self.get_instance(row["id"]) for row in rows) if item]

    def update_instance(self, instance_id: str, **changes: Any) -> Optional[Dict[str, Any]]:
        current = self.get_instance(instance_id)
        if not current:
            return None
        feed_url = validate_public_feed_url(changes.get("feed_url", current["config"].get("feed_url", "")), resolve=False)
        poll_minutes = int(changes.get("poll_minutes", current["poll_minutes"]))
        minimum = int(changes.get("minimum_relevance", current["minimum_relevance"]))
        if not 5 <= poll_minutes <= 10080 or not 0 <= minimum <= 100:
            raise ValueError("Connector interval or relevance threshold is outside the allowed range")
        enabled = bool(changes.get("enabled", current["enabled"]))
        project_id = str(changes.get("project_id", current["project_id"]))
        if project_id and not db_manager.get_notebook(project_id):
            raise ValueError("Selected project does not exist")
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute(
                """UPDATE connector_instances SET name = ?, project_id = ?, config_json = ?, interest_query = ?,
                   poll_minutes = ?, minimum_relevance = ?, enabled = ?, next_sync_at = CASE WHEN ? = 1 THEN COALESCE(next_sync_at, ?) ELSE NULL END,
                   updated_at = datetime('now') WHERE id = ?""",
                (str(changes.get("name", current["name"])).strip()[:200], project_id,
                 json.dumps({"feed_url": feed_url}), str(changes.get("interest_query", current["interest_query"])).strip()[:4000],
                 poll_minutes, minimum, int(enabled), int(enabled), _iso(_now()), instance_id),
            )
        return self.get_instance(instance_id)

    async def test_instance(self, instance_id: str) -> Dict[str, Any]:
        instance = self.get_instance(instance_id)
        if not instance:
            raise KeyError("Connector not found")
        feed = await asyncio.to_thread(self.feed_fetcher, instance["config"]["feed_url"])
        return {"status": "success", "feed_title": feed["title"], "item_count": len(feed["items"]), "url": feed["url"]}

    async def sync_instance(self, instance_id: str) -> Dict[str, Any]:
        if instance_id in self._active_syncs:
            return {"status": "already_running", "instance_id": instance_id}
        instance = self.get_instance(instance_id)
        if not instance:
            raise KeyError("Connector not found")
        self._active_syncs.add(instance_id)
        agent_id = f"foresightagent_feed_{instance_id[-8:]}"
        run_id = 0
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("UPDATE connector_instances SET status = 'syncing', last_error = '', updated_at = datetime('now') WHERE id = ?", (instance_id,))
            run_id = int(conn.execute("INSERT INTO connector_sync_runs (instance_id) VALUES (?)", (instance_id,)).lastrowid)
        await event_bus.notify_agent_spawned(agent_id, "Foresight Agent", "ForesightAgent", f"Syncing {instance['name']}", "#7C3AED")
        await event_bus.notify_agent_update(agent_id, "working", f"Reading external feed: {instance['name']}")
        try:
            feed = await asyncio.to_thread(self.feed_fetcher, instance["config"]["feed_url"])
            created = 0
            for item in feed["items"]:
                score, reason = score_signal(item, instance["interest_query"], instance["project_id"])
                content_hash = hashlib.sha256(f"{item['title']}\n{item['summary']}\n{item['content']}".encode("utf-8")).hexdigest()
                external_id = str(item.get("external_id") or item.get("source_url") or content_hash)
                signal_id = "signal_" + hashlib.sha256(f"{instance_id}:{external_id}".encode("utf-8")).hexdigest()[:32]
                with closing(db_manager._get_connection()) as conn, conn:
                    exists = conn.execute("SELECT 1 FROM external_signals WHERE id = ?", (signal_id,)).fetchone()
                    conn.execute(
                        """INSERT INTO external_signals
                           (id, instance_id, project_id, source_name, source_url, external_id, title, summary, content,
                            published_at, content_hash, relevance_score, relevance_reason, metadata_json)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary,
                            content = excluded.content, published_at = excluded.published_at, content_hash = excluded.content_hash,
                            relevance_score = excluded.relevance_score, relevance_reason = excluded.relevance_reason,
                            updated_at = datetime('now')""",
                        (signal_id, instance_id, instance["project_id"], feed["title"], item.get("source_url") or feed["url"],
                         external_id[:2000], item["title"], item["summary"], item["content"], item.get("published_at"),
                         content_hash, score, reason, json.dumps({"feed_url": feed["url"]})),
                    )
                if not exists:
                    created += 1
            completed = _now()
            next_sync = completed + datetime.timedelta(minutes=int(instance["poll_minutes"]))
            with closing(db_manager._get_connection()) as conn, conn:
                conn.execute("""UPDATE connector_instances SET status = 'healthy', last_sync_at = ?, next_sync_at = ?,
                             last_error = '', updated_at = datetime('now') WHERE id = ?""", (_iso(completed), _iso(next_sync), instance_id))
                conn.execute("""UPDATE connector_sync_runs SET status = 'completed', items_seen = ?, items_created = ?,
                             completed_at = ? WHERE id = ?""", (len(feed["items"]), created, _iso(completed), run_id))
            await event_bus.notify_agent_update(agent_id, "complete", f"Found {created} new signal(s) in {instance['name']}")
            await event_bus.broadcast("SIGNALS_UPDATED", {"instance_id": instance_id, "items_created": created})
            return {"status": "completed", "instance_id": instance_id, "items_seen": len(feed["items"]), "items_created": created}
        except Exception as exc:
            message = str(exc)[:2000]
            next_retry = _now() + datetime.timedelta(minutes=max(5, int(instance["poll_minutes"])))
            with closing(db_manager._get_connection()) as conn, conn:
                conn.execute("UPDATE connector_instances SET status = 'error', last_error = ?, next_sync_at = ?, updated_at = datetime('now') WHERE id = ?", (message, _iso(next_retry), instance_id))
                conn.execute("UPDATE connector_sync_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?", (message, _iso(_now()), run_id))
            await event_bus.notify_agent_update(agent_id, "error", f"Feed sync failed: {message[:120]}")
            raise
        finally:
            await event_bus.notify_agent_terminated(agent_id)
            self._active_syncs.discard(instance_id)

    def list_signals(self, *, project_id: str = "", instance_id: str = "", username: str = "", minimum_relevance: int = 0, limit: int = 100) -> List[Dict[str, Any]]:
        clauses, params = ["relevance_score >= ?"], [minimum_relevance]
        if project_id:
            clauses.append("project_id = ?")
            params.append(project_id)
        if instance_id:
            clauses.append("instance_id = ?")
            params.append(instance_id)
        if username:
            clauses.append("instance_id IN (SELECT id FROM connector_instances WHERE username = ?)")
            params.append(username)
        params.append(max(1, min(limit, 500)))
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute(
                f"SELECT * FROM external_signals WHERE {' AND '.join(clauses)} ORDER BY relevance_score DESC, COALESCE(published_at, retrieved_at) DESC LIMIT ?",
                params,
            ).fetchall()
        items = []
        for row in rows:
            item = _row(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            items.append(item)
        return items

    def get_signal(self, signal_id: str) -> Optional[Dict[str, Any]]:
        with closing(db_manager._get_connection()) as conn:
            row = conn.execute("SELECT * FROM external_signals WHERE id = ?", (signal_id,)).fetchone()
        if not row:
            return None
        item = _row(row)
        item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
        return item

    def mark_signal_promoted(self, signal_id: str, goal_id: str) -> None:
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("UPDATE external_signals SET promoted_goal_id = ?, updated_at = datetime('now') WHERE id = ?", (goal_id, signal_id))

    def due_instance_ids(self) -> List[str]:
        with closing(db_manager._get_connection()) as conn:
            rows = conn.execute("""SELECT id FROM connector_instances WHERE enabled = 1 AND status != 'syncing'
                                 AND (next_sync_at IS NULL OR next_sync_at <= ?) ORDER BY next_sync_at LIMIT 10""", (_iso(_now()),)).fetchall()
        return [str(row["id"]) for row in rows]

    async def _scheduler_loop(self) -> None:
        assert self._stop_event is not None
        while not self._stop_event.is_set():
            due = self.due_instance_ids()
            if due:
                results = await asyncio.gather(
                    *(self.sync_instance(instance_id) for instance_id in due),
                    return_exceptions=True,
                )
                for instance_id, result in zip(due, results):
                    if isinstance(result, Exception):
                        logger.warning("Scheduled connector sync failed for %s: %s", instance_id, result)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=30)
            except asyncio.TimeoutError:
                pass

    def start_scheduler(self) -> None:
        if self._scheduler_task and not self._scheduler_task.done():
            return
        self._stop_event = asyncio.Event()
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    async def stop_scheduler(self) -> None:
        if not self._scheduler_task:
            return
        if self._stop_event:
            self._stop_event.set()
        await self._scheduler_task
        self._scheduler_task = None


connector_service = ConnectorService()

__all__ = ["ConnectorService", "FeedValidationError", "connector_service", "score_signal"]
