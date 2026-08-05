import logging
from typing import Dict, Any
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus
from kernel.tools.web_scraper import web_scraper

logger = logging.getLogger("foresight_agent")

DEFAULT_FORESIGHT_PROMPT = """You are the Chief Intelligence Officer & Global Bioeconomy Market Analyst sub-agent for Forest Joensuu and Business Joensuu.

YOUR PERSONA & TONE:
- Tone: Strategic, forward-looking, sharp, perceptive, and data-driven.
- Perspective: You analyze macro market shifts, forestry innovations, carbon neutrality regulations, and global trade dynamics to protect and expand Joensuu's regional economic lead.

EXECUTION DIRECTIVE:
Analyze live market search intelligence and provide:
1. Top 3 Global Bioeconomy / Forestry Market Trends
2. Strategic Opportunities for Joensuu & North Karelia Region
3. Recommended Immediate Action for Forest Joensuu Board"""

class ForesightAgent(BaseAgent):
    """Sub-agent for global market trend tracking, bioeconomy radar, and live internet foresight research."""

    def __init__(self):
        super().__init__(
            name="Foresight Radar",
            agent_type="ForesightAgent",
            role_label="Global Market Trends & Live Web Radar",
            color="#4CAF50", # Green
            default_prompt=DEFAULT_FORESIGHT_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.5,
            max_tokens=900
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        topic = task.prompt
        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Fetching live web intelligence for {topic[:25]}")

        try:
            live_web_results = web_scraper.live_search_web(topic)
        except Exception as e:
            logger.warning(f"Live web search failed for topic '{topic}': {e}")
            live_web_results = f"Live web search unavailable ({str(e)}). Proceeding with offline bioeconomy foresight model."
        
        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Synthesizing market insights for {topic[:25]}")

        prompt = f"""Analyze the following LIVE web search intelligence and market shifts for topic: '{topic}'

Live Web Search Data:
{live_web_results}

Synthesize a strategic market foresight report."""

        res = llm_provider.chat_completion(
            messages=[
                {"role": "system", "content": self.get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            provider=self.provider,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )
        
        summary = res.get("content", "")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=summary,
            data={
                "topic": topic,
                "insights": summary,
                "live_web_sources": live_web_results
            }
        )

    async def run_foresight_scan(self, topic: str) -> Dict[str, Any]:
        task = AgentTask(task_type="foresight_scan", prompt=topic)
        res = await self.execute(task)
        return {
            "agent_id": res.agent_id,
            "topic": topic,
            "insights": res.summary,
            "live_web_sources": res.data.get("live_web_sources", "")
        }

foresight_agent = ForesightAgent()
agent_registry.register(foresight_agent)
