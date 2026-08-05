# Technical Report: Customization Studio & API Usage Overhaul
**Date:** 2026-07-31

## Summary of Architectural Changes
- **API Usage Tracking Kernel Extension**: The `UnifiedLLMProviderFactory` in `llm_provider.py` now monitors all model completion requests, aggregating prompt and completion token counts and heuristic cost estimations. This data is persisted dynamically in `data/api_usage.json`.
- **New API Endpoint**: `kernel/server.py` exposes `GET /api/providers/usage` for frontend consumption.
- **Frontend Refactor (Customization Studio)**: The "#view-customization" section in `index.html` was completely purged and rebuilt into a clean, 3-panel modular layout focusing on tracking API usage, managing API credentials, and defining agent identities.

## Detailed Breakdown of Technical Changes
### Backend / Kernel
- **`kernel/core/llm_provider.py`**:
  - Implemented `track_usage(provider, model, usage_dict)` which parses raw usage metadata (including Google Gemini's distinct payload mapping) and calculates estimated costs based on whether a model is large or mini/flash.
  - Implemented `get_api_usage_status()` to read from `data/api_usage.json`.
  - Added interceptions in `chat_completion()` to automatically trigger `track_usage` upon successful LLM responses before returning to the orchestrator.
- **`kernel/server.py`**:
  - Registered the `/api/providers/usage` GET endpoint mapping to `llm_provider.get_api_usage_status()`.

### Frontend / UI
- **`ui/index.html`**:
  - Removed the outdated "Agent System Prompt & Model Provider Studio" grid elements.
  - Built **Panel 1: API Usage Dashboard**, featuring metric cards for total requests, prompt tokens, completion tokens, estimated cost, and a provider breakdown table.
  - Refined **Panel 2: Provider API Credentials Studio** for a cleaner layout without the extraneous and broken "add custom model" select elements, focusing purely on credentials.
  - Built **Panel 3: Agent Identity & Model Settings**, consolidating the model selection and system prompt editing workflows.
- **`ui/src/main.ts`**:
  - Wired the new API Usage UI elements via `fetchAndRenderApiUsage()`, mapping the `/api/providers/usage` backend response to the dashboard stat cards and the dynamic table.
  - Re-mapped the `habitatAgentSelect`, `habitatProviderSelect`, and `habitatModelSelect` listeners to ensure state reactivity remains intact after the HTML structure changes.
  - Executed a clean Vite build (`npm run build`) without errors.
