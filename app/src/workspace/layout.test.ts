import assert from "node:assert/strict";
import test from "node:test";
import {
  activateWorkspacePanel,
  createWorkspacePreset,
  hideWorkspacePanel,
  moveWorkspacePanel,
  resizeWorkspaceSplit,
  showWorkspacePanel,
  validateWorkspaceLayout,
  visiblePanelIds,
  type WorkspaceLayout,
} from "./layout";

const panels = ["editor", "outline", "inspector", "history", "review", "module:terms"];

function clone(layout: WorkspaceLayout): WorkspaceLayout {
  return JSON.parse(JSON.stringify(layout)) as WorkspaceLayout;
}

test("presets are valid editable trees with the expected panel selections", () => {
  const writing = createWorkspacePreset("writing", panels);
  const research = createWorkspacePreset("research", panels);
  const review = createWorkspacePreset("review", panels);

  assert.equal(validateWorkspaceLayout(writing), true);
  assert.equal(writing.root.type, "split");
  assert.deepEqual(visiblePanelIds(writing.root), ["outline", "editor", "inspector"]);
  assert.deepEqual(writing.root.type === "split" ? writing.root.sizes : [], [18, 60, 22]);
  assert.deepEqual(writing.hiddenPanelIds, ["history", "review", "module:terms"]);
  assert.equal(research.root.type, "split");
  assert.deepEqual(visiblePanelIds(research.root), ["editor", "outline", "inspector", "module:terms"]);
  assert.deepEqual(research.root.type === "split" ? research.root.sizes : [], [68, 32]);
  assert.equal(research.root.type === "split" ? research.root.children[1]?.type : undefined, "stack");
  assert.equal(research.root.type === "split" && research.root.children[1]?.type === "stack"
    ? research.root.children[1].activePanelId : undefined, "inspector");
  assert.ok(visiblePanelIds(review.root).includes("review"));
  assert.ok(!visiblePanelIds(review.root).includes("history"));
  assert.ok(review.hiddenPanelIds.includes("history"));
});

test("validation rejects malformed, duplicate, oversized, deep, and executable-looking state", () => {
  const valid = createWorkspacePreset("writing", panels);
  const duplicate = clone(valid);
  duplicate.root = {
    type: "split",
    id: "split-duplicate",
    direction: "horizontal",
    sizes: [50, 50],
    children: [{ type: "leaf", panelId: "editor" }, { type: "leaf", panelId: "editor" }],
  };
  duplicate.hiddenPanelIds = [];
  assert.equal(validateWorkspaceLayout(duplicate), false);

  const extraProperty = { ...valid, manuscript: "not workspace data" };
  assert.equal(validateWorkspaceLayout(extraProperty), false);
  assert.equal(validateWorkspaceLayout({ ...valid, version: 2 }), false);
  assert.equal(validateWorkspaceLayout({ ...valid, hiddenPanelIds: [...valid.hiddenPanelIds, "bad id"] }), false);

  const oversizedIds = createWorkspacePreset("writing", Array.from({ length: 65 }, (_, index) => `panel${index}`));
  assert.equal(validateWorkspaceLayout(oversizedIds), false);

  let deep: WorkspaceLayout["root"] = { type: "leaf", panelId: "editor" };
  for (let index = 0; index < 14; index++) {
    deep = {
      type: "split",
      id: `split-${index + 1}`,
      direction: "horizontal",
      sizes: [50, 50],
      children: [deep, { type: "leaf", panelId: `panel${index}` }],
    };
  }
  assert.equal(validateWorkspaceLayout({ version: 1, preset: "custom", root: deep, hiddenPanelIds: [] }), false);
});

test("dock operations create tab stacks and horizontal or vertical splits", () => {
  const initial = createWorkspacePreset("research", panels);
  const tabbed = moveWorkspacePanel(initial, "inspector", "outline", "tab");
  assert.equal(validateWorkspaceLayout(tabbed), true);
  assert.deepEqual(visiblePanelIds(tabbed.root), ["editor", "outline", "inspector", "module:terms"]);
  assert.equal(tabbed.root.type === "split" && tabbed.root.children[1]?.type === "stack"
    ? tabbed.root.children[1].children.some((child) => child.panelId === "outline") &&
      tabbed.root.children[1].children.some((child) => child.panelId === "inspector")
    : false, true);
  assert.equal(tabbed.preset, "custom");

  const docked = moveWorkspacePanel(initial, "inspector", "editor", "bottom");
  assert.equal(validateWorkspaceLayout(docked), true);
  const pairDirection = (node: WorkspaceLayout["root"], left: string, right: string): string | null => {
    if (node.type !== "split") return null;
    for (const child of node.children) {
      const found = pairDirection(child, left, right);
      if (found) return found;
    }
    return node.children.some((child) => visiblePanelIds(child).includes(left)) &&
      node.children.some((child) => visiblePanelIds(child).includes(right)) ? node.direction : null;
  };
  assert.equal(pairDirection(docked.root, "editor", "inspector"), "vertical");
  const dockedRight = moveWorkspacePanel(initial, "inspector", "editor", "right");
  assert.equal(pairDirection(dockedRight.root, "editor", "inspector"), "horizontal");
});

test("panels can be hidden and restored, while the final visible panel is retained", () => {
  const initial = createWorkspacePreset("writing", panels);
  const hidden = hideWorkspacePanel(initial, "outline");
  assert.equal(validateWorkspaceLayout(hidden), true);
  assert.ok(!visiblePanelIds(hidden.root).includes("outline"));
  assert.ok(hidden.hiddenPanelIds.includes("outline"));

  const restored = showWorkspacePanel(hidden, "outline");
  assert.equal(validateWorkspaceLayout(restored), true);
  assert.ok(visiblePanelIds(restored.root).includes("outline"));

  const onlyEditor = createWorkspacePreset("writing", ["editor"]);
  assert.equal(hideWorkspacePanel(onlyEditor, "editor"), onlyEditor);
});

test("newly available panels can be added without replacing an unsaved layout", () => {
  const initial = createWorkspacePreset("writing", ["editor", "outline"]);
  const custom = moveWorkspacePanel(initial, "outline", "editor", "right");
  const withTerms = showWorkspacePanel(custom, "module:terms");
  assert.equal(validateWorkspaceLayout(withTerms), true);
  assert.deepEqual(visiblePanelIds(custom.root), ["editor", "outline"]);
  assert.ok(visiblePanelIds(withTerms.root).includes("module:terms"));
});

test("restored Desktop panels can join the editor or reference stack", () => {
  const initial = createWorkspacePreset("writing", panels);
  const withReview = showWorkspacePanel(initial, "review", "editor");
  assert.equal(validateWorkspaceLayout(withReview), true);
  assert.deepEqual(visiblePanelIds(withReview.root), ["outline", "editor", "review", "inspector"]);
  assert.equal(withReview.root.type === "split" && withReview.root.children[1]?.type === "stack"
    ? withReview.root.children[1].activePanelId : undefined, "review");

  const withModule = showWorkspacePanel(initial, "module:terms", "inspector");
  assert.equal(validateWorkspaceLayout(withModule), true);
  assert.deepEqual(visiblePanelIds(withModule.root), ["outline", "editor", "inspector", "module:terms"]);
  assert.equal(withModule.root.type === "split" && withModule.root.children[2]?.type === "stack"
    ? withModule.root.children[2].activePanelId : undefined, "module:terms");
});

test("selecting a leaf or the active stack tab does not turn a preset into a custom layout", () => {
  const review = createWorkspacePreset("review", panels);
  assert.equal(activateWorkspacePanel(review, "editor"), review);
  assert.equal(activateWorkspacePanel(review, "review"), review);
  assert.equal(activateWorkspacePanel(review, "inspector").preset, "custom");
});

test("resizing updates only the addressed split and keeps percentages normalized", () => {
  const initial = createWorkspacePreset("writing", panels);
  assert.equal(initial.root.type, "split");
  if (initial.root.type !== "split") return;
  assert.equal(resizeWorkspaceSplit(initial, initial.root.id, initial.root.sizes), initial);
  assert.equal(resizeWorkspaceSplit(initial, "split-missing", [48, 32, 20]), initial);
  const resized = resizeWorkspaceSplit(initial, initial.root.id, [48, 32, 20]);
  assert.deepEqual(resized.root.type === "split" ? resized.root.sizes : [], [48, 32, 20]);
  assert.equal(resized.preset, "custom");
  assert.equal(validateWorkspaceLayout(resized), true);
});
