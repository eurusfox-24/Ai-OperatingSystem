"""Restart-safe orchestration loop for bounded, multi-agent goals."""

import asyncio
import datetime
import logging
from contextlib import closing
from typing import Any, Dict, List, Optional

from kernel.agentic.policy import agentic_policy
from kernel.agentic.store import goal_store
from kernel.core.event_bus import event_bus
from kernel.core.framework import AgentTask, agent_registry
from kernel.db.local_manager import db_manager

logger = logging.getLogger("goal_orchestrator")


class GoalOrchestrator:
    """Plans and executes one goal at safe, inspectable task boundaries."""

    def __init__(self) -> None:
        self._running: Dict[str, asyncio.Task] = {}
        self._scheduler_task: Optional[asyncio.Task] = None
        self._stopping = False

    def launch(self, goal_id: str) -> bool:
        current = self._running.get(goal_id)
        if current and not current.done():
            return False
        task = asyncio.create_task(self.run_goal(goal_id), name=f"agentic-goal:{goal_id}")
        self._running[goal_id] = task
        task.add_done_callback(lambda _task, item=goal_id: self._running.pop(item, None))
        return True

    def start_scheduler(self) -> None:
        if self._scheduler_task and not self._scheduler_task.done():
            return
        self._stopping = False
        recovered = goal_store.recover_interrupted()
        if recovered:
            logger.info("Recovered %s interrupted agentic goals", len(recovered))
        self._scheduler_task = asyncio.create_task(self._scheduler(), name="agentic-goal-scheduler")

    async def stop_scheduler(self) -> None:
        self._stopping = True
        if self._scheduler_task:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass
            self._scheduler_task = None
        running = [task for task in self._running.values() if not task.done()]
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        self._running.clear()

    async def _scheduler(self) -> None:
        while not self._stopping:
            try:
                now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                for goal_id in goal_store.due_work_goal_ids(now_iso):
                    if goal_store.start_goal(goal_id):
                        await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": goal_id, "status": "running"})
                for goal in goal_store.list_goals(limit=200):
                    if goal.get("status") == "queued":
                        self.launch(str(goal["id"]))
            except Exception:
                logger.exception("Agentic goal scheduler tick failed")
            await asyncio.sleep(2.0)

    @staticmethod
    def build_plan(goal: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Create a conservative project-assessment plan from the goal scope."""
        objective = str(goal.get("objective") or "")
        criteria = str(goal.get("success_criteria_md") or "")
        tasks: List[Dict[str, Any]] = [
            {
                "key": "evidence",
                "title": "Gather scoped evidence",
                "instructions": (
                    "Research the goal using only selected project sources and permitted public-web evidence. "
                    "Produce a cited evidence brief, identify missing information, and state uncertainty."
                ),
                "agent_type": "ManagerAgent",
                "capability": "evidence_research",
                "risk_level": "read",
                "input": {"objective": objective, "success_criteria": criteria},
            },
            {
                "key": "finance",
                "title": "Assess financial implications",
                "instructions": "Assess ROI, funding assumptions, capital efficiency, downside risk, and missing financial inputs.",
                "agent_type": "FinancialAdvisorAgent",
                "capability": "financial_analysis",
                "risk_level": "read",
                "depends_on": ["evidence"],
            },
            {
                "key": "feasibility",
                "title": "Score feasibility and regional impact",
                "instructions": "Evaluate feasibility, strategic fit, regional impact, execution constraints, and principal risks.",
                "agent_type": "IdeaScorerAgent",
                "capability": "feasibility_scoring",
                "risk_level": "read",
                "depends_on": ["evidence"],
            },
        ]
        analysis_dependencies = ["evidence", "finance", "feasibility"]
        if goal.get("web_access"):
            tasks.append(
                {
                    "key": "foresight",
                    "title": "Assess market and future context",
                    "instructions": "Assess current market signals, emerging opportunities, external threats, and timing considerations.",
                    "agent_type": "ForesightAgent",
                    "capability": "foresight",
                    "risk_level": "read",
                    "depends_on": ["evidence"],
                }
            )
            analysis_dependencies.append("foresight")
        lowered = objective.lower()
        if any(word in lowered for word in ("startup", "venture", "scaleup", "susicorn", "vc ", "capital")):
            tasks.append(
                {
                    "key": "venture",
                    "title": "Assess venture scaling pathway",
                    "instructions": "Evaluate the growth pathway, investment readiness, partnerships, and scaling milestones.",
                    "agent_type": "SusicornAgent",
                    "capability": "venture_analysis",
                    "risk_level": "read",
                    "depends_on": ["evidence"],
                }
            )
            analysis_dependencies.append("venture")
        if any(word in lowered for word in ("meeting", "transcript", "minutes")):
            tasks.append(
                {
                    "key": "meeting",
                    "title": "Extract meeting decisions and commitments",
                    "instructions": "Extract decisions, owners, commitments, open questions, and follow-up actions from the evidence.",
                    "agent_type": "MeetingNotesAgent",
                    "capability": "meeting_analysis",
                    "risk_level": "read",
                    "depends_on": ["evidence"],
                }
            )
            analysis_dependencies.append("meeting")
        tasks.append(
            {
                "key": "synthesis",
                "title": "Produce the decision brief",
                "instructions": (
                    "Synthesize the specialist outputs into a decision-ready board brief. Distinguish evidence from assumptions, "
                    "describe disagreements, and recommend next actions. "
                    "Do not claim that any external action was performed."
                ),
                "agent_type": "ManagerAgent",
                "capability": "synthesis",
                "risk_level": "internal_write",
                "depends_on": analysis_dependencies,
            }
        )
        tasks.append(
            {
                "key": "verification",
                "title": "Verify the brief against the goal",
                "instructions": (
                    "Act as the final quality gate. Check the draft against every success criterion and the supplied evidence. "
                    "Remove or qualify unsupported claims, retain source citations, identify unresolved gaps, and return the "
                    "corrected final board brief. Do not perform or imply any external action."
                ),
                "agent_type": "ManagerAgent",
                "capability": "verification",
                "risk_level": "internal_write",
                "depends_on": ["synthesis"],
            }
        )
        return tasks

    async def run_goal(self, goal_id: str) -> None:
        if not goal_store.claim_goal(goal_id):
            return
        await event_bus.notify_workflow_update(goal_id, "running", "Goal orchestration started")
        try:
            goal = goal_store.get_goal(goal_id)
            if not goal:
                return
            if int(goal.get("plan_version") or 0) == 0:
                plan = self.build_plan(goal)
                if len(plan) > int(goal.get("max_steps") or 12):
                    raise RuntimeError("The proposed plan exceeds the configured step budget")
                goal_store.create_plan(goal_id, plan)
                await event_bus.notify_workflow_update(goal_id, "running", f"Created a {len(plan)}-step execution plan")

            while True:
                goal = goal_store.get_goal(goal_id)
                if not goal:
                    return
                if goal.get("cancel_requested"):
                    goal_store.set_goal_status(goal_id, "cancelled", error="Cancelled by the user at a safe task boundary")
                    await event_bus.notify_workflow_update(goal_id, "cancelled", "Goal cancelled by the user")
                    return
                if goal.get("pause_requested"):
                    goal_store.set_goal_status(goal_id, "paused")
                    await event_bus.notify_workflow_update(goal_id, "paused", "Goal paused by the user")
                    return
                if self._runtime_exceeded(goal):
                    raise RuntimeError("Goal exceeded its runtime budget")

                counts = goal_store.task_counts(goal_id)
                completed = counts.get("completed", 0)
                budget = agentic_policy.validate_budget(goal, completed)
                if not budget.allowed and counts.get("pending", 0) + counts.get("queued", 0) > 0:
                    raise RuntimeError(budget.reason)

                ready = goal_store.ready_tasks(goal_id)
                if ready:
                    remaining_seconds = self._runtime_remaining_seconds(goal)
                    if remaining_seconds <= 0:
                        raise RuntimeError("Goal exceeded its runtime budget")
                    await asyncio.wait_for(
                        asyncio.gather(*(self._run_task(goal, task) for task in ready)),
                        timeout=remaining_seconds,
                    )
                    continue

                counts = goal_store.task_counts(goal_id)
                total = sum(counts.values())
                if total and counts.get("completed", 0) == total:
                    refreshed = goal_store.get_goal(goal_id) or goal
                    synthesis = next(
                        (task for task in reversed(refreshed.get("tasks", [])) if task.get("capability") in {"verification", "synthesis"}),
                        None,
                    )
                    if not synthesis:
                        synthesis = next((task for task in reversed(refreshed.get("tasks", [])) if task.get("status") == "completed"), None)
                    result = str(((synthesis or {}).get("output") or {}).get("summary") or "Goal completed")
                    goal_store.set_goal_status(goal_id, "completed", result_md=result)
                    await event_bus.notify_workflow_update(goal_id, "completed", "Goal completed", "Decision brief ready")
                    if refreshed.get("work_type") == "single_task":
                        chat_session_id = str(refreshed.get("chat_session_id") or "")
                        if chat_session_id:
                            db_manager.append_chat_message(
                                chat_session_id,
                                str(refreshed.get("username") or "alex"),
                                str(refreshed.get("project_id") or ""),
                                "assistant",
                                result,
                                {"kind": "agent_work_result", "goal_id": goal_id},
                            )
                        await event_bus.broadcast(
                            "KANBAN_TASK_UPDATED",
                            {"task_id": goal_id, "goal_id": goal_id, "status": "done", "chat_session_id": chat_session_id, "summary": result[:500]},
                        )
                    return
                if counts.get("waiting_approval", 0):
                    goal_store.set_goal_status(goal_id, "waiting_approval")
                    await event_bus.notify_workflow_update(goal_id, "waiting_approval", "Human approval is required")
                    return
                if counts.get("failed", 0) or counts.get("skipped", 0):
                    raise RuntimeError("The plan could not complete because a task or dependency failed")
                raise RuntimeError("The plan has no executable tasks; inspect its dependencies")
        except asyncio.TimeoutError:
            logger.error("Goal %s exceeded its runtime budget", goal_id)
            goal_store.set_goal_status(goal_id, "failed", error="Goal exceeded its runtime budget")
            await event_bus.notify_workflow_update(goal_id, "failed", "Goal stopped", "Runtime budget exceeded")
        except asyncio.CancelledError:
            logger.info("Goal %s interrupted during kernel shutdown", goal_id)
            raise
        except Exception as exc:
            logger.exception("Goal %s failed", goal_id)
            goal_store.set_goal_status(goal_id, "failed", error=str(exc))
            await event_bus.notify_workflow_update(goal_id, "failed", "Goal stopped", str(exc)[:500])

    async def _run_task(self, goal: Dict[str, Any], task: Dict[str, Any]) -> None:
        decision = agentic_policy.evaluate(goal, task)
        approved_proposal = None
        if task.get("approval_id"):
            approved_proposal = goal_store.get_proposal(int(task["approval_id"]))
        if approved_proposal and approved_proposal.get("status") == "approved":
            decision = type(decision)(True, False, "Consequential action explicitly approved by the user")
        if decision.approval_required:
            proposal = goal_store.propose_action(
                str(goal["id"]), str(task["id"]), str(task.get("capability") or "action"),
                str(task.get("instructions") or task.get("title") or "Consequential action"), task.get("input") or {},
            )
            with closing(db_manager._get_connection()) as conn, conn:
                conn.execute(
                    "UPDATE agentic_tasks SET status = 'waiting_approval', approval_id = ? WHERE id = ?",
                    (proposal.get("id"), task["id"]),
                )
            return
        if not decision.allowed:
            goal_store.fail_task(str(task["id"]), decision.reason)
            return
        if not goal_store.claim_task(str(task["id"])):
            return
        await event_bus.notify_workflow_update(str(goal["id"]), "running", str(task["title"]), decision.reason)
        try:
            output = await self._execute_capability(goal, task)
            if not str(output.get("summary") or "").strip():
                raise RuntimeError("Agent returned an empty result")
            goal_store.finish_task(str(task["id"]), output)
            goal_store.add_goal_cost(str(goal["id"]), float(output.get("cost_usd") or 0.0))
            if task.get("capability") == "verification":
                goal_store.add_artifact(
                    str(goal["id"]), str(task["id"]), "decision_brief", str(task["title"]),
                    str(output["summary"]), output.get("evidence") or [],
                )
        except asyncio.CancelledError:
            goal_store.fail_task(str(task["id"]), "Task interrupted at a cancellation or runtime boundary")
            raise
        except Exception as exc:
            state = goal_store.fail_task(str(task["id"]), str(exc))
            await event_bus.notify_workflow_update(
                str(goal["id"]), state, f"{task['title']} {'will retry' if state == 'queued' else 'failed'}", str(exc)[:500]
            )

    async def _execute_capability(self, goal: Dict[str, Any], task: Dict[str, Any]) -> Dict[str, Any]:
        from kernel.agents.manager import manager_agent

        prior = self._prior_outputs(goal, task)
        steering = str(goal.get("steering_md") or "").strip()
        prompt = (
            f"GOAL: {goal['objective']}\n\nSUCCESS CRITERIA:\n{goal.get('success_criteria_md') or 'Produce a useful, evidence-grounded decision brief.'}"
            f"\n\nYOUR ASSIGNED TASK:\n{task['instructions']}"
        )
        if prior:
            prompt += f"\n\nCOMPLETED PREDECESSOR OUTPUTS:\n{prior}"
        if steering:
            prompt += f"\n\nUSER STEERING:\n{steering}"

        context = {
            "project_id": str(goal.get("project_id") or ""),
            "notebook_ids": goal.get("notebook_ids") or [],
            "allowed_source_names": goal.get("source_doc_names") or [],
            "research_mode": "rag_internet" if goal.get("web_access") and task.get("capability") == "evidence_research" else "rag",
            "business_context": db_manager.compile_business_context(goal.get("notebook_ids") or []),
            "project_title": str(goal.get("title") or "Autonomous project assessment"),
        }
        agent = manager_agent if task.get("agent_type") == "ManagerAgent" else agent_registry.get_agent(str(task.get("agent_type") or ""))
        if not agent:
            raise RuntimeError(f"Agent is not registered: {task.get('agent_type')}")
        result = await agent.execute(
            AgentTask(
                task_type=str(task.get("capability") or "analysis"),
                prompt=prompt,
                context=context,
                username=str(goal.get("username") or "alex"),
            )
        )
        if result.status != "success":
            raise RuntimeError(result.summary or f"{result.agent_name} failed")
        response_text = str(result.data.get("response") or result.summary or "") if isinstance(result.data, dict) else str(result.summary or "")
        return {
            "summary": response_text,
            "agent": result.agent_name,
            "capability": task.get("capability"),
            "evidence": self._extract_evidence(result.summary),
            "cost_usd": float(result.data.get("cost_usd") or 0.0) if isinstance(result.data, dict) else 0.0,
        }

    @staticmethod
    def _prior_outputs(goal: Dict[str, Any], task: Dict[str, Any]) -> str:
        dependencies = set(task.get("depends_on") or [])
        blocks: List[str] = []
        for prior in goal.get("tasks", []):
            if prior.get("id") not in dependencies:
                continue
            summary = str((prior.get("output") or {}).get("summary") or "").strip()
            if summary:
                blocks.append(f"### {prior.get('title')}\n{summary[:10000]}")
        return "\n\n".join(blocks)[:30000]

    @staticmethod
    def _extract_evidence(text: str) -> List[str]:
        import re
        citations = re.findall(r"\[(?:Source|Web):[^\]]+\]", text or "")
        return list(dict.fromkeys(citations))[:100]

    @staticmethod
    def _runtime_exceeded(goal: Dict[str, Any]) -> bool:
        started = str(goal.get("started_at") or "")
        if not started:
            return False
        try:
            start_time = datetime.datetime.fromisoformat(started.replace("Z", "+00:00"))
            if start_time.tzinfo is None:
                start_time = start_time.replace(tzinfo=datetime.timezone.utc)
            elapsed = datetime.datetime.now(datetime.timezone.utc) - start_time
            return elapsed.total_seconds() > max(1, int(goal.get("max_runtime_minutes") or 30)) * 60
        except ValueError:
            return False

    @staticmethod
    def _runtime_remaining_seconds(goal: Dict[str, Any]) -> float:
        started = str(goal.get("started_at") or "")
        maximum = max(1, int(goal.get("max_runtime_minutes") or 30)) * 60.0
        if not started:
            return maximum
        try:
            start_time = datetime.datetime.fromisoformat(started.replace("Z", "+00:00"))
            if start_time.tzinfo is None:
                start_time = start_time.replace(tzinfo=datetime.timezone.utc)
            elapsed = (datetime.datetime.now(datetime.timezone.utc) - start_time).total_seconds()
            return max(0.0, maximum - elapsed)
        except ValueError:
            return maximum


goal_orchestrator = GoalOrchestrator()
