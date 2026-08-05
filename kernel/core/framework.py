import asyncio
import uuid
import logging
import re
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
from kernel.core.event_bus import event_bus
from kernel.db.local_manager import db_manager
from kernel.core.llm_provider import (
    AZURE_PROVIDER,
    DEFAULT_AZURE_DEPLOYMENT,
    is_supported_azure_deployment,
)

logger = logging.getLogger("agent_framework")

class AgentTask(BaseModel):
    task_id: str = Field(default_factory=lambda: f"task_{uuid.uuid4().hex[:6]}")
    task_type: str
    prompt: str
    context: Dict[str, Any] = Field(default_factory=dict)
    username: str = "mikko"

class AgentResult(BaseModel):
    task_id: str
    agent_id: str
    agent_name: str
    status: str  # "success" or "error"
    summary: str
    data: Dict[str, Any] = Field(default_factory=dict)

class BaseAgent:
    """Base class for all autonomous AI OS sub-agents providing standard telemetry,
    prompt customization via local SQLite (soul_md + rules_md layered architecture),
    model provider configuration, and lifecycle management."""

    def __init__(
        self,
        name: str,
        agent_type: str,
        role_label: str,
        color: str = "#4CAF50",
        default_prompt: str = "",
        provider: str = "azure",
        model: str = "mvp-gpt-54-mini",
        temperature: float = 0.7,
        max_tokens: int = 1500
    ):
        self.name = name
        self.agent_type = agent_type
        self.role_label = role_label
        self.color = color
        self.default_prompt = default_prompt or f"You are {name} [{agent_type}]. Specialization: {role_label}."
        self.custom_system_prompt: Optional[str] = None
        self.provider: str = provider
        self.model: str = model
        self.temperature: float = temperature
        self.max_tokens: int = max_tokens

        # Load persisted profile from local SQLite on startup
        self._load_profile_from_db()
        # Agents use only this Azure resource, with a validated deployment
        # selected per agent. Invalid legacy selections fall back safely.
        self.provider = AZURE_PROVIDER
        if not is_supported_azure_deployment(self.model):
            self.model = DEFAULT_AZURE_DEPLOYMENT

    def _load_profile_from_db(self):
        """Loads agent profile (soul_md, rules_md, provider, model) from local SQLite on init."""
        profile = db_manager.get_agent_profile(self.agent_type)
        if profile:
            if profile.get("soul_md"):
                self.custom_system_prompt = profile["soul_md"]
            if profile.get("provider"):
                self.provider = profile["provider"]
            if profile.get("model"):
                self.model = profile["model"]
            if profile.get("temperature") is not None:
                self.temperature = profile["temperature"]
            if profile.get("max_tokens") is not None:
                self.max_tokens = profile["max_tokens"]
            logger.info(f"Loaded persisted profile for {self.name} [{self.agent_type}] from local SQLite.")

    def get_system_prompt(self, user_id: str = "mikko", current_query: str = "", project_id: str = "") -> str:
        """Returns the compiled 4-tier ChatML system prompt from SQLite."""
        return self.compile_system_prompt(user_id=user_id, current_query=current_query, project_id=project_id)

    def compile_system_prompt(self, user_id: str = "mikko", current_query: str = "", project_id: str = "") -> str:
        """Compiles a 4-tier Hermes-style ChatML system prompt from SQLite database.

        Tiers:
        1. [AGENT CONSTITUTION & PERSONA]: soul_md + rules_md from agent_profiles
        2. [USER PROFILE & CONTEXT]: profile_md, tone_style, custom_instructions from user_profiles
        3. [WORKSPACE MEMORY]: memory_md from agent_memories
        4. [ACTIVE PROCEDURAL SKILLS]: runbook_md dynamically appended if trigger_keywords match current_query
        """
        # Tier 1: Agent Constitution & Persona
        profile = db_manager.get_agent_profile(self.agent_type)
        soul_md = (profile.get("soul_md") if profile else None) or self.custom_system_prompt or self.default_prompt
        rules_md = profile.get("rules_md", "") if profile else ""

        sections = []

        tier1 = f"[AGENT CONSTITUTION & PERSONA]\n{soul_md}"
        if rules_md:
            tier1 += f"\n\n[GUARDRAILS & OPERATIONAL PROTOCOL]\n{rules_md}"
        sections.append(tier1)

        # Tier 2: User Profile & Context
        user_prof = db_manager.get_user_profile(user_id)
        if user_prof:
            disp_name = user_prof.get("display_name", user_id)
            user_role = user_prof.get("role", "Executive")
            tone = user_prof.get("tone_style", "formal_executive")
            cust_inst = user_prof.get("custom_instructions", "")
            prof_md = user_prof.get("profile_md", "")

            tier2 = f"[USER PROFILE & CONTEXT]\n- Active User: {disp_name} (Role: {user_role})\n- Communication Tone: {tone}"
            if cust_inst:
                tier2 += f"\n- Custom Directives: {cust_inst}"
            if prof_md:
                tier2 += f"\n\nUser Profile Overview:\n{prof_md}"
            sections.append(tier2)

        # Tier 3: Workspace Memory
        memory_md = db_manager.get_agent_memory(self.agent_type, user_id, project_id)
        if memory_md:
            sections.append(f"[WORKSPACE MEMORY]\n{memory_md}")

        # Tier 4: Active Procedural Skills (Trigger-based)
        if current_query:
            matched_skills = db_manager.get_matching_skills(current_query)
            if matched_skills:
                skill_blocks = []
                for sk in matched_skills:
                    runbook = re.sub(r"^---\s*\n.*?\n---\s*\n?", "", sk.get("runbook_md", ""), count=1, flags=re.DOTALL)
                    skill_blocks.append(f"### Skill: {sk.get('skill_id')}\n{runbook.strip()}")
                sections.append(f"[ACTIVE PROCEDURAL SKILLS]\n" + "\n\n".join(skill_blocks))

        compiled = "\n\n".join(sections)
        return compiled

    def update_system_prompt(self, new_prompt: str, rules_prompt: Optional[str] = None):
        """Updates the system prompt in memory and persists to local SQLite agent_profiles table."""
        self.custom_system_prompt = new_prompt
        db_manager.save_agent_profile(
            agent_id=self.agent_type,
            agent_name=self.name,
            role_label=self.role_label,
            soul_md=new_prompt,
            rules_md=rules_prompt or "",
            provider=self.provider,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )
        logger.info(f"Updated system prompt for sub-agent {self.name} [{self.agent_type}] and persisted to local SQLite.")

    def update_model_config(
        self,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None
    ):
        # Agents use this Azure resource only; the selected deployment must be
        # one the workspace owner explicitly documented as available.
        self.provider = AZURE_PROVIDER
        if is_supported_azure_deployment(model):
            self.model = model
        elif model:
            logger.warning("Ignoring unsupported model '%s' for %s", model, self.agent_type)
        if temperature is not None:
            self.temperature = temperature
        if max_tokens is not None:
            self.max_tokens = max_tokens

        # Persist updated model config to local SQLite
        db_manager.save_agent_profile(
            agent_id=self.agent_type,
            agent_name=self.name,
            role_label=self.role_label,
            soul_md=self.custom_system_prompt or self.default_prompt,
            provider=self.provider,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )
        logger.info(f"Updated model config for {self.name} [{self.agent_type}]: Provider={self.provider}, Model={self.model}, Temp={self.temperature}")

    async def execute(self, task: AgentTask) -> AgentResult:
        agent_id = f"{self.agent_type.lower()}_{uuid.uuid4().hex[:6]}"
        await event_bus.notify_agent_spawned(
            agent_id=agent_id,
            name=self.name,
            agent_type=self.agent_type,
            role_label=f"{self.role_label}: {task.prompt[:15]}...",
            color=self.color
        )
        try:
            await event_bus.notify_agent_update(agent_id, status="working", current_task=task.prompt[:40])
            result = await self.process_task(agent_id, task)
            await event_bus.notify_agent_update(agent_id, status="complete", current_task="Task completed successfully")
            return result
        except Exception as e:
            logger.error(f"Error executing agent {self.name}: {e}")
            await event_bus.notify_agent_update(agent_id, status="error", current_task=f"Failed: {str(e)}")
            return AgentResult(
                task_id=task.task_id,
                agent_id=agent_id,
                agent_name=self.name,
                status="error",
                summary=f"Execution error in {self.name}: {str(e)}",
                data={"error": str(e)}
            )
        finally:
            await event_bus.notify_agent_terminated(agent_id)

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        raise NotImplementedError("Sub-agents must implement process_task()")


class AgentRegistry:
    """Central registry tracking available sub-agents and their domain capabilities."""

    def __init__(self):
        self._agents: Dict[str, BaseAgent] = {}

    def register(self, agent: BaseAgent):
        self._agents[agent.agent_type.lower()] = agent
        logger.info(f"Registered sub-agent into framework: {agent.name} [{agent.agent_type}]")

    def get_agent(self, agent_type: str) -> Optional[BaseAgent]:
        return self._agents.get(agent_type.lower())

    def list_agents(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": agent.name,
                "agent_type": agent.agent_type,
                "role_label": agent.role_label,
                "color": agent.color,
                "provider": agent.provider,
                "model": agent.model,
                "temperature": agent.temperature,
                "max_tokens": agent.max_tokens
            }
            for agent in self._agents.values()
        ]

agent_registry = AgentRegistry()
