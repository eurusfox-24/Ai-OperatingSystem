# Agentic Goal Orchestration MVP — 2026-08-17

## Outcome

AI OS now includes a bounded, persistent goal-orchestration workflow for autonomous project assessments. The Manager creates a dependency plan, specialist agents complete scoped analysis, a separate verification step checks the final brief, and the complete lifecycle remains visible in the Agent Goal Control Center.

This is intentionally not an unrestricted agent. Public-web access is opt-in, project documents are scoped at goal creation, and consequential actions are stored as approval proposals rather than executed.

## Backend

- Added `kernel/agentic/policy.py` for deterministic risk, permission, web-access, and budget checks.
- Added `kernel/agentic/store.py` for durable goals, tasks, dependencies, events, artifacts, steering, and approval proposals.
- Added `kernel/agentic/orchestrator.py` for planning, dependency-aware dispatch, retries, safe-boundary controls, verification, completion, and restart recovery.
- Added SQLite tables for goals, tasks, action proposals, events, and artifacts.
- Added `/api/agentic/*` endpoints for capabilities, goal creation/list/detail, lifecycle controls, steering, and proposal decisions.
- Added startup recovery and background scheduling for queued goals.

## Default project-assessment plan

1. Gather scoped evidence.
2. Assess financial implications.
3. Score feasibility and regional impact.
4. Assess market/foresight context when web access is permitted.
5. Add venture or meeting analysis when the goal calls for it.
6. Produce the decision brief.
7. Verify the brief against the goal and evidence.

## User interface

The new **Agent Goals** view provides:

- Goal creation with project, web-access, and runtime boundaries.
- Live goal status and plan progress.
- Task ownership, capabilities, risk level, outputs, and failures.
- Pause, resume, cancel, and next-boundary steering controls.
- Approval proposal review.
- Persisted artifacts, final outcome, and audit trail.

## Safety model

- `read`: automatic inside goal scope.
- `internal_write`: automatic and audited.
- `external_draft`: draft creation only.
- `consequential`: explicit approval proposal; external execution is disabled in this MVP.
- Arbitrary shell or filesystem access is not part of the goal runner.

## Verification

- Python compilation succeeded for the new modules and integration points.
- Five backend scenario tests pass: dependency release, web/authority policy, approval-without-execution, restart recovery, and end-to-end goal completion with a persisted artifact.
- Vite production build succeeds.
- Live browser testing confirmed navigation, the control-center empty state, the goal form, project options, permission messaging, and zero browser console errors.

## Known follow-up work

- Attribute exact provider token/cost usage to each individual goal; the schema reserves cost fields, while the MVP currently enforces step, retry, and runtime budgets.
- Add typed external connectors only as individually scoped capabilities, each behind the approval gateway.
- Add model-proposed plan variants and structured replanning beyond the current conservative project-assessment template and retry loop.
- Resolve the pre-existing duplicate translation-key warnings in `ui/src/i18n.ts`.
