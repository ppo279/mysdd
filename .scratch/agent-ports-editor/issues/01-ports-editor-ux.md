Status: ready-for-agent

# ConfigView ports editor + output_file disambiguation

> Implements `.scratch/agent-ports-editor/PRD.md`. Read the PRD first — this issue is the implementation breakdown.

## Goal

Replace ConfigView's three text-input fields for `outputs` / `inputs` / `output_file` with a port-aware editor whose visual language matches the canvas (`AgentNode.vue` ports). No backend / schema / route changes. Add color tokens so the editor and the canvas share palette.

## Scope of this issue

Three files of frontend work, one new component, one new test file, and one new CSS file:

### 1. `frontend/src/port-colors.css` (new)

Two CSS custom properties on `:root`:

```css
:root {
  --port-in-color: #94a3b8;
  --port-out-color: #18a058;
}
```

Import this file once in `frontend/src/main.ts` (or whatever file currently does the global CSS import — confirm before editing).

### 2. `frontend/src/components/AgentNode.vue` (modify, ~2 lines)

Replace the two hard-coded colors:

- `.agent-node__handle--in  { background: #94a3b8 !important; }` → `var(--port-in-color)`
- `.agent-node__handle--out { background: #18a058 !important; }` → `var(--port-out-color)`

Also update the two `.agent-node__hlabel--in|out { color: ... }` lines to use the same vars (so the inline label text matches the dot color).

No template change. No script change. Confirm visually that the existing canvas renders identically.

### 3. `frontend/src/components/PortsEditor.vue` (new)

Component contract (matches the decision-rich snippet in the PRD):

```ts
defineProps<{
  inputs: string[]
  outputs: string[]
}>()
defineEmits<{
  'update:inputs': [string[]]
  'update:outputs': [string[]]
}>()
```

Layout:

```
┌─ Canvas preview (mini AgentNode) ────────────────────┐
│  [name]                                               │
│  ●─in1   ●─in2  ……              out1─●  out2─●  ……    │
└───────────────────────────────────────────────────────┘

  ◐ Inputs              ● Outputs
  ┌──────────────┐      ┌──────────────┐
  │ ● name1   ✕  │      │ ● name1   ✕  │
  │ ● name2   ✕  │      │ ● name2   ✕  │
  └──────────────┘      └──────────────┘
  [+ 添加输入]            [+ 添加输出]
```

Implementation notes:

- The canvas preview is a `<div>` with `position: relative`, two side-pseudo-element lists for input dots / output dots, and the agent's display name in the middle. Style with the same `var(--port-in-color)` / `var(--port-out-color)` tokens. Updates live via computed props.
- Each port row: `[colored dot, class=port-row__dot--in|out] [inline-editable name] [✕]`. The name is editable on click; commits on Enter or blur; cancels on Esc.
- The "+ 添加" button opens a transient input row that commits on Enter / blur and cancels on Esc. Trim before committing.
- Validation (UI gate; backend is the source of truth):
  - `name.trim() === ''` → red border + tooltip "端口名不能为空"
  - `name.length > 64` → red border + tooltip "端口名不能超过 64 字符"
  - `/\s/.test(name)` → red border + tooltip "端口名不能含空白"
  - duplicate within the same list → red border + tooltip "端口名重复"
- Empty state: when `inputs` and `outputs` are both `[]`, show a centered message: "未声明任何端口 — 画布上此节点会显示一个 default handle".
- Helper text at the bottom (single line, depth=3): "端口名是画布上节点的连接点；instruction 里可用 `{{ inputs.X }}` / `{{ outputs.X }}` 引用。"

### 4. `frontend/src/components/PortsEditor.test.ts` (new)

Vitest + `@vue/test-utils`. Use the same `NConfigProvider` wrapper and `ResizeObserver` shim pattern as `WorkflowEditorView.test.ts` (read that file first to copy the harness).

Test cases (one per business rule):

- `renders empty state when both lists are empty` — props `{ inputs: [], outputs: [] }`, assert empty-state text.
- `adds an input port when + 添加输入 clicked` — click the button, assert row count `inputs.length + 1`.
- `emits update:inputs on enter` — type a name, press Enter, assert emitted payload.
- `discards in-progress edit on Esc` — type a name, press Esc, assert no emit, no new row.
- `rejects empty port name` — submit empty string, assert error border, no emit.
- `rejects duplicate port name` — pre-seed with `['foo']`, add `'foo'`, assert error border.
- `rejects whitespace in port name` — submit `'a b'`, assert error border.
- `rejects port name > 64 chars` — submit 65 chars, assert error border.
- `canvas preview shows correct input dot count` — props `{ inputs: ['a', 'b'], outputs: ['c'] }`, assert `port-preview__dot--in` count is 2 and `port-preview__dot--out` count is 1.

### 5. `frontend/src/views/ConfigView.vue` (modify)

Five local edits in this file:

**5a.** Replace the two `<NInput>` blocks (currently lines 552-559) with one `<PortsEditor :inputs="agentInputs" :outputs="agentOutputs" @update:inputs="agentInputs = $event" @update:outputs="agentOutputs = $event" />`. Remove `agentOutputsInput` and `agentInputsInput` `ref<string>` declarations; replace with `agentInputs: ref<string[]>([])` and `agentOutputs: ref<string[]>([])`. Update the `parseList` calls in `saveAgent` to use the new refs directly.

**5b.** Update `openAddAgent` and `openEditAgent` to populate the new refs:
- `openAddAgent`: `agentInputs.value = []; agentOutputs.value = []`
- `openEditAgent`: `agentInputs.value = agent.inputs ? [...agent.inputs] : []; agentOutputs.value = agent.outputs ? [...agent.outputs] : []`

**5c.** Update the `output_file` `<NFormItem>` (currently lines 547-549) — rename label to `物理输出文件名`, add `#feedback` slot with the path-template + orthogonality note, and add the "对齐到 outputs[0]" `NButton` (tertiary, size tiny) to the right of the input. The button's disabled predicate: `!agentOutputs[0] || agentOutputs[0] === agentForm.output_file`. The button's click: `agentForm.output_file = agentOutputs[0]`.

**5d.** Update the list card (currently lines 300-305) — replace the two `<NTag>` blocks with:
```vue
<span class="port-mini port-mini--in" v-for="p in (agent.inputs ?? []).slice(0, 3)" :key="`i-${p}`" :title="`输入 · ${p}`">◐ {{ p }}</span>
<span v-if="(agent.inputs ?? []).length > 3" class="port-mini port-mini--in port-mini--more" :title="(agent.inputs ?? []).slice(3).join(', ')">+{{ (agent.inputs ?? []).length - 3 }}</span>
<!-- (mirrored for outputs) -->
```
Add a small `<style scoped>` block in the SFC for `.port-mini--in` / `.port-mini--out` / `.port-mini--more` using the same CSS vars.

**5e.** Update `saveAgent` (around line 203): replace `parseList(agentOutputsInput.value)` and `parseList(agentInputsInput.value)` with `agentOutputs.value` / `agentInputs.value` (already arrays). The "field absent in body" semantics: `outputs: agentOutputs.value.length ? agentOutputs.value : undefined` (same for inputs). This matches the existing PUT schema's `.optional()`.

### 6. `frontend/src/views/ConfigView.test.ts` (modify, ~5-8 assertion updates)

Update the existing tests to match the new modal structure. Concretely:

- The "renders the two handle inputs" test → renamed to "renders a PortsEditor for inputs/outputs". Mount, find the editor by component name (use `findComponent(PortsEditor)`), assert `:inputs` and `:outputs` props are bound to the agent.
- The "saves comma-separated handles" test → renamed to "saves arrays of inputs/outputs". Save an agent, assert the PUT body has `outputs: string[]` and `inputs: string[]` (not strings).
- Add a new test: "output_file field shows 物理输出文件名 label and helper feedback". Find the form item by label, assert feedback text is present.
- Add a new test: "alignment button is disabled when outputs is empty". Set `agentOutputs = []`, assert the button has the disabled attribute.
- Add a new test: "alignment button copies outputs[0] to output_file on click". Set `agentOutputs = ['spec.md']`, `output_file = ''`, click, assert `output_file === 'spec.md'`.
- Add a new test: "list card renders mini port chips". Assert the chip elements exist with the correct color class for each declared port.

### 7. Optional regression guard (small, 5 LoC)

In any existing test that mounts `WorkflowEditorView` (i.e. `WorkflowEditorView.test.ts`, slice 04), add one assertion that the canvas still renders handles after the color-var change. If a `--port-in-color` var is misconfigured, the handle becomes transparent, but `AgentNode` still emits the `<Handle>` element. The structural assertion is "1+ Handle per port declared" — which is the existing assertion in that file. The color change does not affect DOM structure. No new test needed; the existing test continues to guard the canvas.

## Out of scope (this issue)

- Anything in the `backend/` directory.
- Schema changes.
- New routes.
- New dependencies in `package.json`.
- `WorkflowEditorView.vue` changes.
- `AgentNode.vue` template or script changes (only CSS values).
- Canvas-side port editing.
- Reorder / drag-to-reorder of port rows.
- Per-port typing (data type) — all ports remain name-only.

## Acceptance criteria

1. `npm run type-check` (frontend) passes.
2. `npm test` (frontend) passes — both new and existing tests.
3. Opening `/config` and editing an agent shows the new ports editor with the canvas preview.
4. Adding a port shows a colored dot in the preview that matches the canvas's dot color.
5. Saving the agent and opening `WorkflowEditorView` shows the new port as a `<Handle>` on the node.
6. Renaming `output_file` and clicking "对齐到 outputs[0]" copies the value; clicking again (when already aligned) is a no-op.
7. The list card shows colored mini-chips with the same colors as the canvas, collapsing at 3.
8. No console errors, no Vue warnings.

## Definition of done

- All six file changes merged in a single PR.
- `git status` clean (no untracked test fixtures, no leftover commented-out code).
- PRD is updated to reference the merged commit SHA (one line: "Merged in commit `<sha>`").
- This issue file's `Status:` line flipped to `wontfix` is **not** the path; leave as `ready-for-agent` until the PR lands, then update to point at the merged commit.
