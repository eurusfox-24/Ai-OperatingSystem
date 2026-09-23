import asyncio
import logging
from typing import Dict, Any
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus

logger = logging.getLogger("idea_scorer_agent")

DEFAULT_IDEA_SCORER_PROMPT = """You are the Chief Investment Officer & Regional Impact Evaluator sub-agent for The Company.

YOUR PERSONA & TONE:
- Tone: Objective, quantitative, rigorous, critical, and evidence-based.
- Perspective: You grade project proposals on numerical metrics, job creation yield per euro invested, resource feasibility, and net-zero 2030 roadmap alignment.

EXECUTION DIRECTIVE:
Provide a structured evaluation scorecard containing:
1. Job Creation Score (1-10) & Estimated New Jobs
2. Susicorn Potential Score (1-10) (Startup growth & private investment scaling factor)
3. Feasibility & Resource Fit (1-10)
4. Strategic Alignment with Regional Bioeconomy Plan (1-10)
5. Executive Recommendation & Key Risks"""

class IdeaScorerAgent(BaseAgent):
    """Sub-agent for evaluating and prioritizing strategic project options based on regional impact."""

    def __init__(self):
        super().__init__(
            name="Impact Evaluator",
            agent_type="IdeaScorerAgent",
            role_label="Strategic Project Feasibility & Scorecard",
            color="#9C27B0", # Purple
            default_prompt=DEFAULT_IDEA_SCORER_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.4,
            max_tokens=900
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        project_title = task.context.get("project_title", "Proposed Regional Project")
        description = task.prompt

        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Calculating ROI & job potential for {project_title[:20]}")

        prompt = f"""Evaluate the following project proposal:
Title: {project_title}
Description: {description}

Provide a structured evaluation scorecard following your execution directive."""

        res = await asyncio.to_thread(
            llm_provider.chat_completion,
            messages=[
                {"role": "system", "content": self.get_system_prompt(user_id=task.username, project_id=task.context.get("project_id", ""))},
                {"role": "user", "content": prompt}
            ],
            provider=self.provider,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )

        scorecard = res.get("content", "")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=scorecard,
            data={
                "project_title": project_title,
                "scorecard": scorecard,
                "usage": res.get("usage", {}),
                "cost_usd": llm_provider.estimate_cost(self.model, res.get("usage", {})),
            }
        )

    async def score_project(self, project_title: str, description: str) -> Dict[str, Any]:
        task = AgentTask(
            task_type="score_project",
            prompt=description,
            context={"project_title": project_title}
        )
        res = await self.execute(task)
        return {
            "agent_id": res.agent_id,
            "project_title": project_title,
            "scorecard": res.summary
        }

idea_scorer_agent = IdeaScorerAgent()
agent_registry.register(idea_scorer_agent)
