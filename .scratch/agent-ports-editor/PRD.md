# Make agent port editing match the canvas (ConfigView PortsEditor)

> Slice 9 of `agent-contract-db`. Builds on slices 03 (port validation) and 04 (runtime contract): those slices pinned the *truth* — `agents.outputs` / `agents.inputs` as the single source of port names, consumed read-only by `WorkflowEditorView`. This slice fixes the *entry point* — ConfigView — so the user can author ports with the same visual language they see on the canvas.

## Problem Statement

In `ConfigView`, the three fields that carry a port contract are all rendered as bare `<NInput>` text boxes with `split(',')` parsing:

- `outputs` — labeled "输出 handle（逗号分隔）", `default` placeholder
- `inputs` — labeled "输入 handle（逗号分隔）", `default` placeholder
- `output_file` — labeled "输出文件", a single file-name field

This is wrong on three axes:

1. **The visual doesn't match what it represents.** A port is a node-edge endpoint on the vue-flow canvas (drawn by `AgentNode.vue` as a green/gray circle with a label). Editing a port list as a comma-separated string forces the user to mentally re-render the canvas from text. There's no cue that the strings they type will become colored circles.
2. **Two orthogonal concepts share a column.** `output_file` is the **physical filename** persisted to `storage/<ws>/<featureId>/<outputFile>`. `outputs` is the **logical port name** used in prompt templates (`{{ outputs[0] }}`), graph edges (`workflow_edges.from_output`), and the validation contract (`validateWorkflowPorts`). Same panel, same column, no signal of difference — users conflate them.
3. **Adding, removing, and renaming ports is a string operation.** No per-port edit, no validation feedback inline, no guard against duplicates or whitespace, no preview of the resulting canvas shape.

The port contract is already runtime-grade (slice 03). What this PRD fixes is the **authoring experience** to match.

## Solution

Introduce a new `PortsEditor` component that:

- Renders one row per port, with a colored dot (gray for input, green for output — same `#94a3b8` / `#18a058` used by `AgentNode`) and an inline editable name. Empty rows are not allowed; duplicates are flagged; whitespace is rejected.
- Shows a miniature "canvas preview" of the current agent as it would appear on the canvas — a tiny `AgentNode`-shaped card with the agent's display name in the middle, the configured input dots on the left, output dots on the right, port names labeled. Updates live as the user edits.
- Renders an empty state explaining that an empty list means "no port declared — the canvas will show a single `default` handle."

Wire `PortsEditor` into `ConfigView`'s agent edit modal in place of the two text fields. Add an empty-state hint, a "rename inline" affordance, and a "this matches what the canvas shows" tooltip.

Tighten the `output_file` field:

- Rename label to **物理输出文件名** and add a permanent feedback line stating the disk path template + a one-sentence note that this is **orthogonal to** `outputs` (logical port name).
- Add a **"对齐到 outputs[0]"** button that copies `outputs[0]` into `output_file` if both are non-empty and not already equal. Disabled otherwise. Non-destructive and reversible (the user can edit either side afterward).

Update the agent list card on the main `ConfigView` page to render ports as mini port chips (`◐ in-name` / `● out-name`), with the same gray/green tokens. Collapse to `+N` when the port count exceeds 3, with the full list in a tooltip on hover.

Tokenize the port colors: extract `#94a3b8` and `#18a058` from `AgentNode.vue` into a single CSS file (`frontend/src/port-colors.css`) and reference them via `var(--port-in-color)` / `var(--port-out-color)` from both `AgentNode` and `PortsEditor`. This is the seam-keeping change that prevents "edit canvas color, forget to sync editor color" drift.

No backend changes. No schema changes. No new dependencies. `outputs: string[]` / `inputs: string[]` field shapes preserved on the wire.

## User Stories

### Ports 编辑（核心）

1. As an agent author, I want to add an output port with a single click, type a name, and see a green dot appear in the canvas preview, so that I know exactly what the canvas will draw.
2. As an agent author, I want to rename a port inline (click name, edit, blur to commit), so that I don't have to delete + recreate to fix a typo.
3. As an agent author, I want to delete a port with a single click, so that the operation is reversible in muscle memory.
4. As an agent author, I want duplicate port names flagged inline (red border + tooltip "端口名重复") so that I cannot save a contract that will fail `validateWorkflowPorts` on the next workflow save.
5. As an agent author, I want whitespace-only port names rejected, so that I don't accidentally create a port that exists in name only.
6. As an agent author, I want the canvas preview to update live as I type, so that the form and the canvas are always in sync.
7. As an agent author with no declared ports, I want to see a clear empty state ("未声明任何端口 — 画布上此节点会显示一个 default handle") so that I know the default-handle behavior is intentional, not missing.
8. As an agent author, I want port names to be visually anchored by a colored dot (gray for input, green for output) so that the type is unambiguous at a glance — matching the canvas.
9. As an agent author, I want a single line of helper text explaining "ports are the same names you see as handles on the canvas, and they're available in `instruction` as `{{ inputs.X }}` / `{{ outputs.X }}`" so that I don't have to open the canvas to remember the rule.
10. As an agent author, I want port editing to be a no-op when the port list is empty and I haven't added anything, so that the form doesn't fail validation on a brand-new agent.

### `output_file` 字段（与 outputs 区隔）

11. As an agent author, I want the field label to read "物理输出文件名" with a feedback line "→ 写到 `storage/<ws>/<featureId>/<文件名>`", so that the disk-side role is unambiguous.
12. As an agent author, I want a one-line note in the feedback stating "与 outputs 正交：outputs 是逻辑端口名（用于画布连接和 prompt 引用）" so that the two fields' relationship is explicit.
13. As an agent author, I want a "对齐到 outputs[0]" button that copies the first output port's name into the physical filename, so that the common case (one port = one file of the same name) takes one click.
14. As an agent author, I want the alignment button disabled when `outputs` is empty or `outputs[0] === output_file`, so that I don't click it uselessly.
15. As an agent author, I want the alignment button to be reversible (just edit `output_file` afterward), so that I'm not afraid to use it.

### 列表卡片（主页）

16. As a workspace owner scanning the agent list, I want each agent's port list rendered as colored mini chips (`◐ in` / `● out`) so that I can tell input from output at a glance.
17. As a workspace owner, I want the chip row to collapse to `+N` when an agent has more than 3 ports of one side, with the full list in a hover tooltip, so that the list doesn't get visually noisy.
18. As a workspace owner, I want the same gray/green color tokens as the canvas, so that the list and the canvas read as the same thing.

### 跨产品一致性

19. As a developer, I want the port color tokens to live in one CSS file (`port-colors.css`) so that the canvas and the editor can't drift.
20. As a user, I want any visual change to ports to require only one CSS edit, so that future palette changes are atomic.

### 不破坏既有契约

21. As a developer, I want `outputs` / `inputs` to remain `string[]` on the wire, so that no backend, route, or schema change is needed.
22. As a developer, I want the ConfigView's internal state to change from `Ref<string>` to `Ref<string[]>`, with save-time logic that omits empty arrays (preserving current "field absent in body" semantics).
23. As a developer, I want existing `ConfigView.test.ts` assertions to be updated, not deleted, so that the test suite still guards the contract.
24. As a workflow author, I want the editor to keep working after this change, so that opening an existing workflow still draws the same ports on the canvas as before.

### 可达性 / 健壮性

25. As a keyboard user, I want to tab through the port rows and reach the delete / rename affordances, so that the editor is operable without a mouse.
26. As an agent author, I want port names capped at 64 characters (matching the `AgentNode` label max-width) so that very long names don't break the canvas.

## Implementation Decisions

### New component shape (decision-rich snippet)

```ts
// frontend/src/components/PortsEditor.vue (script section)
const props = defineProps<{
  inputs: string[]
  outputs: string[]
}>()
const emit = defineEmits<{
  'update:inputs': [string[]]
  'update:outputs': [string[]]
}>()

// Validation rules (shared by both lists):
// - non-empty after trim
// - no duplicates within the same list (inputs and outputs validated separately)
// - length <= 64 chars
// - no whitespace in the middle
const validationError = (name: string, list: string[]): string | null => {
  if (!name.trim()) return '端口名不能为空'
  if (name.length > 64) return '端口名不能超过 64 字符'
  if (/\s/.test(name)) return '端口名不能含空白'
  if (list.filter(n => n === name).length > 1) return '端口名重复'
  return null
}
```

The component is two side-by-side panels (Inputs on the left, Outputs on the right) — visually mirroring `AgentNode`'s left-handle / right-handle arrangement — with a miniature canvas preview strip above. Each row is `[colored dot] [inline-editable name] [✕]`. Adding opens an inline editor that commits on Enter or blur, cancels on Esc.

### Color tokens (DRY seam)

`frontend/src/port-colors.css` (new file) declares two CSS custom properties on `:root`:

```css
:root {
  --port-in-color: #94a3b8;   /* matches AgentNode's input handle */
  --port-out-color: #18a058;  /* matches AgentNode's output handle */
}
```

`AgentNode.vue` replaces the two hard-coded values with `var(--port-in-color)` / `var(--port-out-color)`. `PortsEditor.vue` uses the same vars. `ConfigView.vue` mini-chip rendering uses the same vars. This is the one change that prevents future drift.

### `output_file` field shape

- Label: `物理输出文件名`
- `NInput` placeholder: `如 spec.md`
- Permanent feedback (under the input): "→ 写到 `storage/<ws>/<featureId>/此文件名` · 与 outputs 正交：outputs 是逻辑端口名（用于画布连接和 prompt 引用）"
- An "对齐到 outputs[0]" `NButton` (size `tiny`, type `tertiary`) immediately to the right of the input. Disabled when `agentOutputs[0]` is empty or already equal to `output_file`. On click, sets `output_file = agentOutputs[0]` (no confirmation dialog — single-step, reversible).

### List card mini-ports

Replace the existing `<NTag v-if="agent.outputs?.length">out: …</NTag>` and the matching `in:` tag with a row of `<span class="port-mini port-mini--in|out">◐ name</span>` elements. Cap visible chips at 3 per side; the 4th onward collapses into a `+N` chip with a `NTooltip` listing the rest. Click on a chip is a no-op (visual only — the edit affordance stays on the row's `编辑` button).

### What does NOT change

- `AgentConfig.inputs: string[]` / `AgentConfig.outputs: string[]` types — preserved
- `routes/config.ts` PUT schema — preserved (`outputs` / `inputs` are `.optional()`, same as today)
- `services/workflow.ts:validateWorkflowPorts` — preserved (slice 03)
- `WorkflowEditorView.vue` — preserved (still reads `agent.outputs` / `agent.inputs` from DB on load)
- `AgentNode.vue` template/structure — preserved (only the two color values become vars)
- DB schema — preserved
- Backend code — preserved
- Dependencies — preserved (no new packages)

### File-level diff footprint (informational only — may drift)

| File | Status | Notes |
|---|---|---|
| `frontend/src/port-colors.css` | new | 2 CSS vars |
| `frontend/src/components/PortsEditor.vue` | new | ~200 LoC component |
| `frontend/src/components/PortsEditor.test.ts` | new | vitest + @vue/test-utils |
| `frontend/src/components/AgentNode.vue` | modified | 2 lines: replace hard-coded colors with vars |
| `frontend/src/views/ConfigView.vue` | modified | replace 2 inputs, add canvas preview, list-card chip row, output_file field |
| `frontend/src/views/ConfigView.test.ts` | modified | update assertions for the new modal structure and list-card chips |
| `frontend/src/main.ts` (or wherever global CSS is loaded) | modified | import `port-colors.css` once |

## Testing Decisions

### What makes a good test (apply across both seams)

- **Test external behavior, not implementation.** Render the component, assert on DOM: that the correct number of port rows exists, that clicking "+ 添加" produces a new row, that the canvas preview shows the right dots. Do not assert on private refs, internal state, or event-emission order beyond what the contract requires.
- **One rule per test.** `PortsEditor.test.ts` should have separate tests for: "rejects whitespace in name", "rejects duplicate name", "rejects name > 64 chars", "emits `update:inputs` on commit", "renders empty state when list is empty". Don't bundle.
- **No snapshot tests.** They hide regressions in dense DOM. Use targeted assertions on class names and visible text.

### Seam 1: `ConfigView.test.ts` (integration, existing)

Asserts on the rendered agent edit modal:

- The two original `<NInput>` for "输出 handle" / "输入 handle" no longer exist.
- A `<PortsEditor>` is rendered with `:inputs` bound to the agent's `inputs` and `:outputs` bound to the agent's `outputs`.
- The `output_file` field has the new label `物理输出文件名` and the helper feedback is visible.
- The "对齐到 outputs[0]" button is disabled when `outputs` is empty, enabled when `outputs[0]` differs from `output_file`.
- The list card renders mini-chips for each port with the correct color class.
- Saving an agent after editing ports still produces the correct PUT body shape (`outputs: string[]` / `inputs: string[]`).

### Seam 2: `PortsEditor.test.ts` (unit, new)

Asserts on the component contract:

- Empty `inputs` and `outputs` props → empty state visible.
- Clicking "+ 添加输入" → input row count increases by 1.
- Typing a name and pressing Enter → emits `update:inputs` with the new array, no in-progress leftover row.
- Typing a name and pressing Esc → discards the in-progress edit.
- Two ports with the same name → second one shows error border + tooltip "端口名重复"; saving still emits the list (validation is a UI gate, not a hard block — the backend is the source of truth, and the existing PUT schema will already reject bad shapes).
- Port name with whitespace → error border + tooltip.
- Port name > 64 chars → error border + tooltip.
- Canvas preview: the count of input dots equals `props.inputs.length`, the count of output dots equals `props.outputs.length`.

### Modules covered

- `components/PortsEditor.vue` (new) — covered by Seam 2.
- `views/ConfigView.vue` (modified) — covered by Seam 1.
- `components/AgentNode.vue` (color change) — *not* re-tested. The change is a string-substitution on two lines; the existing `WorkflowEditorView.test.ts` (slice 04) renders `AgentNode` and would catch a regression where a color var misresolves to a transparent / default value, since the existing assertions don't depend on color but on DOM structure. We add one targeted assertion that `--port-in-color` is defined (CSS module loaded).

### Prior art in this repo

- `frontend/src/views/ConfigView.test.ts` (existing, see `git status`) — uses `@vue/test-utils` `mount`, `NConfigProvider` wrapper, ResizeObserver shim. New assertions follow the same shape.
- `frontend/src/views/WorkflowEditorView.test.ts` (slice 04) — same harness; reusing the `NConfigProvider` + `ResizeObserver` shim pattern.
- `backend/src/config/agents.test.ts` (slice 07) — precedent for testing DB-derived config; out of scope for this PRD (no backend changes).

## Out of Scope

1. **Canvas-side port editing.** `WorkflowEditorView` reads `agents.outputs` / `agents.inputs` on mount and treats them as read-only. Letting the canvas *create* ports is a separate PRD and would re-introduce the dual-source-of-truth bug that slice 03 fixed.
2. **Renaming `outputs` / `inputs` field names on the wire.** The shape stays `string[]`; only the ConfigView representation changes.
3. **Per-port typing (data type, schema).** All ports are currently just names. Adding `outputs: [{ name, type }]` is a future feature, gated on a real use case (e.g. JSON Schema for structured outputs).
4. **Optional input ports.** Out of scope per existing decision (slice 03 chose all-required). `inputs: [{ name, required: false }]` is deferred.
5. **Live cross-session sync.** If the user edits ports in ConfigView and then opens a new tab, they see stale data until reload. The existing PUT handler already `clearCache()`s the agents module; a broadcast mechanism is a separate concern.
6. **In-place canvas ↔ editor hot-reload.** Opening a `WorkflowEditorView` after editing ConfigView should be reloaded by the user (existing behavior). This PRD does not add a watch/event that pushes port changes into an already-open editor.
7. **Backend validation tightening.** `validateWorkflowPorts` already rejects bad shapes. This PRD does not add new server-side rules; it surfaces them in the editor.
8. **Reordering ports.** `handleTop` in `AgentNode` distributes handles by array order, but reordering is not exposed in the editor in this slice. Drag-to-reorder is a future feature.
9. **Schema / migration / new endpoints.** None needed; this is a UI-only change.

## Further Notes

### Linkage to existing decisions

- **`.scratch/agent-contract-db/PRD.md` slices 03 + 04** established ports as a runtime contract. This PRD (slice 9 of the same umbrella) is the **authoring counterpart**: ports can finally be authored in the editor with the same fidelity they're enforced at runtime.
- **`docs/adr/0001-workflow-execution-model.md` turn 9** said "agents are edited as a structured form." This PRD is the structured-form upgrade that form deserves.
- **CONTEXT.md** decisions 4 (Side outputs) and 5 (Edge shape) are unchanged; this PRD only changes the **editor** of the agent definition, not the workflow graph or storage shape.

### Backward compatibility

- All existing agent rows in the DB continue to load; the editor now renders them as ports (previously shown as comma-separated text in the list card). No data migration.
- The `outputs: ['default']` quirk from pre-slice-07 configs: `loadAgentsConfig` already normalizes `[]` on read. `PortsEditor` will show the same empty list for those rows. Users on a pre-slice-07 DB who actively used `['default']` will see one fewer port in the editor — but the canvas still draws a single default handle (slice 07 semantics). The editor's empty-state message explains this.

### Risks

1. **Color token misconfiguration.** A typo in `port-colors.css` (or a missing import in `main.ts`) would make ports invisible (transparent) on both the canvas and the editor — silent regression. Mitigation: add a one-line test that the CSS module is loaded (`document.documentElement.style.getPropertyValue('--port-in-color')` returns the expected hex).
2. **Reordering churn during edit.** If the user is in the middle of editing port X and a workflow save from another tab changes port X's name, the in-progress edit gets overwritten on reload. This is a pre-existing concurrent-edit risk; out of scope for this PRD.
3. **Long port names breaking layout.** `AgentNode` truncates label display at 64px width with ellipsis. The 64-char cap in `PortsEditor` matches the canvas behavior.
4. **Color-blind accessibility.** Green vs. gray is a luminance pair; users with red-green deficiency can still distinguish by position (left vs. right) and by the textual direction. Acceptable for an internal tool. The chip's text label carries the meaning if color doesn't.

### Out-of-PRD visual touches considered and rejected

- Drag-to-reorder port rows: nice-to-have, not in this slice.
- Multi-line port names: rejected — canvas labels are single-line.
- Color picker for port types: rejected — all ports are name-only for now.
- Inline regex helper for port naming rules: rejected — over-engineering for a name that goes into a string array.

### Why this is "intellectually honest"

- Doesn't pretend `outputs` is just a prompt variable (it's also a graph port).
- Doesn't pretend `output_file` and `outputs` are the same (they're not).
- Doesn't add canvas-edit ports (slice 03 closed that escape hatch for a reason).
- Doesn't introduce a new dep, a new route, a new schema, or a new port-type system.
- Limits blast radius to `frontend/src/components/PortsEditor.vue` (new), `AgentNode.vue` (2 lines), `ConfigView.vue` (modal + list card), and their tests.
