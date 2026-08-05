# Project: AI OS Deep Full-System Audit

## Architecture
AI OS full-system audit covering:
1. Python backend & FastAPI routes (`kernel/`, `server.py`, engines, API endpoints).
2. Frontend TS/React/UI components, state management, console errors, E2E UI flow.
3. SQLite database schema, integrity, constraints, WAL mode, indices, workspace storage (`data/kernel_workspace.db`).
4. Kernel skills architecture (`kernel/agents/skills/`, `.agents/skills/`, dynamic loading, SKILL.md specs).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Deep Codebase & System Audit | Multi-track investigation of Python backend, TS/UI frontend, SQLite DB integrity, skills architecture, and Browser Agent testing | none | DONE |
| 2 | Deliverable Generation | Synthesize finding reports, document reproducible bugs with precise file paths and lines, and write `Changes Report/audit_report_2026-08-01.md` | M1 | DONE |
| 3 | Review, Challenge & Forensic Verification | Independent review, bug reproduction verification, and forensic audit of report accuracy | M2 | DONE |

## Interface Contracts & Requirements
- Deliverable: `Changes Report/audit_report_2026-08-01.md` (Created & Verified)
- Required Bugs: At least 3 objectively reproducible bugs/flaws with file paths and line numbers (16 detailed & verified)
- Browser Testing: Document console errors, UI state anomalies, and browser test results (Included in Section 2 & 4)
- Methodology: Document testing methodology, static analysis, DB checks, and UI test flows (Documented in Section 2)

## Code Layout
- `kernel/` - Core Python backend, server, agent runtime, skills engine
- `src/` / UI - Frontend TS/React components
- `data/kernel_workspace.db` - SQLite database
- `.agents/skills/` & `kernel/agents/skills/` - Kernel skills
- `Changes Report/` - Technical reports & audit deliverable repository (`audit_report_2026-08-01.md`)
