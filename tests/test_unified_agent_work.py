import asyncio
import datetime
import os
import tempfile
import unittest

from kernel.agentic.orchestrator import goal_orchestrator
from kernel.agentic.store import goal_store
from kernel.db.local_manager import db_manager
from kernel.server import _should_queue_chat_task


class UnifiedAgentWorkTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db_manager.db_path
        db_manager.db_path = os.path.join(self.tempdir.name, "unified-work-test.db")
        db_manager._init_database()

    def tearDown(self):
        db_manager.db_path = self.original_db_path
        self.tempdir.cleanup()

    def test_single_task_is_a_goal_and_kanban_projection(self):
        goal = goal_store.create_single_task(prompt="Prepare a forestry brief", source_type="kanban")
        self.assertEqual(goal["work_type"], "single_task")
        self.assertEqual(goal["status"], "draft")
        self.assertEqual(len(goal["tasks"]), 1)
        item = goal_store.get_work_item(goal["id"])
        self.assertEqual(item["goal_id"], goal["id"])
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["prompt"], "Prepare a forestry brief")

    def test_scheduled_work_becomes_due(self):
        due = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        goal = goal_store.create_single_task(prompt="Check funding", scheduled_at=due, schedule_enabled=True)
        self.assertIn(goal["id"], goal_store.due_work_goal_ids(datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")))

    def test_board_includes_steps_from_multi_step_goals(self):
        goal = goal_store.create_goal(
            title="Assess Project Aurora", objective="Assess Project Aurora", success_criteria_md="Decision brief",
            username="alex", project_id="", notebook_ids=[], source_doc_names=[], web_access=False,
            max_steps=5, max_retries=1, max_runtime_minutes=15, max_cost_usd=2.0, auto_start=False,
        )
        goal_store.create_plan(goal["id"], [
            {"key": "research", "title": "Research evidence", "instructions": "Research evidence"},
            {"key": "brief", "title": "Prepare brief", "instructions": "Prepare brief", "depends_on": ["research"]},
        ])
        items = [item for item in goal_store.list_board_items() if item["goal_id"] == goal["id"]]
        self.assertEqual([item["prompt"] for item in items], ["Research evidence", "Prepare brief"])
        self.assertTrue(all(item["managed_by_goal"] for item in items))

    def test_legacy_kanban_rows_migrate_once(self):
        self.assertTrue(db_manager.add_kanban_task("legacy-one", "Legacy brief", "2026-08-20T10:00:00Z"))
        self.assertEqual(goal_store.migrate_legacy_kanban(), 1)
        self.assertEqual(goal_store.migrate_legacy_kanban(), 0)
        items = goal_store.list_work_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["source_type"], "legacy_kanban")

    async def test_single_task_runs_through_goal_orchestrator(self):
        goal = goal_store.create_single_task(prompt="Summarize the opportunity", auto_start=True)
        original_executor = goal_orchestrator._execute_capability

        async def fake_executor(current_goal, task):
            await asyncio.sleep(0)
            return {"summary": "Unified result", "agent": "Manager", "capability": "single_task", "evidence": []}

        goal_orchestrator._execute_capability = fake_executor
        try:
            await goal_orchestrator.run_goal(goal["id"])
        finally:
            goal_orchestrator._execute_capability = original_executor
        completed = goal_store.get_goal(goal["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["result_md"], "Unified result")
        self.assertEqual(goal_store.get_work_item(goal["id"])["status"], "done")

    def test_chat_router_distinguishes_questions_from_work(self):
        self.assertTrue(_should_queue_chat_task("Please prepare an assessment of Project Aino"))
        self.assertTrue(_should_queue_chat_task("Research current EU forestry funding"))
        self.assertFalse(_should_queue_chat_task("What is Project Aino?"))
        self.assertFalse(_should_queue_chat_task("Explain the current funding context"))


if __name__ == "__main__":
    unittest.main()
