# Interactive Workflow Controls — 2026-08-01

## Delivered

Deep Research now exposes a user-visible, persisted workflow trail in the Boardroom:

- Current high-level agent action and overall status.
- Completed, running, cancelled, and failed workflow steps.
- A **Steer** control that queues a bounded user direction for the next safe step.
- A **Stop** control that cooperatively cancels before the next safe step and records the request in the audit trail.
- WebSocket workflow updates, with polling retained as a resilient fallback.
- Existing standard chat requests now run through the base Manager-agent lifecycle, so the existing Agent telemetry also shows Manager and delegated-agent activity.

## Safety model

- The interface reports observable actions only; it does not reveal model chain-of-thought or private provider reasoning.
- Stop is cooperative: it cannot safely interrupt an already-running blocking provider or web request, but it prevents the next step from beginning.
- Steering is explicit user task context. It does not grant new tools, access to other projects, broader network access, or arbitrary execution.
- Research remains bounded to selected notebook sources, a limited public-web search, and evidence synthesis. Existing approval requirements remain in force for sensitive future capabilities.

## Persistence

The existing `autonomous_tasks` record now stores cancellation state and the latest high-level action. A new `autonomous_task_controls` audit table stores steering and stop requests. The task detail API returns steps, controls, artifacts, and status so the dashboard can recover after a refresh.

## Verification

- `python -m compileall -q kernel` passed.
- TypeScript no-emit check for `ui/src/main.ts` and `ui/src/socket.ts` passed.
- Local workflow smoke test passed: steering was persisted, cancellation was requested, and the runner stopped at its first safe boundary before any provider or public-web operation.
- `npm.cmd run build` remains blocked by the workstation's esbuild directory-access restriction (`Cannot read directory ../../../../..`), not by a TypeScript diagnostic.
