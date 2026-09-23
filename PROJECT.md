# The Company AI OS — Project State

## Current state

The project is a working local-first AI operating environment with a FastAPI kernel, a Vite/TypeScript dashboard, durable SQLite state, document retrieval, specialist agents, deep research, scheduled work, and bounded goal orchestration.

The runtime is deliberately Azure-only. The provider registry can hold setup drafts for future adapters, but drafts cannot be selected for live agent execution.

## Runtime architecture

```text
Browser UI
  ├─ signed HTTP API
  └─ authenticated WebSocket telemetry
          │
FastAPI kernel
  ├─ Manager chat and specialist agents
  ├─ bounded goal orchestrator
  ├─ autonomous deep-research runner
  ├─ RSS/Atom connector scheduler
  ├─ document ingestion and retrieval
  └─ SQLite persistence
          │
Azure OpenAI deployments
```

Primary code:

- `kernel/server.py`: authenticated API boundary and lifecycle.
- `kernel/agentic/`: durable goals, plans, policies, approvals, and orchestration.
- `kernel/agents/`: Manager and specialist capabilities.
- `kernel/db/local_manager.py`: SQLite schema, migrations, and persistence.
- `kernel/rag/doc_store.py`: safe document parsing, atomic indexing, and retrieval.
- `kernel/connectors/`: read-only external feed connectors and signal ranking.
- `ui/src/main.ts`: dashboard behavior and authenticated API integration.

## Agentic execution model

1. A goal is saved with owner, project/document scope, success criteria, and runtime/step/cost limits.
2. The orchestrator creates a dependency-aware plan.
3. Independent ready tasks execute concurrently.
4. Every task transition, output, observed model cost, approval, and user steering event is persisted.
5. Consequential actions stop in `waiting_approval`.
6. Approval requeues the exact waiting task; rejection cancels the goal.
7. Startup recovery requeues interrupted goal and deep-research work.
8. Shutdown cancels active workers cleanly so the next startup can recover them.

The present adapters produce internal analysis, reports, drafts, and persisted artifacts. Sending email, publishing, purchasing, or mutating an external business system is not implemented.

## Security boundary

- All `/api/*` routes except health and login require a signed bearer token.
- WebSockets authenticate through a negotiated subprotocol; tokens are not placed in URLs.
- Admin-only routes protect database inspection, provider settings, prompts, and business context.
- User-owned chats, goals, tasks, research runs, and connectors enforce owner checks.
- Passwords use PBKDF2-SHA256 hashes; plaintext passwords are not stored.
- Password changes increment a persisted session version, invalidating older HTTP and WebSocket sessions even after a kernel restart.
- CORS and server binding default to local addresses.
- Azure credentials come from the environment and are never persisted by the settings API.
- Uploads enforce safe names, supported modern formats, and a 25 MiB limit.
- Web/RSS fetching blocks private-network targets and revalidates redirects.

Set `AI_OS_AUTH_SECRET` for sessions that survive a kernel restart. If `data/users.json` does not exist, set `AI_OS_BOOTSTRAP_PASSWORD` for the first startup.

## Persistence and recovery

The default database is `data/kernel_workspace.db`; override it with `KERNEL_DB_PATH`.

Document metadata and chunks are replaced in one SQLite transaction. Embedding outages fall back to lexical indexing instead of losing the document. Startup repairs older metadata rows that have no chunks. Raw files, database rows, notebook membership, and process-local vector caches are deleted together.

## Verification

- Python: 24 unit/integration tests covering orchestration, approvals, concurrency, recovery, connectors, authentication, password/session invalidation, and atomic document ingestion.
- TypeScript: strict no-emit typecheck.
- UI: production Vite build.
- Browser: 8 Playwright tests covering authentication, navigation, monitoring, localization persistence, rapid view switching, and Pixel Office resizing.

Browser tests create isolated temporary users and a temporary SQLite database; they do not modify the live local workspace.

## Known operational requirements

- Install `kernel/requirements.txt` in the project virtual environment. Without `sqlite-vec`, retrieval remains functional through the lexical/in-memory fallback but vector search is unavailable.
- Configure `AZURE_OPENAI_API_KEY` and the relevant Azure deployment environment variables for live model calls.
- Provider entries other than Azure are configuration drafts, not runtime adapters.
- The tracked files under `data/documents/` include reference material; only documents registered in SQLite are live retrieval sources.
