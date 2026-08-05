import os
import json
import logging
import re
from typing import Dict, Any

logger = logging.getLogger("god_mode")

AGENTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".agents"))
CONFIG_PATH = os.path.join(AGENTS_DIR, "config.json")
RULES_PATH = os.path.join(AGENTS_DIR, "AGENTS.md")
SKILLS_DIR = os.path.join(AGENTS_DIR, "skills")

class GodModeEngine:
    """Managed, Hermes-style procedural skill creation and revision engine."""

    MAX_SKILL_DESCRIPTION_CHARS = 600
    MAX_SKILL_BODY_CHARS = 16_000

    def __init__(self):
        self._ensure_dirs()
        self.config = self.load_config()
        # Filesystem skills change rarely. Synchronize once at process startup
        # and immediately when a skill is edited, never on every chat message.
        self.sync_skills_to_db()

    def _ensure_dirs(self):
        os.makedirs(AGENTS_DIR, exist_ok=True)
        os.makedirs(SKILLS_DIR, exist_ok=True)
        if not os.path.exists(RULES_PATH):
            with open(RULES_PATH, "w", encoding="utf-8") as f:
                f.write("# Forest Joensuu AI OS System Rules\n\n- Primary Persona: Strategic AI Board Member\n- Target Focus: Job creation, investments, and Susicorn scaling in Joensuu, Finland.\n")
        if not os.path.exists(CONFIG_PATH):
            default_cfg = {
                "persona": "Strategic Executive Board Member",
                "risk_tolerance": "balanced",
                "focus_sectors": ["forestry", "bioeconomy", "green_transition", "susicorn_startups"],
                "active_prompt_override": None,
                "weights": {
                    "job_creation": 0.35,
                    "susicorn_factor": 0.30,
                    "regional_roi": 0.20,
                    "feasibility": 0.15
                }
            }
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(default_cfg, f, indent=2)

    def load_config(self) -> Dict[str, Any]:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load config: {e}")
            return {}

    def save_config(self, new_config: Dict[str, Any]):
        self.config = new_config
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(self.config, f, indent=2)

    def mutate_persona_and_prompt(self, instruction: str) -> str:
        """Dynamically updates active prompt rules and persona config based on user instruction."""
        current_override = self.config.get("active_prompt_override") or ""
        updated_override = f"{current_override}\n- USER DIRECTIVE: {instruction}".strip()
        self.config["active_prompt_override"] = updated_override
        self.save_config(self.config)

        # Append to persistent AGENTS.md
        with open(RULES_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n- Dynamic Instruction: {instruction}")

        return f"God Mode Activated: Configuration mutated successfully with directive: '{instruction}'"

    @staticmethod
    def _normalise_skill_name(skill_name: str) -> str:
        safe_name = re.sub(r"[^a-z0-9_-]", "_", skill_name.strip().lower())
        if not safe_name or safe_name in {".", ".."}:
            raise ValueError("Skill name must contain letters, numbers, underscores, or hyphens")
        return safe_name

    @staticmethod
    def _keywords(skill_name: str, description: str) -> str:
        ignored = {"a", "an", "and", "for", "in", "of", "the", "to", "with", "skill", "tool"}
        words = re.findall(r"[a-z0-9]{3,}", f"{skill_name} {description}".lower())
        return ",".join(dict.fromkeys(word for word in words if word not in ignored))

    def sync_skills_to_db(self) -> int:
        """Make filesystem SKILL.md files the durable source of truth for the registry."""
        try:
            from kernel.db.local_manager import db_manager
            synced = 0
            for entry in os.scandir(SKILLS_DIR):
                if not entry.is_dir():
                    continue
                skill_file = os.path.join(entry.path, "SKILL.md")
                if not os.path.isfile(skill_file):
                    continue
                with open(skill_file, "r", encoding="utf-8") as f:
                    content = f.read()
                name = entry.name
                description = ""
                header = re.match(r"^---\s*\n(.*?)\n---\s*\n?", content, re.DOTALL)
                if header:
                    for line in header.group(1).splitlines():
                        key, separator, value = line.partition(":")
                        if separator and key.strip().lower() == "name" and value.strip():
                            name = self._normalise_skill_name(value.strip())
                        elif separator and key.strip().lower() == "description":
                            description = value.strip()
                db_manager.save_agent_skill(name, self._keywords(name, description), content)
                synced += 1
            return synced
        except Exception as e:
            logger.error(f"Failed to synchronize filesystem skills: {e}")
            return 0

    def register_new_skill(self, skill_name: str, description: str, markdown_body: str) -> str:
        """Creates or updates a declarative SKILL.md in the managed skill bank.

        Skills are instructions/routines used by agents, not executable plug-ins.
        The model therefore gets genuine autonomy to evolve procedures without
        receiving an arbitrary host-file or shell capability.
        """
        skill_name = self._normalise_skill_name(skill_name)
        description = " ".join(description.split())[:self.MAX_SKILL_DESCRIPTION_CHARS]
        markdown_body = markdown_body.strip()
        if not description:
            raise ValueError("Skill description is required")
        if not markdown_body:
            raise ValueError("Skill procedure is required")
        if len(markdown_body) > self.MAX_SKILL_BODY_CHARS:
            raise ValueError("Skill procedure is too large")
        if "\x00" in markdown_body:
            raise ValueError("Skill procedure contains an invalid null byte")
        skill_folder = os.path.join(SKILLS_DIR, skill_name)
        os.makedirs(skill_folder, exist_ok=True)
        skill_file = os.path.join(skill_folder, "SKILL.md")
        existed = os.path.isfile(skill_file)
        content = f"---\nname: {skill_name}\ndescription: {description}\n---\n\n{markdown_body}"
        with open(skill_file, "w", encoding="utf-8") as f:
            f.write(content)

        try:
            from kernel.db.local_manager import db_manager
            db_manager.save_agent_skill(
                skill_id=skill_name,
                trigger_keywords=self._keywords(skill_name, description),
                runbook_md=content
            )
        except Exception as e:
            logger.error(f"Failed to save skill '{skill_name}' to SQLite: {e}")

        action = "updated" if existed else "created"
        return f"Skill '{skill_name}' {action} in managed skill bank at {skill_file}"

god_mode_engine = GodModeEngine()
