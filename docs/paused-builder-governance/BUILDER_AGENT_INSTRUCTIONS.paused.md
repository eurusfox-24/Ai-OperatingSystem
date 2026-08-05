# Builder Agent Instructions

> Status: paused on 2026-08-02 while the team focuses on a lightweight showcase prototype.

## Purpose

This file governs Codex and other coding agents that modify this repository. It is
not a runtime prompt for the AI OS, must not be loaded by application agents, and
must not be ingested into the application knowledge base or SQLite/RAG storage.

## Mandatory reading order

Before planning or changing the repository, builder agents must read:

1. `PROJECT_CONSTRAINTS.md` — product scope, priorities, non-goals, and acceptance boundaries.
2. `PROJECT_TRACKER.md` — current milestone, verified progress, blockers, and next work.
3. `SYSTEM_DESIGN_GUIDELINES.md` — architecture and Windows/Linux portability rules.

`PROJECT_TRACKER.md` is the source of truth for current delivery status. The older
`PROJECT.md` records a completed technical audit and is not the active MVP roadmap.

## Builder operating rules

- Keep every change traceable to an MVP goal, tracker item, defect, or explicit user request.
- Do not add features merely because they are technically interesting.
- Prefer completing one client-facing workflow end to end over adding another isolated agent or demo.
- Preserve user changes and inspect the worktree before editing overlapping files.
- Do not modify `.agents/` for these governance rules; that directory belongs to existing project/runtime tooling.
- Do not place these governance documents in application prompts, RAG sources, seed data, or UI content.
- Use structured, testable outputs at workflow boundaries; do not rely on unvalidated LLM prose for persisted records.
- Keep the prototype runnable on Windows while avoiding decisions that prevent later Windows and Linux packaging.
- Treat external side effects, credentials, client data, and meeting recordings as security-sensitive.
- Update `PROJECT_TRACKER.md` when a material tracker item is implemented, verified, blocked, or deliberately descoped.
- Never mark an item complete without recording verification evidence.

## Required completion behavior

For material implementation work, builder agents must:

1. Identify the tracker item(s) affected.
2. Implement the smallest coherent change that advances those items.
3. Run verification proportional to the risk.
4. Update the tracker status, evidence, and change log in the same change set.
5. Report remaining gaps and any portability or data-migration impact.

If a user request conflicts with these files, follow the user's explicit request and
record the resulting scope decision in `PROJECT_TRACKER.md` when it materially
changes the MVP.
