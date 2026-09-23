"""SQLite persistence for durable goals, plans, tasks, approvals and artifacts."""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Iterable, List, Optional

from kernel.db.local_manager import db_manager


@contextmanager
def _connection():
    """Commit or roll back and always release the SQLite file handle."""
    conn = db_manager._get_connection()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


JSON_FIELDS = {
    "notebook_ids_json": "notebook_ids",
    "source_doc_names_json": "source_doc_names",
    "depends_on_json": "depends_on",
    "input_json": "input",
    "output_json": "output",
    "metadata_json": "metadata",
    "payload_json": "payload",
    "evidence_json": "evidence",
}


def _loads(value: Any, default: Any) -> Any:
    try:
        parsed = json.loads(value or "")
        return parsed
    except (TypeError, json.JSONDecodeError):
        return default


def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    result = dict(row)
    for raw, friendly in JSON_FIELDS.items():
        if raw in result:
            default = [] if raw.endswith("ids_json") or raw in {"depends_on_json", "evidence_json"} else {}
            result[friendly] = _loads(result.get(raw), default)
    for key in ("web_access", "cancel_requested", "pause_requested", "schedule_enabled"):
        if key in result:
            result[key] = bool(result[key])
    return result


class GoalStore:
    TERMINAL = {"completed", "failed", "cancelled"}
    ACTIVE = {"queued", "planning", "running", "waiting_approval"}

    def create_goal(
        self,
        *,
        title: str,
        objective: str,
        success_criteria_md: str,
        username: str,
        project_id: str,
        notebook_ids: List[str],
        source_doc_names: List[str],
        web_access: bool,
        max_steps: int,
        max_retries: int,
        max_runtime_minutes: int,
        max_cost_usd: float,
        auto_start: bool,
        work_type: str = "project_assessment",
        source_type: str = "ui",
        source_ref: str = "",
    ) -> Dict[str, Any]:
        goal_id = f"goal_{uuid.uuid4().hex}"
        status = "queued" if auto_start else "draft"
        with _connection() as conn:
            conn.execute(
                """
                INSERT INTO agentic_goals
                    (id, title, objective, success_criteria_md, username, project_id,
                     notebook_ids_json, source_doc_names_json, web_access, status,
                     max_steps, max_retries, max_runtime_minutes, max_cost_usd,
                     work_type, source_type, source_ref, root_goal_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    goal_id, title[:200], objective, success_criteria_md, username[:100], project_id[:300],
                    json.dumps(notebook_ids), json.dumps(source_doc_names), int(web_access), status,
                    max_steps, max_retries, max_runtime_minutes, max_cost_usd,
                    work_type[:50], source_type[:50], source_ref[:300], goal_id,
                ),
            )
            self._event_conn(conn, goal_id, None, "goal_created", username, f"Goal created in {status} state")
        return self.get_goal(goal_id) or {}

    def create_single_task(
        self,
        *,
        prompt: str,
        username: str = "alex",
        project_id: str = "",
        notebook_ids: Optional[List[str]] = None,
        source_doc_names: Optional[List[str]] = None,
        scheduled_at: Optional[str] = None,
        scheduled_timezone: str = "UTC",
        schedule_enabled: bool = False,
        chat_session_id: str = "",
        source_type: str = "ui",
        source_ref: str = "",
        auto_start: bool = False,
        root_goal_id: str = "",
        parent_goal_id: str = "",
        version: int = 1,
        web_access: bool = False,
    ) -> Dict[str, Any]:
        instructions = prompt.strip()
        if not instructions:
            raise ValueError("Task instructions are required")
        goal_id = f"goal_{uuid.uuid4().hex}"
        task_id = f"agtask_{uuid.uuid4().hex}"
        status = "queued" if auto_start else "draft"
        root_id = root_goal_id or goal_id
        with _connection() as conn:
            conn.execute(
                """INSERT INTO agentic_goals
                   (id, title, objective, success_criteria_md, username, project_id, notebook_ids_json,
                    source_doc_names_json, web_access, status, plan_version, max_steps, max_retries,
                    max_runtime_minutes, max_cost_usd, work_type, source_type, source_ref,
                    schedule_enabled, scheduled_at, scheduled_timezone, chat_session_id,
                    root_goal_id, parent_goal_id, version)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 4, 1, 30, 5.0, 'single_task', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    goal_id, instructions[:200], instructions,
                    "Complete the requested task with an evidence-grounded result, explicit uncertainty, and no unapproved external action.",
                    (username or "alex")[:100], project_id[:300], json.dumps(notebook_ids or []),
                    json.dumps(source_doc_names or []), int(web_access), status, source_type[:50], source_ref[:300],
                    int(schedule_enabled), scheduled_at, scheduled_timezone[:100] or "UTC", chat_session_id[:100],
                    root_id, parent_goal_id, max(1, int(version)),
                ),
            )
            conn.execute(
                """INSERT INTO agentic_tasks
                   (id, goal_id, plan_version, sequence_no, title, instructions, agent_type, capability,
                    risk_level, status, depends_on_json, input_json, max_attempts, idempotency_key)
                   VALUES (?, ?, 1, 1, ?, ?, 'ManagerAgent', 'single_task', 'internal_write',
                    'pending', '[]', ?, 2, ?)""",
                (task_id, goal_id, instructions[:200], instructions, json.dumps({"prompt": instructions}), f"{goal_id}:v1:single"),
            )
            self._event_conn(conn, goal_id, task_id, "work_created", username or "alex", f"Single task created in {status} state")
        return self.get_goal(goal_id) or {}

    @staticmethod
    def _work_status(goal_status: str) -> str:
        if goal_status == "draft":
            return "pending"
        if goal_status in {"queued", "planning", "running", "waiting_approval", "paused"}:
            return "running" if goal_status not in {"paused", "waiting_approval"} else goal_status
        if goal_status == "completed":
            return "done"
        return "failed"

    def as_work_item(self, goal: Dict[str, Any]) -> Dict[str, Any]:
        tasks = goal.get("tasks") or []
        task = tasks[0] if tasks else {}
        output = task.get("output") or {}
        result_md = str(goal.get("result_md") or output.get("summary") or "")
        scheduled_at = goal.get("scheduled_at") or goal.get("created_at")
        return {
            "id": goal["id"],
            "goal_id": goal["id"],
            "agentic_task_id": task.get("id", ""),
            "prompt": goal.get("objective", ""),
            "title": goal.get("title", ""),
            "status": self._work_status(str(goal.get("status") or "draft")),
            "goal_status": goal.get("status"),
            "scheduled_time": scheduled_at,
            "scheduled_timezone": goal.get("scheduled_timezone") or "UTC",
            "schedule_enabled": bool(goal.get("schedule_enabled")),
            "result_summary": " ".join(result_md.split())[:500],
            "result_md": result_md,
            "error_message": goal.get("error_message") or task.get("error_message") or "",
            "root_task_id": goal.get("root_goal_id") or goal["id"],
            "parent_task_id": goal.get("parent_goal_id") or "",
            "version": int(goal.get("version") or 1),
            "username": goal.get("username") or "alex",
            "notebook_ids_json": json.dumps(goal.get("notebook_ids") or []),
            "chat_session_id": goal.get("chat_session_id") or "",
            "source_type": goal.get("source_type") or "ui",
            "created_at": goal.get("created_at"),
            "started_at": goal.get("started_at"),
            "completed_at": goal.get("completed_at"),
        }

    def list_work_items(self, limit: int = 500, username: str = "") -> List[Dict[str, Any]]:
        with _connection() as conn:
            owner_clause = " AND username = ?" if username else ""
            params: List[Any] = [username] if username else []
            params.append(max(1, min(limit, 1000)))
            ids = [str(row["id"]) for row in conn.execute(
                """SELECT id FROM agentic_goals WHERE work_type = 'single_task'
                   {owner_clause}
                   ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                   COALESCE(scheduled_at, created_at) ASC LIMIT ?""".format(owner_clause=owner_clause),
                params,
            ).fetchall()]
        return [self.as_work_item(goal) for goal in (self.get_goal(item) for item in ids) if goal]

    @staticmethod
    def _board_task_status(status: str) -> str:
        if status in {"pending", "blocked", "queued", "waiting_approval"}:
            return "pending"
        if status == "running":
            return "running"
        return "done" if status in {"completed", "skipped"} else "failed"

    def list_board_items(self, limit: int = 500, username: str = "") -> List[Dict[str, Any]]:
        """Project standalone work and every planned multi-step goal task onto one board."""
        items = self.list_work_items(limit=limit, username=username)
        remaining = max(0, min(limit, 1000) - len(items))
        if not remaining:
            return items
        with _connection() as conn:
            owner_clause = " AND g.username = ?" if username else ""
            params: List[Any] = [username] if username else []
            params.append(remaining)
            rows = conn.execute(
                """SELECT t.*, g.title AS goal_title, g.status AS goal_status,
                          g.username, g.project_id, g.created_at AS goal_created_at
                   FROM agentic_tasks t
                   JOIN agentic_goals g ON g.id = t.goal_id
                   WHERE g.work_type <> 'single_task'
                   {owner_clause}
                   ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1
                            WHEN 'pending' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
                            t.sequence_no ASC, t.created_at ASC
                   LIMIT ?""".format(owner_clause=owner_clause),
                params,
            ).fetchall()
        for raw in rows:
            task = _row(raw) or {}
            output = task.get("output") or {}
            summary = str(output.get("summary") or output.get("response") or "")
            items.append({
                "id": task.get("id"),
                "goal_id": task.get("goal_id"),
                "agentic_task_id": task.get("id"),
                "prompt": task.get("title") or task.get("instructions") or "Goal step",
                "title": task.get("title") or "Goal step",
                "goal_title": task.get("goal_title") or "Agent goal",
                "status": self._board_task_status(str(task.get("status") or "pending")),
                "goal_status": task.get("goal_status"),
                "step_status": task.get("status"),
                "scheduled_time": task.get("created_at") or task.get("goal_created_at"),
                "schedule_enabled": False,
                "result_summary": " ".join(summary.split())[:500],
                "error_message": task.get("error_message") or "",
                "version": int(task.get("plan_version") or 1),
                "username": task.get("username") or "alex",
                "source_type": "goal_step",
                "managed_by_goal": True,
                "created_at": task.get("created_at") or task.get("goal_created_at"),
                "started_at": task.get("started_at"),
                "completed_at": task.get("completed_at"),
            })
        return items

    def get_work_item(self, goal_id: str) -> Optional[Dict[str, Any]]:
        goal = self.get_goal(goal_id)
        if not goal or goal.get("work_type") != "single_task":
            return None
        return self.as_work_item(goal)

    def update_work_item(self, goal_id: str, *, prompt: str, project_id: str, notebook_ids: List[str],
                         source_doc_names: List[str], scheduled_at: Optional[str], scheduled_timezone: str,
                         schedule_enabled: bool) -> Optional[Dict[str, Any]]:
        with _connection() as conn:
            current = conn.execute("SELECT status, work_type FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone()
            if not current or current["work_type"] != "single_task" or current["status"] != "draft":
                return None
            conn.execute(
                """UPDATE agentic_goals SET title = ?, objective = ?, project_id = ?, notebook_ids_json = ?,
                   source_doc_names_json = ?, scheduled_at = ?, scheduled_timezone = ?, schedule_enabled = ?,
                   updated_at = datetime('now') WHERE id = ?""",
                (prompt[:200], prompt, project_id, json.dumps(notebook_ids), json.dumps(source_doc_names), scheduled_at,
                 scheduled_timezone[:100] or "UTC", int(schedule_enabled), goal_id),
            )
            conn.execute("UPDATE agentic_tasks SET title = ?, instructions = ?, input_json = ? WHERE goal_id = ?",
                         (prompt[:200], prompt, json.dumps({"prompt": prompt}), goal_id))
            self._event_conn(conn, goal_id, None, "work_updated", "user", "Task instructions or schedule updated")
        return self.get_work_item(goal_id)

    def delete_work_item(self, goal_id: str) -> bool:
        with _connection() as conn:
            cur = conn.execute(
                "DELETE FROM agentic_goals WHERE id = ? AND work_type = 'single_task' AND status NOT IN ('queued','planning','running')",
                (goal_id,),
            )
            return bool(cur.rowcount)

    def due_work_goal_ids(self, now_iso: str) -> List[str]:
        with _connection() as conn:
            return [str(row["id"]) for row in conn.execute(
                """SELECT id FROM agentic_goals WHERE work_type = 'single_task' AND status = 'draft'
                   AND schedule_enabled = 1 AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20""",
                (now_iso,),
            ).fetchall()]

    def get_work_versions(self, goal_id: str) -> List[Dict[str, Any]]:
        item = self.get_work_item(goal_id)
        if not item:
            return []
        root_id = str(item.get("root_task_id") or goal_id)
        with _connection() as conn:
            ids = [str(row["id"]) for row in conn.execute(
                "SELECT id FROM agentic_goals WHERE work_type = 'single_task' AND root_goal_id = ? ORDER BY version, created_at",
                (root_id,),
            ).fetchall()]
        return [self.as_work_item(goal) for goal in (self.get_goal(item_id) for item_id in ids) if goal]

    def rerun_work_item(self, goal_id: str, scheduled_timezone: str = "UTC") -> Optional[Dict[str, Any]]:
        original_goal = self.get_goal(goal_id)
        if not original_goal or original_goal.get("work_type") != "single_task" or original_goal.get("status") not in {"completed", "failed", "cancelled"}:
            return None
        root_id = str(original_goal.get("root_goal_id") or goal_id)
        with _connection() as conn:
            row = conn.execute("SELECT COALESCE(MAX(version), 0) AS latest FROM agentic_goals WHERE root_goal_id = ?", (root_id,)).fetchone()
        return self.create_single_task(
            prompt=str(original_goal.get("objective") or ""), username=str(original_goal.get("username") or "alex"),
            project_id=str(original_goal.get("project_id") or ""), notebook_ids=original_goal.get("notebook_ids") or [],
            source_doc_names=original_goal.get("source_doc_names") or [], scheduled_timezone=scheduled_timezone,
            schedule_enabled=False, source_type="rerun", source_ref=f"rerun:{goal_id}:{uuid.uuid4().hex}",
            root_goal_id=root_id, parent_goal_id=goal_id, version=int(row["latest"] or 0) + 1,
            web_access=bool(original_goal.get("web_access")),
        )

    def migrate_legacy_kanban(self) -> int:
        migrated = 0
        with _connection() as conn:
            legacy = [dict(row) for row in conn.execute("SELECT * FROM kanban_tasks ORDER BY created_at").fetchall()]
        for item in legacy:
            source_ref = str(item.get("id") or "")
            with _connection() as conn:
                if conn.execute("SELECT 1 FROM agentic_goals WHERE source_type = 'legacy_kanban' AND source_ref = ?", (source_ref,)).fetchone():
                    continue
            notebook_ids = _loads(item.get("notebook_ids_json"), [])
            goal = self.create_single_task(
                prompt=str(item.get("prompt") or "Legacy task"), username=str(item.get("username") or "alex"),
                notebook_ids=notebook_ids if isinstance(notebook_ids, list) else [],
                scheduled_at=item.get("scheduled_time"), scheduled_timezone=str(item.get("scheduled_timezone") or "UTC"),
                schedule_enabled=bool(item.get("schedule_enabled")), chat_session_id=str(item.get("chat_session_id") or ""),
                source_type="legacy_kanban", source_ref=source_ref, auto_start=False, version=int(item.get("version") or 1),
            )
            goal_id = str(goal["id"])
            legacy_status = str(item.get("status") or "pending")
            goal_status = {"pending": "draft", "running": "queued", "done": "completed", "failed": "failed"}.get(legacy_status, "draft")
            task_status = {"pending": "pending", "running": "queued", "done": "completed", "failed": "failed"}.get(legacy_status, "pending")
            output = {"summary": item.get("result_md") or item.get("result_summary") or ""}
            with _connection() as conn:
                conn.execute("""UPDATE agentic_goals SET status = ?, result_md = ?, error_message = ?, created_at = ?,
                             started_at = ?, completed_at = ?, updated_at = COALESCE(?, created_at) WHERE id = ?""",
                             (goal_status, item.get("result_md") or item.get("result_summary") or "", item.get("error_message") or "",
                              item.get("created_at"), item.get("started_at"), item.get("completed_at"), item.get("completed_at"), goal_id))
                conn.execute("UPDATE agentic_tasks SET status = ?, output_json = ?, error_message = ?, started_at = ?, completed_at = ? WHERE goal_id = ?",
                             (task_status, json.dumps(output), item.get("error_message") or "", item.get("started_at"), item.get("completed_at"), goal_id))
            migrated += 1
        return migrated

    def get_goal(self, goal_id: str, include_details: bool = True) -> Optional[Dict[str, Any]]:
        with _connection() as conn:
            goal = _row(conn.execute("SELECT * FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone())
            if not goal or not include_details:
                return goal
            goal["tasks"] = [_row(item) for item in conn.execute(
                "SELECT * FROM agentic_tasks WHERE goal_id = ? ORDER BY plan_version, sequence_no, created_at", (goal_id,)
            ).fetchall()]
            goal["events"] = [_row(item) for item in conn.execute(
                "SELECT * FROM agentic_events WHERE goal_id = ? ORDER BY id", (goal_id,)
            ).fetchall()]
            goal["artifacts"] = [_row(item) for item in conn.execute(
                "SELECT * FROM agentic_artifacts WHERE goal_id = ? ORDER BY id", (goal_id,)
            ).fetchall()]
            goal["proposals"] = [_row(item) for item in conn.execute(
                "SELECT * FROM agentic_action_proposals WHERE goal_id = ? ORDER BY id", (goal_id,)
            ).fetchall()]
            return goal

    def list_goals(self, username: str = "", project_id: str = "", limit: int = 100) -> List[Dict[str, Any]]:
        clauses: List[str] = []
        values: List[Any] = []
        if username:
            clauses.append("g.username = ?")
            values.append(username)
        if project_id:
            clauses.append("g.project_id = ?")
            values.append(project_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(max(1, min(int(limit), 200)))
        with _connection() as conn:
            rows = conn.execute(
                f"""
                SELECT g.*,
                       COUNT(DISTINCT t.id) AS task_count,
                       COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_task_count,
                       COUNT(DISTINCT CASE WHEN p.status = 'pending' THEN p.id END) AS pending_approval_count
                FROM agentic_goals g
                LEFT JOIN agentic_tasks t ON t.goal_id = g.id
                LEFT JOIN agentic_action_proposals p ON p.goal_id = g.id
                {where}
                GROUP BY g.id
                ORDER BY g.updated_at DESC
                LIMIT ?
                """,
                values,
            ).fetchall()
            return [_row(item) or {} for item in rows]

    def start_goal(self, goal_id: str) -> bool:
        with _connection() as conn:
            previous = conn.execute("SELECT status FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone()
            cur = conn.execute(
                """UPDATE agentic_goals SET status = 'queued', pause_requested = 0,
                   cancel_requested = 0, error_message = '', updated_at = datetime('now')
                   WHERE id = ? AND status IN ('draft','paused','failed')""",
                (goal_id,),
            )
            if cur.rowcount:
                if previous and previous["status"] == "failed":
                    conn.execute(
                        """UPDATE agentic_tasks SET
                           status = CASE WHEN status IN ('failed','queued') THEN 'queued'
                                         WHEN status IN ('skipped','cancelled') THEN 'pending' ELSE status END,
                           attempt_count = CASE WHEN status IN ('failed','skipped','cancelled') THEN 0 ELSE attempt_count END,
                           error_message = CASE WHEN status IN ('failed','skipped','cancelled') THEN '' ELSE error_message END
                           WHERE goal_id = ?""",
                        (goal_id,),
                    )
                self._event_conn(conn, goal_id, None, "goal_queued", "user", "Goal queued for orchestration")
            return bool(cur.rowcount)

    def claim_goal(self, goal_id: str) -> bool:
        with _connection() as conn:
            cur = conn.execute(
                """UPDATE agentic_goals SET status = CASE WHEN plan_version = 0 THEN 'planning' ELSE 'running' END,
                   started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
                   WHERE id = ? AND status = 'queued' AND cancel_requested = 0 AND pause_requested = 0""",
                (goal_id,),
            )
            return bool(cur.rowcount)

    def set_goal_status(self, goal_id: str, status: str, *, result_md: str = "", error: str = "") -> bool:
        terminal_time = ", completed_at = datetime('now')" if status in self.TERMINAL else ""
        with _connection() as conn:
            cur = conn.execute(
                f"""UPDATE agentic_goals SET status = ?, result_md = CASE WHEN ? != '' THEN ? ELSE result_md END,
                    error_message = ?, updated_at = datetime('now'){terminal_time} WHERE id = ?""",
                (status, result_md, result_md, error[:4000], goal_id),
            )
            if cur.rowcount:
                self._event_conn(conn, goal_id, None, f"goal_{status}", "orchestrator", error or f"Goal {status}")
            return bool(cur.rowcount)

    def request_control(self, goal_id: str, control: str, content: str = "") -> bool:
        with _connection() as conn:
            goal = conn.execute("SELECT status, steering_md FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone()
            if not goal or goal["status"] in self.TERMINAL:
                return False
            if control == "pause":
                conn.execute("UPDATE agentic_goals SET pause_requested = 1, updated_at = datetime('now') WHERE id = ?", (goal_id,))
            elif control == "cancel":
                if goal["status"] in {"draft", "paused", "waiting_approval"}:
                    conn.execute(
                        """UPDATE agentic_goals SET status = 'cancelled', cancel_requested = 1,
                           updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?""",
                        (goal_id,),
                    )
                    conn.execute(
                        "UPDATE agentic_tasks SET status = 'cancelled' WHERE goal_id = ? AND status NOT IN ('completed','failed')",
                        (goal_id,),
                    )
                else:
                    conn.execute("UPDATE agentic_goals SET cancel_requested = 1, updated_at = datetime('now') WHERE id = ?", (goal_id,))
            elif control == "steer" and content.strip():
                steering = (str(goal["steering_md"] or "") + "\n- " + content.strip()).strip()
                conn.execute("UPDATE agentic_goals SET steering_md = ?, updated_at = datetime('now') WHERE id = ?", (steering, goal_id))
            else:
                return False
            self._event_conn(conn, goal_id, None, f"user_{control}", "user", content or f"{control.title()} requested")
            return True

    def recover_interrupted(self) -> List[str]:
        """Return interrupted goals to the queue after a process restart."""
        with _connection() as conn:
            rows = conn.execute(
                "SELECT id FROM agentic_goals WHERE status IN ('planning','running') AND pause_requested = 0 AND cancel_requested = 0"
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if ids:
                conn.execute("UPDATE agentic_tasks SET status = 'queued', error_message = 'Recovered after restart' WHERE status = 'running'")
                placeholders = ",".join("?" for _ in ids)
                conn.execute(f"UPDATE agentic_goals SET status = 'queued', updated_at = datetime('now') WHERE id IN ({placeholders})", ids)
                for goal_id in ids:
                    self._event_conn(conn, goal_id, None, "goal_recovered", "system", "Interrupted work was re-queued after restart")
            return ids

    def create_plan(self, goal_id: str, tasks: Iterable[Dict[str, Any]]) -> int:
        task_list = list(tasks)
        with _connection() as conn:
            goal = conn.execute("SELECT plan_version, max_retries FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone()
            if not goal:
                raise ValueError("Goal not found")
            version = int(goal["plan_version"] or 0) + 1
            aliases: Dict[str, str] = {}
            for index, spec in enumerate(task_list, 1):
                aliases[str(spec.get("key") or index)] = f"agtask_{uuid.uuid4().hex}"
            for index, spec in enumerate(task_list, 1):
                key = str(spec.get("key") or index)
                dependencies = [aliases[item] for item in spec.get("depends_on", []) if item in aliases]
                task_id = aliases[key]
                conn.execute(
                    """
                    INSERT INTO agentic_tasks
                        (id, goal_id, plan_version, sequence_no, title, instructions, agent_type,
                         capability, risk_level, status, depends_on_json, input_json, max_attempts, idempotency_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                    """,
                    (
                        task_id, goal_id, version, index, str(spec.get("title") or key)[:200],
                        str(spec.get("instructions") or ""), str(spec.get("agent_type") or "ManagerAgent"),
                        str(spec.get("capability") or "analysis"), str(spec.get("risk_level") or "read"),
                        json.dumps(dependencies), json.dumps(spec.get("input") or {}),
                        int(goal["max_retries"] or 0) + 1, f"{goal_id}:v{version}:{key}",
                    ),
                )
            conn.execute(
                "UPDATE agentic_goals SET plan_version = ?, status = 'running', updated_at = datetime('now') WHERE id = ?",
                (version, goal_id),
            )
            self._event_conn(conn, goal_id, None, "plan_created", "orchestrator", f"Plan v{version} created with {len(task_list)} tasks")
            return version

    def ready_tasks(self, goal_id: str) -> List[Dict[str, Any]]:
        with _connection() as conn:
            rows = conn.execute(
                "SELECT * FROM agentic_tasks WHERE goal_id = ? AND status IN ('pending','queued') ORDER BY sequence_no", (goal_id,)
            ).fetchall()
            status_rows = conn.execute("SELECT id, status FROM agentic_tasks WHERE goal_id = ?", (goal_id,)).fetchall()
            statuses = {str(item["id"]): str(item["status"]) for item in status_rows}
            ready: List[Dict[str, Any]] = []
            for raw in rows:
                item = _row(raw) or {}
                deps = item.get("depends_on") or []
                if all(statuses.get(dep) == "completed" for dep in deps):
                    ready.append(item)
                elif any(statuses.get(dep) in {"failed", "cancelled", "skipped"} for dep in deps):
                    conn.execute(
                        "UPDATE agentic_tasks SET status = 'skipped', error_message = 'A dependency did not complete' WHERE id = ?",
                        (item["id"],),
                    )
            return ready

    def claim_task(self, task_id: str) -> bool:
        with _connection() as conn:
            cur = conn.execute(
                """UPDATE agentic_tasks SET status = 'running', attempt_count = attempt_count + 1,
                   started_at = COALESCE(started_at, datetime('now')), error_message = ''
                   WHERE id = ? AND status IN ('pending','queued')""",
                (task_id,),
            )
            return bool(cur.rowcount)

    def finish_task(self, task_id: str, output: Dict[str, Any]) -> bool:
        with _connection() as conn:
            task = conn.execute("SELECT goal_id FROM agentic_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task:
                return False
            conn.execute(
                "UPDATE agentic_tasks SET status = 'completed', output_json = ?, completed_at = datetime('now') WHERE id = ?",
                (json.dumps(output), task_id),
            )
            self._event_conn(conn, task["goal_id"], task_id, "task_completed", "agent", str(output.get("summary") or "Task completed")[:1000])
            return True

    def fail_task(self, task_id: str, error: str) -> str:
        with _connection() as conn:
            task = conn.execute("SELECT goal_id, attempt_count, max_attempts FROM agentic_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task:
                return "missing"
            retry = int(task["attempt_count"]) < int(task["max_attempts"])
            status = "queued" if retry else "failed"
            conn.execute("UPDATE agentic_tasks SET status = ?, error_message = ? WHERE id = ?", (status, error[:4000], task_id))
            self._event_conn(conn, task["goal_id"], task_id, "task_retry" if retry else "task_failed", "orchestrator", error[:1000])
            return status

    def task_counts(self, goal_id: str) -> Dict[str, int]:
        with _connection() as conn:
            rows = conn.execute("SELECT status, COUNT(*) AS n FROM agentic_tasks WHERE goal_id = ? GROUP BY status", (goal_id,)).fetchall()
            return {str(row["status"]): int(row["n"]) for row in rows}

    def add_artifact(self, goal_id: str, task_id: Optional[str], artifact_type: str, title: str, content_md: str, evidence: List[Any]) -> int:
        with _connection() as conn:
            cur = conn.execute(
                "INSERT INTO agentic_artifacts (goal_id, task_id, artifact_type, title, content_md, evidence_json) VALUES (?, ?, ?, ?, ?, ?)",
                (goal_id, task_id, artifact_type, title[:300], content_md, json.dumps(evidence)),
            )
            self._event_conn(conn, goal_id, task_id, "artifact_created", "agent", title[:300])
            return int(cur.lastrowid)

    def propose_action(self, goal_id: str, task_id: Optional[str], action_type: str, summary: str, payload: Dict[str, Any], risk_level: str = "consequential") -> Dict[str, Any]:
        key = f"proposal:{goal_id}:{task_id or 'goal'}:{uuid.uuid4().hex}"
        with _connection() as conn:
            cur = conn.execute(
                """INSERT INTO agentic_action_proposals
                   (goal_id, task_id, action_type, risk_level, summary, payload_json, idempotency_key)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (goal_id, task_id, action_type[:100], risk_level, summary, json.dumps(payload), key),
            )
            self._event_conn(conn, goal_id, task_id, "approval_requested", "agent", summary[:1000])
            proposal_id = int(cur.lastrowid)
        return self.get_proposal(proposal_id) or {}

    def get_proposal(self, proposal_id: int) -> Optional[Dict[str, Any]]:
        with _connection() as conn:
            return _row(conn.execute("SELECT * FROM agentic_action_proposals WHERE id = ?", (proposal_id,)).fetchone())

    def decide_proposal(self, proposal_id: int, decision: str, decided_by: str) -> Optional[Dict[str, Any]]:
        if decision not in {"approved", "rejected"}:
            return None
        with _connection() as conn:
            proposal = conn.execute("SELECT * FROM agentic_action_proposals WHERE id = ? AND status = 'pending'", (proposal_id,)).fetchone()
            if not proposal:
                return None
            conn.execute(
                "UPDATE agentic_action_proposals SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
                (decision, decided_by[:100], proposal_id),
            )
            if decision == "approved":
                conn.execute(
                    """UPDATE agentic_tasks SET status = 'queued', approval_id = ?, error_message = ''
                       WHERE id = ? AND status = 'waiting_approval'""",
                    (proposal_id, proposal["task_id"]),
                )
                conn.execute(
                    """UPDATE agentic_goals SET status = 'queued', updated_at = datetime('now')
                       WHERE id = ? AND status = 'waiting_approval'""",
                    (proposal["goal_id"],),
                )
            else:
                conn.execute(
                    """UPDATE agentic_tasks SET status = 'cancelled', approval_id = ?,
                       error_message = 'Action rejected by the user', completed_at = datetime('now')
                       WHERE id = ? AND status = 'waiting_approval'""",
                    (proposal_id, proposal["task_id"]),
                )
                conn.execute(
                    """UPDATE agentic_tasks SET status = 'cancelled', error_message = 'Goal cancelled after action rejection',
                       completed_at = datetime('now') WHERE goal_id = ?
                       AND status IN ('pending','blocked','queued')""",
                    (proposal["goal_id"],),
                )
                conn.execute(
                    """UPDATE agentic_goals SET status = 'cancelled', error_message = 'Consequential action rejected by the user',
                       updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?""",
                    (proposal["goal_id"],),
                )
            self._event_conn(conn, proposal["goal_id"], proposal["task_id"], f"approval_{decision}", decided_by, proposal["summary"][:1000])
        return self.get_proposal(proposal_id)

    def add_goal_cost(self, goal_id: str, cost_usd: float) -> float:
        """Atomically add observed model cost and return the new goal total."""
        amount = max(0.0, float(cost_usd or 0.0))
        with _connection() as conn:
            conn.execute(
                "UPDATE agentic_goals SET spent_cost_usd = spent_cost_usd + ?, updated_at = datetime('now') WHERE id = ?",
                (amount, goal_id),
            )
            row = conn.execute("SELECT spent_cost_usd FROM agentic_goals WHERE id = ?", (goal_id,)).fetchone()
            return float(row["spent_cost_usd"] or 0.0) if row else 0.0

    def _event_conn(self, conn: sqlite3.Connection, goal_id: str, task_id: Optional[str], event_type: str, actor: str, message: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        conn.execute(
            "INSERT INTO agentic_events (goal_id, task_id, event_type, actor, message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
            (goal_id, task_id, event_type[:100], actor[:100], message[:4000], json.dumps(metadata or {})),
        )


goal_store = GoalStore()
