# Task Lifecycle and Deep Research Mode — 2026-08-01

## Scheduled-task lifecycle

- **Pending** contains only scheduled tasks that have not started. Users can delete a specific pending task.
- Dragging a Pending task to **Running**, or choosing **Run now**, claims and starts that task immediately. Only one runner can claim a task.
- **Archive** contains completed and failed executions. Each archived task retains its complete response or error, rather than only a short placeholder summary.
- **View result** opens the archived output and its run history.
- **Run again** creates a new task version, preserves the original record, and starts the new version immediately. Version lineage records the root task, parent task, and version number.

## Time handling and UI synchronization

- Browser-local schedule input is converted to a timezone-aware UTC timestamp before it reaches the backend.
- The user’s IANA timezone is stored with the task for context; all Kanban timestamps are rendered in the browser’s local timezone with a timezone label.
- Legacy timestamps continue to be interpreted by the scheduler as local legacy values.
- Task state changes broadcast `KANBAN_TASK_UPDATED` over the existing WebSocket channel; five-second polling remains as a fallback.

## Deep Research mode

- Deep Research is now a selectable chat mode beside the existing research context controls, not a separate button beside Send.
- With the mode off, Enter/Send performs ordinary Manager reasoning.
- With the mode on, Enter/Send starts the persisted Deep Research workflow with the existing user-visible action trail, steering, and safe-stop controls.
- The workflow now performs two bounded evidence-verification/refinement passes after the initial synthesis. It removes or qualifies claims unsupported by captured sources, rather than promising impossible certainty or running indefinitely.

## Verification

- Python compilation passed.
- TypeScript no-emit checking passed.
- Local lifecycle smoke test passed: start, archive, versioned rerun creation, UTC schedule normalization, and pending-task deletion.
- Local Deep Research smoke test passed: steering plus cancellation stops before any provider or public-web call.
