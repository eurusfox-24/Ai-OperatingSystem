# Forest Joensuu AI OS — MVP Project Constraints

> Status: paused on 2026-08-02. Retained as future planning material, not active builder instructions.

## 1. Product objective

Build a client-testable strategic intelligence MVP for the Forest Joensuu ecosystem.
The product must turn external and internal information into traceable opportunities,
prioritized decisions, meeting actions, and a lean view of ecosystem outcomes.

The required operating loop is:

`Sources -> Signals -> Opportunities -> Decisions -> Actions -> KPI outcomes`

An isolated chatbot response, agent demo, or generated report does not by itself
complete this loop.

## 2. Primary users

- Forest Joensuu and Business Joensuu ecosystem leadership
- Economic development, investment, startup, and RDI programme staff
- Meeting and workshop facilitators
- Authorized representatives of participating organizations

## 3. Mandatory MVP task areas

### A. Operating environment and trend analysis

The MVP must:

- Ingest configured RSS/Atom feeds and Google Alerts-compatible feeds or exports.
- Poll sources on a schedule without requiring a chat prompt.
- retain source URL, title, publisher, publication/fetch time, and evidence text;
- Deduplicate repeated stories and classify signals by topic, geography, and relevance.
- Produce a cited daily or weekly brief that highlights what changed.
- Allow a human to accept, reject, or promote a signal.

### B. Opportunity identification

The MVP must convert relevant signals into structured opportunity records for:

- business and investment leads;
- RDI programmes and funding calls;
- ecosystem collaboration and partnership leads;
- startup scaling and capital opportunities.

Every opportunity must contain a type, summary, evidence/source, organization or
programme, deadline when known, regional rationale, estimated impact, confidence,
owner, status, and next action. Opportunities must support deduplication and a simple
pipeline: `Detected -> Qualified -> Assigned -> In progress -> Won/Lost`.

### C. Idea structuring and prioritization

Every proposal must be scored using the same versioned rubric:

1. Strategic fit
2. Regional impact
3. Feasibility
4. Resource needs
5. Risk level
6. Scalability
7. Economic and job impact

The rubric must support configurable weights, evidence and reasoning per criterion,
an overall normalized score, comparison between proposals, saved score history, and
an auditable human override. Persisted scores must be validated structured data, not
only Markdown produced by an LLM.

### D. Meeting and workshop support

The MVP must:

- Accept text transcripts and common meeting recording formats.
- Produce a transcript or accept an externally produced transcript.
- Generate an executive summary, decisions, recurring themes, action items, and next agenda.
- Store action owner, task, due date, source meeting, and status as structured fields.
- Promote approved actions to the task workflow.
- Detect recurring themes and unfinished actions across multiple meetings.

## 4. KPI and success constraints

The client-facing strategic dashboard must contain fewer than 10 high-impact KPIs.
The initial approved working set is:

1. Private-sector jobs committed or created
2. Forest-bioeconomy revenue/value-add growth
3. Qualified investment leads and pipeline value
4. New corporate Invest-In cases
5. Delegation-to-qualified-case conversion
6. Startups advancing funding stage and capital raised
7. RDI funding applied for and secured
8. Strategic opportunities converted into assigned actions

Every KPI requires a stable definition, unit, baseline, target, reporting period,
owner, source, update frequency, current value, and evidence/provenance. Forecast,
committed, and realized values must not be mixed.

MVP evaluation must also demonstrate:

- **Actionable foresight:** users can rate recommendations useful, rejected, or acted upon.
- **Strategic alignment:** the system identifies gaps and synergies across authorized strategy documents.
- **Operational efficiency:** agenda, summary, action, and scoring outputs are complete and timely.
- **Metric streamlining:** the dashboard remains under 10 strategic KPIs.

## 5. Product principles

- Evidence before eloquence: important factual claims link to captured sources.
- Structured records before prose: prose explains records; it does not replace them.
- Human accountability: AI proposes and humans approve consequential classifications, scores, and commitments.
- Traceability: users can navigate from KPI/action/opportunity back to its evidence and decision.
- Bounded automation: scheduled collection and analysis are allowed; consequential external actions require approval.
- One coherent workspace: avoid duplicate sources of truth for opportunities, actions, proposals, and KPIs.
- Client value over agent count: a new agent is justified only when an existing component cannot own the workflow cleanly.

## 6. MVP non-goals and deferred work

Unless explicitly required to complete an MVP acceptance flow, defer:

- Pixel-office or game-like visualization improvements
- Webcam/avatar experiences
- A public plugin or agent marketplace
- Broad provider-management features beyond reliable configured providers
- Arbitrary autonomous browser actions or shell execution
- Complex enterprise integrations before import/export boundaries are proven
- Distributed microservices, Kubernetes, or premature horizontal scaling
- Mobile-native applications
- Replacing SQLite before measured scale or concurrency requires it

Existing deferred features may remain, but builder agents must not prioritize their
expansion over the required MVP workflows.

## 7. Data and governance constraints

- Client documents, strategies, recordings, transcripts, and contacts are private by default.
- Access boundaries must be enforceable by organization/project, not only described in prompts.
- Secrets must come from configuration or secret storage and never be committed.
- Store source and model provenance for generated records.
- Record human approvals and overrides with actor and timestamp.
- Define retention and deletion behavior for recordings, transcripts, and derived content.
- Do not transmit client data to a new external service without explicit configuration and authorization.

## 8. Definition of MVP complete

The MVP is complete only when all four task areas can be demonstrated end to end
with representative client data and the eight KPI definitions are visible in one
dashboard. Each workflow must persist structured results, preserve evidence, support
human review, survive restart, and pass the acceptance checks recorded in
`PROJECT_TRACKER.md`.

A feature is not complete merely because code exists, a route responds, or an LLM
can produce a plausible answer in chat.

## 9. Scope-change rule

Any proposed feature that does not clearly advance a mandatory task area, evaluation
criterion, portability requirement, security requirement, or verified defect must be
treated as out of scope until the product owner approves it. Approved material scope
changes must be recorded in the tracker decision log.
