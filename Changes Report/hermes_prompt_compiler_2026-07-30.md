# Hermes 4-Tier Prompt Compiler Refactor - Changes Report
**Date**: 2026-07-30

## Summary of Architectural Changes
Complete refactor of the AI OS prompt engine into a dynamic, 4-tier Hermes-style ChatML prompt compiler. Hardcoded Python fallback dependencies have been eliminated by auto-seeding SQLite (`agent_profiles` table) on first boot. `ManagerAgent` was unified to inherit from `BaseAgent`, connecting all primary and sub-agents to the identical layered compilation pipeline.

## Detailed Technical Changes

### 1. Unified Class Hierarchy (`kernel/agents/manager.py`)
- Refactored `ManagerAgent` to inherit from `BaseAgent` (`class ManagerAgent(BaseAgent)`).
- Replaced custom isolated `get_system_prompt()` and `update_system_prompt()` methods with calls to `BaseAgent`'s compilation pipeline.
- `ManagerAgent.get_user_history()` now passes `username` and `current_query` to `get_system_prompt()`, enabling trigger-based procedural skill injection into chat turns.

### 2. Upgraded Database Schema & Auto-Seeding (`kernel/db/local_manager.py`)
- **Schema Expansion**:
  - `agent_profiles`: Added/verified `soul_md` (Identity/Persona) and `rules_md` (Guardrails/Delegation protocols) columns.
  - `user_profiles`: Stores user workflow styles, role context, and custom directives.
  - `agent_memories`: New table storing long-term persistent workspace memory (`memory_md`).
  - `agent_skills`: New table storing conditional procedural runbooks (`trigger_keywords`, `runbook_md`).
- **Auto-Seeding (`_seed_default_agent_profiles`)**:
  - Automatically seeds default profiles into SQLite for all 6 core agents (`ManagerAgent`, `FinancialAdvisorAgent`, `MeetingNotesAgent`, `ForesightAgent`, `IdeaScorerAgent`, `SusicornAgent`) if unpopulated.
  - Separates identity (`soul_md`) from operational guardrails (`rules_md`), removing source-code string fallback reliance.
- **New CRUD Methods**: `get_agent_memory()`, `save_agent_memory()`, `get_matching_skills()`, `save_agent_skill()`.

### 3. Hermes 4-Tier Layered Prompt Compiler (`kernel/core/framework.py`)
- Replaced monolithic `get_system_prompt()` in `BaseAgent` with a 4-tier ChatML compiler:
  - **Tier 1: [AGENT CONSTITUTION & PERSONA]** (`soul_md` + `rules_md` from SQLite `agent_profiles`).
  - **Tier 2: [USER PROFILE & CONTEXT]** (`profile_md`, `tone_style`, `custom_instructions` from SQLite `user_profiles`).
  - **Tier 3: [WORKSPACE MEMORY]** (`memory_md` from SQLite `agent_memories`).
  - **Tier 4: [ACTIVE PROCEDURAL SKILLS]** (`runbook_md` from `agent_skills` dynamically injected when `trigger_keywords` match terms in `current_query`).

### 4. API Endpoints (`kernel/server.py`)
- `POST /api/agents/prompt/update` writes directly to `agent_profiles` (`soul_md` and `rules_md`), ensuring instant runtime compilation changes in the UI.

## Verification Results
- ✅ `ManagerAgent` successfully inherits `BaseAgent`
- ✅ SQLite database auto-seeded 6 agent profiles with `soul_md` and `rules_md`
- ✅ 4-Tier compilation tested and verified via Python scripts
- ✅ Conditional Tier 4 skill injection tested and verified (`roi_calculator` skill triggered only on matching queries)
- ✅ Vite frontend UI build passed cleanly in 528ms
