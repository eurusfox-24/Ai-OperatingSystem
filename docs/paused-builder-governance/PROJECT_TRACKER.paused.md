# The Company AI OS — Living MVP Tracker

> Status: paused on 2026-08-02. Do not treat this as the active delivery plan for the lightweight showcase.

## How builder agents must use this file

This is the current product delivery record for Codex and other coding agents.
Update it in the same change set whenever material work changes a status, acceptance
result, blocker, scope decision, or verified baseline.

Allowed status values:

- `NOT STARTED`
- `IN PROGRESS`
- `BLOCKED`
- `READY FOR ACCEPTANCE`
- `DONE`
- `DEFERRED`

Rules:

- Only one milestone should normally be `IN PROGRESS` at a time.
- `DONE` requires evidence in the Verification column.
- Code existence is not verification; use tests, API checks, UI flows, fixtures, or client acceptance.
- Never delete completed history. Add a dated change-log entry.
- When a blocker is resolved, replace the blocker with the resolution and evidence.
- Update the `Last reviewed` date whenever statuses are materially changed.

## Current programme state

- **Last reviewed:** 2026-08-02
- **Current phase:** Scope alignment and MVP foundation
- **Current milestone:** M0 — Governance and measurable product contract
- **Overall assessment:** Core AI capabilities exist, but the four client workflows are only partially implemented end to end.
- **Primary next outcome:** Establish structured domain records and complete automatic intelligence ingestion.

## Milestone summary

| ID | Milestone | Status | Exit condition |
|---|---|---|---|
| M0 | Governance and measurable product contract | IN PROGRESS | Builder rules adopted; domain contracts and acceptance fixtures agreed |
| M1 | Intelligence radar | NOT STARTED | Scheduled RSS/Alerts ingestion produces deduplicated, cited signal briefs |
| M2 | Opportunity pipeline | NOT STARTED | Signals can become reviewed, owned, traceable opportunities |
| M3 | Proposal portfolio | NOT STARTED | Versioned seven-criterion structured scoring and comparison work end to end |
| M4 | Meeting workspace | NOT STARTED | Recording/transcript produces reviewed decisions, actions, themes, and agenda |
| M5 | Strategic KPI dashboard | NOT STARTED | Fewer than 10 defined KPIs show values, targets, provenance, and history |
| M6 | Client pilot hardening | NOT STARTED | Cross-platform package, security checks, recovery, and acceptance suite pass |

## Goal tracker

| ID | Goal | Baseline on 2026-08-02 | Status | Acceptance check | Verification |
|---|---|---|---|---|---|
| G-01 | Configured RSS/Atom and Google Alerts-compatible source registry | Live web research exists; no feed registry found | NOT STARTED | Add, disable, poll, and inspect a feed with persisted source metadata | Pending |
| G-02 | Scheduled signal ingestion and deduplication | Generic task scheduler exists; no signal ingestion job | NOT STARTED | Two overlapping feeds produce one canonical signal with source links | Pending |
| G-03 | Cited daily/weekly change brief | Foresight and deep research produce narrative reports | NOT STARTED | Brief identifies new/changed themes and links every item to evidence | Pending |
| G-04 | Structured opportunity pipeline | Agents mention opportunities in prose | NOT STARTED | Promote signal to typed opportunity; assign owner/status/next action | Pending |
| G-05 | Opportunity qualification and impact estimates | No persistent qualification record found | NOT STARTED | Review, override, and audit confidence, impact, deadline, and rationale | Pending |
| G-06 | Seven-criterion proposal scoring | Idea scorer covers a subset in Markdown | IN PROGRESS | Validated schema, weights, rubric version, evidence, total, and human override | Pending |
| G-07 | Proposal comparison and saved history | Individual narrative scorecards exist | NOT STARTED | Compare at least three proposals and retrieve prior score versions | Pending |
| G-08 | Recording/transcript intake | Text/document upload and browser speech recognition exist | IN PROGRESS | Process a representative recording or imported transcript with provenance | Pending |
| G-09 | Structured meeting decisions and actions | Meeting agent generates narrative output and stores a document | IN PROGRESS | Persist decisions and owner/task/due-date actions; approve action into task board | Pending |
| G-10 | Cross-meeting themes and next agenda | Per-meeting themes and follow-up agenda are prompted | NOT STARTED | Detect repeated theme and carry unresolved action into next agenda | Pending |
| G-11 | Multi-strategy gap and synergy analysis | RAG/deep research foundations exist | IN PROGRESS | Compare authorized organization strategies with citations and review controls | Pending |
| G-12 | Lean strategic KPI model | No ecosystem KPI schema/dashboard found | NOT STARTED | Eight approved KPIs have definition, baseline, target, owner, source, and period | Pending |
| G-13 | Outcome history and provenance | General SQLite persistence exists | NOT STARTED | Trace KPI value to opportunity/action/evidence and view change history | Pending |
| G-14 | Product evaluation telemetry | API usage is tracked; usefulness/acceptance is not | NOT STARTED | Capture accepted/rejected/acted-on foresight and turnaround/completeness metrics | Pending |
| G-15 | Project/organization access boundary | Project-scoped notebooks exist; enforcement needs acceptance testing | IN PROGRESS | User cannot retrieve another project's private sources through UI, API, or agents | Pending |
| G-16 | Reliable grounded retrieval | Runtime reported sqlite-vec unavailable and inconsistent chunk statistics | BLOCKED | Clean install indexes fixture documents and returns cited scoped results after restart | Blocked by vector dependency/index consistency |
| G-17 | Windows and Linux standalone readiness | Windows development launcher exists | NOT STARTED | Clean Windows and Linux machines install, configure, start, stop, and persist data | Pending |
| G-18 | MVP acceptance suite | Ad hoc verification and historical audit exist | NOT STARTED | Automated/API/UI fixture suite covers the four client workflows | Pending |

## Immediate backlog

Work should be taken in this order unless the user explicitly reprioritizes it.

| Priority | Tracker IDs | Work package | Required deliverable |
|---|---|---|---|
| P0 | G-01, G-02, G-03 | Intelligence data contracts and feed ingestion | Source/signal schemas, migrations, scheduler job, deduplication, cited brief |
| P0 | G-04, G-05 | Opportunity domain and pipeline | Opportunity schema/API/UI with review and audit fields |
| P0 | G-06, G-07 | Versioned proposal rubric | Validated scoring schema, weight configuration, comparison, history |
| P0 | G-09, G-10 | Meeting-to-action workflow | Structured decisions/actions/themes and task promotion |
| P0 | G-12, G-13 | KPI definitions and provenance | Eight KPI definitions, observations, targets, evidence links, dashboard |
| P1 | G-08 | Recording transcription adapter | Local/configurable transcription boundary and provenance |
| P1 | G-11, G-15, G-16 | Grounding and access hardening | Scoped retrieval, vector/index repair, strategy comparison acceptance test |
| P1 | G-14, G-18 | Evaluation and acceptance harness | Usefulness feedback, quality fixtures, API/UI acceptance tests |
| P1 | G-17 | Packaging and portability | Cross-platform configuration, launchers, packaging, clean-machine test |

## Proposed MVP acceptance dataset

Maintain sanitized fixtures suitable for automated and repeatable testing:

- 20–30 RSS/Atom sources with overlapping stories and publication dates
- Google Alerts-compatible sample feed/export
- At least 50 representative signals with expected duplicates and classifications
- 10 proposals with reviewer-approved rubric expectations
- Three meetings, including transcripts and permitted sample recordings
- Three or more organization strategy documents with known gaps and synergies
- KPI baselines, targets, and observation history for the eight approved KPIs

Do not use private client data in committed fixtures.

## Known blockers and risks

| ID | Risk/blocker | Impact | Mitigation/next check |
|---|---|---|---|
| R-01 | `sqlite_vec` was unavailable in the reviewed runtime | Grounded retrieval and strategy comparison may degrade or silently fall back | Define supported dependency versions; add clean-install and index-health checks |
| R-02 | Document metadata and database chunk statistics were inconsistent | UI may claim indexing that is not queryable | Add transactional ingestion verification and repair/reindex command |
| R-03 | LLM outputs are often persisted as narrative Markdown | Scores, opportunities, and actions cannot be reliably queried or measured | Add Pydantic/domain schemas and validation before persistence |
| R-04 | Starting the scheduler can execute overdue tasks | Tests and development starts can create unintended work or API spend | Add development scheduler control and explicit overdue-task policy |
| R-05 | General AI OS features compete with client workflows | Scope drift and weak acceptance demonstration | Enforce `PROJECT_CONSTRAINTS.md` and immediate backlog ordering |
| R-06 | Meeting data can contain sensitive personal and organizational information | Privacy and adoption risk | Project access controls, retention rules, audit log, configurable transcription |
| R-07 | Development configuration contains Windows/localhost assumptions | Standalone Linux packaging becomes costly later | Follow system design portability rules now; add CI on both OS families |

## Decision log

| Date | Decision | Reason | Consequence |
|---|---|---|---|
| 2026-08-02 | Governance documents target Codex and builder agents only | They guide repository development, not AI OS runtime behavior | Do not load or ingest these files into application agents or RAG |
| 2026-08-02 | Use a five-workspace MVP boundary: radar, opportunities, proposals, meetings, KPIs | These directly cover the four task areas and success measurement | Defer unrelated feature expansion |
| 2026-08-02 | Keep the strategic KPI set at eight initially | Meets the client's under-10 constraint and covers stated macro outcomes | Adding/replacing a KPI requires a recorded scope decision |
| 2026-08-02 | Preserve SQLite for the prototype | It is suitable for a local standalone MVP when used with migrations and health checks | Re-evaluate only after measured concurrency/scale evidence |

## Change log

| Date | Builder | Change | Evidence/result |
|---|---|---|---|
| 2026-08-02 | Codex | Created builder governance, constraints, living tracker, and system design guidelines | Files added at repository root; implementation goals baselined from code/API review |
| 2026-08-02 | Codex | Moved the Windows dashboard launcher to the Desktop for easier manual startup | `C:\Users\minns\OneDrive\Desktop\AI OS Launcher\start_dashboard.ps1`; launcher still targets the repository at `C:\Users\minns\OneDrive\Desktop\digiole\AI OS` |
