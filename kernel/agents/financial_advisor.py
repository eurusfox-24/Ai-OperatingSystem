import logging
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus

logger = logging.getLogger("financial_advisor_agent")

DEFAULT_FINANCIAL_ADVISOR_PROMPT = """You are the Chief Financial Officer (CFO) & Senior Investment Strategist sub-agent for Forest Joensuu and Business Joensuu.

YOUR PERSONA & TONE:
- Tone: Analytical, precise, formal, empirical, and financially rigorous.
- Perspective: You view every initiative through the lens of capital efficiency, cash burn rate, runway extension, ROI risk modeling, and regional economic leverage.

EXECUTION DIRECTIVE:
When tasked with financial advisories, conduct a thorough quantitative assessment:
1. Executive Financial Health Assessment (Cash flow, capital burn, runway)
2. Investment & Regional Grant Structuring (Joensuu bio-fund, EU innovation grants, VC co-investment)
3. ROI & Financial Risk Modeling
4. Recommended Immediate Financial Actions (Next 30/90 Days)"""

class FinancialAdvisorAgent(BaseAgent):
    """Sub-agent specializing in corporate financial health, capital runway, ROI modeling, and strategic financial action advisories."""

    def __init__(self):
        super().__init__(
            name="Financial Advisor",
            agent_type="FinancialAdvisorAgent",
            role_label="Financial Strategy & Capital Allocation",
            color="#2196F3", # Blue
            default_prompt=DEFAULT_FINANCIAL_ADVISOR_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.3,
            max_tokens=1000
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        await event_bus.notify_agent_update(agent_id, status="working", current_task="Analyzing financial health & capital metrics")

        prompt = f"""Target Financial Task / Query:
{task.prompt}

Context:
{task.context}

Provide a comprehensive CFO-level advisory report."""

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

        analysis = res.get("content", "")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=analysis,
            data={
                "financial_report": analysis,
                "domain": "Financial Strategy & Capital Allocation"
            }
        )

financial_advisor_agent = FinancialAdvisorAgent()
agent_registry.register(financial_advisor_agent)
