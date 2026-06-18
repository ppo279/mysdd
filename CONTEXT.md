# sdd-multiagent — Domain Glossary

> Captured live during the `/grill-with-docs` session on the agent + workflow redesign.
> Definitions only — no implementation detail, no decisions that aren't yet resolved.

## Working concepts (provisional, pending ADR)

**Agent**:
A single role in the SDD pipeline. Has an instruction (system prompt), a runtime (which CLI executes it), config items (per-agent tunables set at edit time), named inputs (the artifacts it needs from upstream), and named outputs (its artifacts, possibly more than one). Today defined in `agents.yaml`; the redesign lets users author and edit them in the UI.

**Workflow**:
A named, reusable directed-graph template that wires agents together. Each edge is a named binding `{from, fromOutput, to, toInput}` that says "B's input `X` is fed by A's output `Y`". Scoped to a workspace; a workspace owns a library of named workflows. Replaces the implicit linear order of today's `agents` array.

**Node** (in a workflow):
A workflow-scoped instance of an agent. The same agent can appear multiple times in one workflow (each instance is a separate node with a different nodeId). The nodeId is the primary key within a workflow; it is what edges connect.

**Side output**:
One of an agent's named outputs. Multiple per agent. Each is a path on disk under the feature's storage directory. A side output is approved independently of the agent's other outputs (semantics pending — see "approve" question below).

## Decisions captured (this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Execution model | DAG (dataflow semantics, single-line execution for now) |
| 2 | Workflow scope | Per-workspace library, feature can switch |
| 3 | Per-agent config | P2 — set at edit time, injected at runtime |
| 4 | Side outputs | I/O 3 — multiple named outputs per agent |
| 5 | Edge shape | E2 — named binding `{from, fromOutput, to, toInput}` |
| 6 | Editor | E-C — form for agent, canvas for workflow |
| 7 | Feature state model | S2 — `feature_node_states` per-node map |
| 8 | Switch workflow semantics | SW2 — remap on switch, persist `feature_node_migrations` |
| 9 | nodeId scope | N2 — workflow-scoped (not global agentId) |
| 10 | Remap mechanism | M3 — user-confirmed mapping with auto-suggestion by (agentId, position) |
| 11 | Workflow storage | ST2 — workflow in SQLite, agent in YAML |
| 12 | Approve granularity | AP3 — batch with per-output override |
| 13 | Path convention | P2 — `storage/<wsId>/<featId>/<nodeId>/<outputName>` |
| 14 | Migration | MG1 — big bang, no auto-migration |
