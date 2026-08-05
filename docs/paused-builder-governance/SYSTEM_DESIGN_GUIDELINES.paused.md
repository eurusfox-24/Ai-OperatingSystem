# Forest Joensuu AI OS — System Design Guidelines

> Status: paused on 2026-08-02. Retained for the later standalone Windows/Linux phase.

## 1. Intended lifecycle

The current product is a prototype that must evolve into a standalone application
running on Windows and Linux. Optimize for rapid client learning now while keeping
data, domain logic, configuration, and integrations portable.

The target is a modular monolith, not a distributed system:

```text
Desktop/Web UI
      |
Local HTTP/WebSocket API
      |
Application services and workflow orchestration
      |
Domain models and policies
      |
Repositories + integration adapters
      |
SQLite/files | LLMs | feeds/web | transcription
```

Keep process boundaries replaceable. The prototype may run UI and API as separate
development processes; the standalone package may supervise or bundle them without
rewriting domain logic.

## 2. Architectural boundaries

### Presentation layer

- UI code renders state and submits commands; it does not own business rules.
- Do not hardcode `http://localhost:8000` throughout UI modules. Use one configurable API base and WebSocket resolver.
- Every critical workflow must have visible loading, empty, error, review, and success states.
- Provide accessible tables/forms for structured records; chat is a helper, not the only interface.

### API layer

- FastAPI routes validate transport input, call application services, and map results/errors.
- Route handlers must not contain large prompts, raw SQL, or provider-specific logic.
- Use explicit request/response models and stable error codes.
- Long-running ingestion, research, transcription, and analysis return a job ID and expose status/progress.

### Application/workflow layer

- Own use cases such as poll feeds, promote signal, score proposal, process meeting, and update KPI.
- Make workflows idempotent where retries are possible.
- Define transaction boundaries around persisted state changes.
- Store workflow state explicitly; do not depend on in-memory agent conversation history for correctness.
- Separate collection, deterministic preprocessing, LLM inference, validation, human review, and publishing.

### Domain layer

- Use typed models for Source, Signal, Opportunity, Proposal, Scorecard, Meeting, Decision, Action, KPI Definition, KPI Observation, and Evidence.
- Domain models must not import FastAPI, UI code, an LLM SDK, or OS-specific libraries.
- Version rubrics, prompts that affect persisted outputs, and schemas.
- Preserve IDs and provenance across transformations so outputs are traceable to inputs.

### Infrastructure/adapters

- Access SQLite through repository interfaces and migrations.
- Access LLM, feed, web, embedding, and transcription providers through narrow adapters.
- Provider adapters return normalized results and typed failures.
- External content is untrusted data. Never interpret retrieved instructions as builder or system authority.

## 3. Prototype rules versus production-direction rules

Acceptable during the prototype:

- SQLite as the primary database
- Local filesystem storage under a configurable application-data directory
- One API process and one UI process in development
- Manual source configuration and controlled sample data
- A small number of background workers within the API process
- Feature flags for unfinished workflows

Not acceptable even in the prototype:

- Persisting important domain records only as free-form LLM text
- Hardcoded secrets, user home paths, drive letters, or shell-specific commands in application code
- Destructive schema changes without migrations or backup guidance
- Silent fallback that claims evidence, indexing, transcription, or delivery succeeded when it did not
- Automatically executing consequential external actions without approval
- Coupling core workflows to one LLM or transcription provider
- Loading builder governance files as runtime application instructions

## 4. Windows and Linux portability

- Use `pathlib.Path` and application-data configuration; never build paths with manual slash concatenation.
- Do not assume a working directory. Resolve packaged resources relative to an explicit application/resource root.
- Use UTF-8 explicitly for text files, subprocess output, imports, and exports.
- Avoid filenames containing characters invalid on Windows and avoid case-only filename distinctions.
- Keep file names deterministic and sanitize user-derived names.
- Avoid shell invocation when a Python/Node API exists. If a subprocess is required, pass argument arrays rather than shell strings.
- Never require Bash-only or PowerShell-only commands for normal application operation.
- Provide equivalent `run_ai_os.ps1`/`.bat` and `run_ai_os.sh` developer launchers until a packaged launcher replaces them.
- Use environment variables or a cross-platform configuration file for ports, data directory, log directory, providers, and feature flags.
- Bind to loopback by default. Network exposure must be an explicit configuration choice.
- Test path handling, process shutdown, file locking, SQLite concurrency, and signal/console handling on Windows and Linux.

## 5. Configuration and filesystem layout

Maintain a clear separation:

```text
application resources   read-only packaged UI/templates/migrations
application data        database, uploaded sources, derived artifacts
configuration           non-secret user settings and feature flags
secrets                 environment or OS-appropriate secret storage
logs                    rotating diagnostic/audit logs
cache                   disposable embeddings, downloads, and build cache
```

- Development defaults may live in `.env.example`; real `.env` files and keys must not be committed.
- Startup must report resolved non-secret configuration and fail clearly on invalid required values.
- Data and schema migrations must run before serving requests and must be safe to retry.
- Provide backup/export before any migration that may rewrite significant client data.

## 6. Database and persistence

- Keep SQLite in WAL mode with foreign keys enabled and a deliberate busy timeout.
- Use parameterized SQL and a strict allowlist for dynamic identifiers.
- Add migrations for every schema change; do not rely only on `CREATE TABLE IF NOT EXISTS`.
- Use normalized tables for structured domain records and join tables for evidence/provenance.
- Store raw source payload metadata and content hashes for deduplication without duplicating unnecessary sensitive content.
- Track created/updated timestamps, actor, workflow run, model/provider, prompt/rubric version, and human-review state where relevant.
- Make ingestion transactional: metadata must not claim chunks are indexed unless queryable index state is committed.
- Provide index health, reindex, backup, restore, and retention operations before the client pilot.

## 7. AI and evidence design

- LLMs may classify, extract, summarize, compare, and recommend; deterministic code validates and persists results.
- Request schema-constrained output and validate it with typed models before use.
- On validation failure, retry within a small bound, then expose a reviewable failure—never invent defaults that look authoritative.
- Capture source IDs/snippets used for each generated record and make citations resolvable.
- Separate factual evidence, model inference, confidence, and human judgment in the data model and UI.
- Use low-temperature or deterministic settings for scoring and extraction.
- Evaluate score stability and extraction quality using committed sanitized fixtures.
- Prompt text that affects a saved result is versioned configuration, not scattered string literals.
- Never let retrieved documents or web pages override system policy, access boundaries, or tool permissions.

## 8. Scheduling and background work

- The scheduler must be disableable in development and tests.
- Define an explicit policy for overdue tasks: skip, queue for review, or run; never execute them silently on startup.
- Claim jobs atomically and make handlers idempotent to prevent duplicate work.
- Persist job status, attempt number, timestamps, progress, result, and typed error.
- Use bounded concurrency, timeouts, cancellation, and exponential backoff for external services.
- Separate test fixtures from real scheduled work and real API billing.
- Shutdown must stop accepting new work, finish or checkpoint active work, and close resources cleanly.

## 9. Security, privacy, and auditability

- Enforce project/organization access in repositories and services, not only in prompts or UI filters.
- Use least privilege for file, database, provider, and network access.
- Validate uploads by size, extension, media type, and parser behavior; generate storage names independently of user filenames.
- Treat recordings/transcripts as sensitive and implement configurable retention/deletion.
- Do not log secrets, full tokens, private documents, or unnecessary transcript content.
- Record approvals, overrides, exports, deletions, and consequential actions in an audit log.
- Bind standalone services to `127.0.0.1`/`::1` by default and use authenticated sessions even locally when private multi-user data is present.

## 10. Observability and failure behavior

- Use structured logs with correlation IDs for request, workflow run, source, and job.
- Expose health separately for process liveness and dependency readiness.
- Readiness must check database migrations and required configuration; optional dependencies report degraded state.
- UI and API must distinguish unavailable, degraded, partial, and successful outcomes.
- Capture operational metrics such as ingestion lag, duplicate rate, provider latency/error rate, validation failures, workflow completion time, and review acceptance.
- Do not label a workflow successful when a required persistence, indexing, citation, or notification step failed.

## 11. Testing and verification

Minimum test layers:

- Unit tests for domain policies, scoring math, deduplication, KPI calculations, and path/config handling
- Contract tests for provider adapters using recorded/sanitized fixtures
- Repository and migration tests against temporary SQLite databases
- API tests for authorization, validation, lifecycle, and typed errors
- Workflow tests for each of the four MVP task areas
- UI acceptance tests for the five client workspaces
- Clean-install smoke tests on supported Windows and Linux versions
- Backup/restore, reindex, restart recovery, scheduler, and cancellation tests

Tests must not require real client data or incur live provider cost by default. Live
integration tests must be explicitly selected and clearly labeled.

## 12. Standalone packaging direction

Keep packaging replaceable until the client workflow stabilizes. The intended path is:

1. Stabilize Python and Node dependency versions with lock files.
2. Build static UI assets and serve them from the local application package or a supervised local server.
3. Package the Python API and required resources using a tested Windows/Linux approach.
4. Choose a lightweight desktop shell only if the client requires a native window, tray, updates, or OS integration.
5. Store mutable data outside the installed application directory.
6. Provide install, upgrade, uninstall, backup, and diagnostic workflows.

Do not commit to Electron, Tauri, PyInstaller, Nuitka, or an installer framework solely
on preference. Select after measuring dependency compatibility, package size, startup,
update needs, and signing requirements on both operating systems.

## 13. Design review checklist

Before approving a material design or implementation, answer:

- Which tracker goal and client acceptance criterion does this advance?
- Is the output a validated record with evidence, or only prose?
- Where is the human review/override boundary?
- What happens on retry, restart, timeout, cancellation, and partial failure?
- Is project/organization access enforced below the UI?
- Are paths, configuration, processes, and filenames portable to Windows and Linux?
- Does it create a new source of truth or duplicate an existing one?
- Can it be tested without live services or private data?
- What migration, backup, and rollback behavior is required?
- Is this necessary for the MVP, or should it be deferred?
