import { afterEach, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { focusManifestPane, RoutedTaskWidget } from "./navigator.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";

afterEach(() => setHerdrTestTransportForTests(undefined));

const setupWidget = (constructedOutsideEditor = false) => {
  const editor = { render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} };
  const tree = { render: () => [], invalidate: () => {} };
  let focused: any = constructedOutsideEditor ? tree : editor;
  let renders = 0;
  const focusedPanes: string[] = [];
  let widget: RoutedTaskWidget;
  const tui: any = {
    getFocusedComponent: () => focused,
    setFocus: (component: any) => { focused = component; },
    requestRender: () => { renders += 1; },
  };
  widget = new RoutedTaskWidget(
    tui,
    () => [
      { handle: "rt-1", paneId: "w1:p2" },
      { handle: "rt-2", paneId: "w1:p3" },
      { handle: "rt-closed", paneId: "w1:p4", paneClosedAt: 1 },
    ],
    (selected) => [`selected:${selected ?? "none"}`],
    async (paneId) => { focusedPanes.push(paneId); },
    () => {},
  );
  return { editor, tree, widget, focused: () => focused, focus: (component: any) => { focused = component; }, renders: () => renders, focusedPanes };
};

test("Down from the main editor focuses the inline routed-agent widget even when it was created during reload", () => {
  const ui = setupWidget(true);
  ui.focus(ui.editor);
  expect(ui.widget.handleTerminalInput("\x1b[B", "")).toEqual({ consume: true });
  expect(ui.focused()).toBe(ui.widget);
  expect(ui.widget.render(120)).toEqual(["selected:rt-1"]);
  ui.widget.handleInput("\x1b[B");
  expect(ui.widget.render(120)).toEqual(["selected:rt-2"]);
  ui.widget.handleInput("\x1b[A");
  ui.widget.handleInput("\x1b[A");
  expect(ui.focused()).toBe(ui.editor);
});

test("rendered lines stay within the viewport width", () => {
  const ui = setupWidget();
  expect(ui.widget.render(8).every((line) => visibleWidth(line) <= 8)).toBe(true);
});

test("Down remains owned by another focused view such as /tree", () => {
  const ui = setupWidget();
  ui.focus(ui.tree);
  expect(ui.widget.handleTerminalInput("\x1b[B", "")).toBeUndefined();
  expect(ui.focused()).toBe(ui.tree);
});

test("Enter received by the terminal listener focuses the selected routed pane", async () => {
  const ui = setupWidget();
  ui.widget.handleTerminalInput("\x1b[B", "");
  expect(ui.widget.handleTerminalInput("\x1b[B", "")).toEqual({ consume: true });
  expect(ui.widget.handleTerminalInput("\r", "")).toEqual({ consume: true });
  await Promise.resolve();
  expect(ui.focusedPanes).toEqual(["w1:p3"]);
  expect(ui.focused()).toBe(ui.editor);
});

test("focus uses pane focus so Herdr updates the attached client view", async () => {
  const calls: string[][] = [];
  setHerdrTestTransportForTests(async (_pi, args) => {
    calls.push(args);
    return JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } });
  });
  await focusManifestPane({} as any, "w1:p2");
  expect(calls).toEqual([
    ["pane", "list", "--workspace", process.env.PI_ROUTED_ROOT_WORKSPACE_ID ?? process.env.HERDR_WORKSPACE_ID!],
    ["pane", "focus", "w1:p2"],
  ]);
});

test("focus validates that the target pane still exists", async () => {
  setHerdrTestTransportForTests(async () => JSON.stringify({ result: { panes: [{ pane_id: "w1:p1" }] } }));
  await expect(focusManifestPane({} as any, "w1:p2")).rejects.toThrow("no longer exists");
});
