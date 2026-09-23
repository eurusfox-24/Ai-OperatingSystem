"""Deterministic authority checks for agent actions.

The model may propose work, but this module decides whether the runtime can do it.
"""

from dataclasses import dataclass
from typing import Any, Dict


RISK_ORDER = {
    "read": 0,
    "internal_write": 1,
    "external_draft": 2,
    "consequential": 3,
}


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    approval_required: bool
    reason: str


class AgenticPolicy:
    """Small, auditable policy layer used before every task dispatch."""

    AUTOMATIC_RISKS = {"read", "internal_write", "external_draft"}

    def evaluate(self, goal: Dict[str, Any], task: Dict[str, Any]) -> PolicyDecision:
        risk = str(task.get("risk_level") or "read")
        if risk not in RISK_ORDER:
            return PolicyDecision(False, False, f"Unknown risk level: {risk}")
        if task.get("capability") in {"web_research", "foresight"} and not goal.get("web_access"):
            return PolicyDecision(False, False, "Public-web access is disabled for this goal")
        if risk == "consequential":
            return PolicyDecision(False, True, "Consequential actions require explicit human approval")
        return PolicyDecision(True, False, f"{risk} action is permitted inside the selected project scope")

    @staticmethod
    def validate_budget(goal: Dict[str, Any], completed_steps: int) -> PolicyDecision:
        max_steps = max(1, int(goal.get("max_steps") or 1))
        if completed_steps >= max_steps:
            return PolicyDecision(False, False, f"Goal reached its {max_steps}-step budget")
        spent = float(goal.get("spent_cost_usd") or 0.0)
        maximum = float(goal.get("max_cost_usd") or 0.0)
        if maximum > 0 and spent >= maximum:
            return PolicyDecision(False, False, f"Goal reached its ${maximum:.2f} cost budget")
        return PolicyDecision(True, False, "Budget available")


agentic_policy = AgenticPolicy()
