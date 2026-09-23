import asyncio
from contextlib import closing
import os
import tempfile
import unittest

from kernel.agentic.orchestrator import goal_orchestrator
from kernel.agentic.policy import agentic_policy
from kernel.agentic.store import goal_store
from kernel.db.local_manager import db_manager


class AgenticMVPTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db_manager.db_path
        db_manager.db_path = os.path.join(self.tempdir.name, "agentic-test.db")
        db_manager._init_database()

    def tearDown(self):
        db_manager.db_path = self.original_db_path
        self.tempdir.cleanup()

    def create_goal(self, **overrides):
        values = {
            "title": "Test assessment",
            "objective": "Assess a regional investment opportunity",
            "success_criteria_md": "Return an evidence-grounded decision brief",
            "username": "tester",
            "project_id": "projects:alpha",
            "notebook_ids": ["alpha"],
            "source_doc_names": ["alpha.md"],
            "web_access": False,
            "max_steps": 12,
            "max_retries": 1,
            "max_runtime_minutes": 30,
            "max_cost_usd": 5.0,
            "auto_start": True,
        }
        values.update(overrides)
        return goal_store.create_goal(**values)

    def test_plan_dependencies_only_release_ready_tasks(self):
        goal = self.create_goal(auto_start=False)
        goal_store.create_plan(
            goal["id"],
            [
                {"key": "research", "title": "Research", "instructions": "Research", "capability": "analysis"},
                {"key": "brief", "title": "Brief", "instructions": "Brief", "capability": "synthesis", "depends_on": ["research"]},
            ],
        )
        ready = goal_store.ready_tasks(goal["id"])
        self.assertEqual([item["title"] for item in ready], ["Research"])
        self.assertTrue(goal_store.claim_task(ready[0]["id"]))
        goal_store.finish_task(ready[0]["id"], {"summary": "Evidence"})
        self.assertEqual([item["title"] for item in goal_store.ready_tasks(goal["id"])], ["Brief"])

    def test_policy_blocks_web_and_gates_consequential_actions(self):
        goal = self.create_goal(web_access=False)
        denied = agentic_policy.evaluate(goal, {"capability": "foresight", "risk_level": "read"})
        self.assertFalse(denied.allowed)
        consequential = agentic_policy.evaluate(goal, {"capability": "send_email", "risk_level": "consequential"})
        self.assertTrue(consequential.approval_required)
        self.assertFalse(consequential.allowed)

    async def test_approved_action_is_requeued_and_resumes_exactly_once(self):
        goal = self.create_goal(auto_start=False)
        goal_store.create_plan(goal["id"], [{
            "key": "send",
            "title": "Send board brief",
            "instructions": "Send the board brief",
            "capability": "send_email",
            "risk_level": "consequential",
        }])
        task = goal_store.get_goal(goal["id"])["tasks"][0]
        proposal = goal_store.propose_action(goal["id"], task["id"], "send_email", "Send the board brief", {"to": "board"})
        with closing(db_manager._get_connection()) as conn, conn:
            conn.execute("UPDATE agentic_tasks SET status = 'waiting_approval', approval_id = ? WHERE id = ?", (proposal["id"], task["id"]))
            conn.execute("UPDATE agentic_goals SET status = 'waiting_approval' WHERE id = ?", (goal["id"],))
        decided = goal_store.decide_proposal(proposal["id"], "approved", "reviewer")
        self.assertEqual(decided["status"], "approved")
        self.assertIsNone(decided["executed_at"])
        queued = goal_store.get_goal(goal["id"])
        self.assertEqual(queued["status"], "queued")
        self.assertEqual(queued["tasks"][0]["status"], "queued")

        calls = 0
        original_executor = goal_orchestrator._execute_capability

        async def fake_executor(current_goal, current_task):
            nonlocal calls
            calls += 1
            return {"summary": "Approved action completed", "cost_usd": 0.1}

        goal_orchestrator._execute_capability = fake_executor
        try:
            await goal_orchestrator.run_goal(goal["id"])
        finally:
            goal_orchestrator._execute_capability = original_executor
        self.assertEqual(calls, 1)
        self.assertEqual(goal_store.get_goal(goal["id"])["status"], "completed")
        events = goal_store.get_goal(goal["id"])["events"]
        self.assertIn("approval_approved", [event["event_type"] for event in events])

    def test_interrupted_goal_and_task_are_requeued(self):
        goal = self.create_goal(auto_start=False)
        goal_store.create_plan(goal["id"], [{"key": "one", "title": "One", "instructions": "One"}])
        ready = goal_store.ready_tasks(goal["id"])[0]
        self.assertTrue(goal_store.claim_task(ready["id"]))
        recovered = goal_store.recover_interrupted()
        self.assertIn(goal["id"], recovered)
        refreshed = goal_store.get_goal(goal["id"])
        self.assertEqual(refreshed["status"], "queued")
        self.assertEqual(refreshed["tasks"][0]["status"], "queued")

    async def test_orchestrator_completes_goal_with_artifact_using_bounded_executor(self):
        goal = self.create_goal()
        original_executor = goal_orchestrator._execute_capability

        async def fake_executor(current_goal, task):
            await asyncio.sleep(0)
            return {
                "summary": f"Completed {task['title']} [Source: alpha.md]",
                "agent": task["agent_type"],
                "capability": task["capability"],
                "evidence": ["[Source: alpha.md]"],
            }

        goal_orchestrator._execute_capability = fake_executor
        try:
            await goal_orchestrator.run_goal(goal["id"])
        finally:
            goal_orchestrator._execute_capability = original_executor

        completed = goal_store.get_goal(goal["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["artifacts"])
        self.assertTrue(all(task["status"] == "completed" for task in completed["tasks"]))

    async def test_independent_tasks_run_concurrently_and_record_cost(self):
        goal = self.create_goal()
        original_executor = goal_orchestrator._execute_capability
        original_builder = goal_orchestrator.build_plan
        active = 0
        max_active = 0

        def fake_plan(_goal):
            return [
                {"key": "one", "title": "One", "instructions": "One", "capability": "analysis"},
                {"key": "two", "title": "Two", "instructions": "Two", "capability": "analysis"},
            ]

        async def fake_executor(current_goal, task):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.05)
            active -= 1
            return {"summary": task["title"], "cost_usd": 0.25}

        goal_orchestrator.build_plan = fake_plan
        goal_orchestrator._execute_capability = fake_executor
        try:
            await goal_orchestrator.run_goal(goal["id"])
        finally:
            goal_orchestrator.build_plan = original_builder
            goal_orchestrator._execute_capability = original_executor
        completed = goal_store.get_goal(goal["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(max_active, 2)
        self.assertAlmostEqual(completed["spent_cost_usd"], 0.5)


if __name__ == "__main__":
    unittest.main()
