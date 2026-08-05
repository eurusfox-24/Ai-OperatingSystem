# Audit Remediation Summary — 2026-08-01

## Implemented fixes

| Audit items | Remediation |
| --- | --- |
| BUG-01 | LLM network calls now run through `asyncio.to_thread`, keeping the event loop responsive. |
| BUG-02 | Kanban awaits the manager coroutine and uses the supported `chat_completion` API for summaries. |
| BUG-03 | Document deletion uses `HAS_SQLITE_VEC` and always closes its SQLite connection. |
| BUG-04 | Per-user chat transcripts are capped at 25 messages; old image payloads are discarded. |
| BUG-05 | Fixed TypeScript `str` usage, declared Database Studio state, fixed the row-fields reference, and declared other live-mode state used by the UI. |
| BUG-06 | Table and column names are verified against SQLite metadata, safely quoted, and values remain bound parameters. Unknown fields/tables are rejected. |
| BUG-07 | New schemas use foreign keys and cascading deletes; existing databases are migrated by rebuilding the affected child tables while preserving valid data. |
| BUG-08 | Added indexes for document chunks, agent memories, and Kanban status. |
| BUG-09 | SQLite connections enable WAL, foreign keys, a 30-second timeout, and a busy timeout. |
| BUG-10–13 | Filesystem `SKILL.md` files synchronize into SQLite; skill names are path-safe, keywords derive from descriptions, and YAML frontmatter is stripped before prompt injection. Tool calls now accept procedural skill bodies. |
| BUG-15 | The application shell remains hidden and inert until a successful login. Logging out closes the telemetry connection and restores the login-only state. |
| BUG-16 | WebSockets target the kernel port (8000) by default, can be configured through `globalThis.__AI_OS_WS_URL__`, and intentional close no longer triggers reconnection. |

## Deliberate safety boundary

BUG-14 requested arbitrary dynamically imported executable code from filesystem skills. That would allow any writable `SKILL.md`/skill folder to become host-code execution. The remediation keeps skills declarative and synchronized as structured procedures; executable capabilities remain registered application tools. A future executable-plugin system should use signed packages, explicit manifests, and an allowlisted sandbox.

## Verification

- `python -m compileall -q kernel` completed successfully.
- TypeScript type checking of `ui/src/main.ts` and `ui/src/socket.ts` completed successfully.
- SQLite smoke tests confirmed parameter/identifier protection, foreign-key enforcement, WAL mode, indexes, and document cascade behavior.
- Browser E2E verification passed against the locally started backend (`127.0.0.1:8000`) and Vite UI (`127.0.0.1:3000`): before authentication only the login modal was visible; after a valid local login the dashboard appeared with `Kernel Online`; after logout it returned to the login-only state. Browser console logs contained no warnings or errors, confirming the WebSocket endpoint connected successfully.
- The production Vite build remains blocked in the restricted sandbox by esbuild directory-access restrictions, rather than application diagnostics. The dev server ran successfully outside that restriction for the browser test.

## Notebook and research workspace follow-up

- Replaced hard-coded notebook labels with persistent SQLite notebooks and explicit document membership. Existing documents are automatically grouped into the initial **Company Knowledge Base** once.
- The `+` beside **My Notebooks** opens a drag-and-drop/Choose File flow that indexes a company document and assigns it to the selected notebook. The source list now shows only the documents belonging to the selected notebooks.
- Added **New** notebook creation, notebook document APIs, and a document-safe upload filename path.
- Added the Manager’s selectable research modes: **Notebook RAG**, **Internet Search**, and **Notebook + Internet**. The selected notebook IDs and mode are supplied to the backend; internal sources and live web results are kept distinguishable in the model context.
- Added a persisted lexical retrieval fallback so notebook RAG remains functional after a restart when `sqlite-vec` is not installed.
- The Database page now loads the real, application-level tables (excluding vector-store internals) and supports view, edit, delete, and create-row flows for developer CRUD work.

## Headless web-research follow-up

- Upgraded Scrapling to its supported `fetchers` installation and installed Patchright Chromium for headless JavaScript rendering.
- Web research now searches DuckDuckGo Lite, renders each selected public result in headless Chromium, extracts readable text, and includes source title and URL metadata for synthesis.
- Added protection against server-side request forgery: non-HTTP(S), localhost, private, link-local, multicast, reserved, and unresolvable targets are rejected before fetch.
- Manager **Notebook + Internet** context preserves a clear boundary between internal notebook retrieval and live web evidence, and instructs the model to cite them separately.
- Verified page rendering, search-to-source extraction, and manager-level RAG-plus-web context assembly with automated smoke tests.

## Autonomous deep-research follow-up

- Added a persisted **Deep Research Agent** modeled on the useful parts of autonomous-agent systems: an explicit tool registry, a bounded plan, observable task steps, durable memory/artifacts, and a learning-ready evidence history. The implementation deliberately does not copy the unsafe “model can run anything” pattern.
- A research mission independently performs: selected notebook retrieval, public-web research with the existing SSRF-safe headless scraper, evidence synthesis, and persistence of the cited Markdown report.
- Added `autonomous_tasks`, `autonomous_task_steps`, `research_artifacts`, and `autonomous_approvals` tables. Developers can inspect the mission, plan, evidence sources, report, and future approval decisions through the Database page.
- Added API routes for capability policy, starting a research mission, polling task state, and recording an approval decision. The browser polls the task endpoint, so long-running research does not hold the regular chat request open.
- Added the **🔎 Deep research** action in the Boardroom. It combines the currently selected notebooks with up to three rendered public-web sources and clearly labels the result as an autonomous evidence report.
- Read-only tools (`notebook_search`, `public_web_research`, `evidence_synthesis`) may run autonomously. Authenticated browser actions and file writes are represented as approval-required capabilities, while arbitrary command execution is disabled. Existing chat tool calls for file writes, command execution, and dynamic skill creation are now blocked rather than granting host access from a prompt.
- Escaped model text before rendering it in the chat panel, closing the prior path where untrusted model/source content could be injected as raw HTML.

### Reference patterns consulted

- [Hermes Agent tools and toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/) documents explicit, configurable toolsets rather than an implicit capability grab.
- [OpenClaw tools overview](https://github.com/openclaw/openclaw/blob/main/docs/tools/index.md) describes typed tools and scoped skills.
- [OpenClaw browser configuration](https://docs.openclaw.ai/tools/browser) documents tool enablement and SSRF policy, reinforcing the separate browser and network boundaries used here.
- [OpenClaw security guidance](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md) warns that allowed callers can induce network, browser, and execution tools—hence the approval boundary in this implementation.

### Autonomous verification

- `python -m compileall -q kernel` and TypeScript type checking passed.
- An isolated SQLite test ran the full task lifecycle with deterministic notebook/web/LLM fakes: queued → running → completed, with step logs, a research artifact, and source metadata persisted.
- The live backend served `/api/autonomy/capabilities` after restart, and browser verification confirmed that the local authenticated Boardroom shows the **🔎 Deep research** control alongside the selected notebook and research-mode controls.
