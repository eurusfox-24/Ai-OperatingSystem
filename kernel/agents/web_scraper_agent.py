import asyncio
import logging
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus
from kernel.tools.web_scraper import web_scraper

logger = logging.getLogger("web_scraper_agent")

DEFAULT_WEB_SCRAPER_PROMPT = """You are the Web Scraper Sub-Agent for AI OS.

YOUR RESPONSIBILITY:
- You execute web scraping, page extraction, and stealth browsing tasks assigned ONLY by the Manager Agent.
- You process raw HTML/text extracted from target URLs or live web queries and synthesize clean, structured, readable intelligence.

OUTPUT FORMAT:
1. Executive Summary of Web Intelligence
2. Key Web Extracted Facts & Findings
3. Source Links & Citations
"""

class WebScraperAgent(BaseAgent):
    """Dedicated sub-agent for stealth web scraping and site content extraction using Scrapling engine."""

    def __init__(self):
        super().__init__(
            name="Web Scraper Agent",
            agent_type="WebScraperAgent",
            role_label="Stealth Web Scraper & Intelligence Extractor",
            color="#ec4899", # Pink
            default_prompt=DEFAULT_WEB_SCRAPER_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.3,
            max_tokens=1000
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        url_or_query = task.prompt
        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Scraping web target: {url_or_query[:30]}")

        # Check if prompt contains a URL or query
        if "http://" in url_or_query or "https://" in url_or_query:
            extracted_data = await asyncio.to_thread(web_scraper.fetch_url_content, url_or_query)
        else:
            extracted_data = await asyncio.to_thread(web_scraper.live_search_web, url_or_query)

        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Synthesizing scraped content for {url_or_query[:30]}")

        prompt = f"""Process and synthesize the following extracted web content for request: '{url_or_query}'

Extracted Web Content:
{extracted_data}
"""

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

        output_summary = res.get("content", "")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=output_summary,
            data={
                "raw_extracted": extracted_data[:1000],
                "usage": res.get("usage", {}),
                "cost_usd": llm_provider.estimate_cost(self.model, res.get("usage", {})),
            }
        )

web_scraper_agent = WebScraperAgent()
agent_registry.register(web_scraper_agent)
