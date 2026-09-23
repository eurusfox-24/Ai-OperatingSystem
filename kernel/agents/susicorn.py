import asyncio
import logging
from typing import Dict, Any
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus

logger = logging.getLogger("susicorn_agent")

DEFAULT_SUSICORN_PROMPT = """You are the Head of Venture Capital & Susicorn Startup Acceleration sub-agent for The Company.

YOUR PERSONA & TONE:
- Tone: Dynamic, ambitious, venture-oriented, entrepreneurial, and growth-focused.
- Perspective: You specialize in scaling sustainable green startups ("Susicorns"), attracting international venture capital dealflow, and driving high-tech private sector job creation.

EXECUTION DIRECTIVE:
Formulate startup growth pathways and provide:
1. Pathway to scaling high-growth startups ("Susicorns")
2. Private-Sector Job Creation Potential (Short-term & 3-year horizon)
3. Inward Investment & Venture Capital Matchmaking Opportunities
4. Strategic Subsidies & European Union Innovation Grant Pipelines"""

class SusicornAgent(BaseAgent):
    """Sub-agent for scaling local startups ('Susicorns'), attracting private venture capital, and tracking job creation."""

    def __init__(self):
        super().__init__(
            name="Susicorn Accelerator",
            agent_type="SusicornAgent",
            role_label="Susicorn Venture Scaling & VC Capital Match",
            color="#E91E63", # Pink/Magenta
            default_prompt=DEFAULT_SUSICORN_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.5,
            max_tokens=950
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        company_or_sector = task.prompt

        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Analyzing VC & job potential for {company_or_sector[:25]}")

        prompt = f"""Analyze growth pathways for startups/ventures in sector: '{company_or_sector}'.
Provide strategic startup acceleration guidance according to your execution directive."""

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

        pathway_report = res.get("content", "")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=pathway_report,
            data={
                "sector": company_or_sector,
                "pathway_report": pathway_report,
                "usage": res.get("usage", {}),
                "cost_usd": llm_provider.estimate_cost(self.model, res.get("usage", {})),
            }
        )

    async def analyze_startup_pathway(self, company_or_sector: str) -> Dict[str, Any]:
        task = AgentTask(task_type="startup_pathway", prompt=company_or_sector)
        res = await self.execute(task)
        return {
            "agent_id": res.agent_id,
            "sector": company_or_sector,
            "pathway_report": res.summary
        }

susicorn_agent = SusicornAgent()
agent_registry.register(susicorn_agent)
