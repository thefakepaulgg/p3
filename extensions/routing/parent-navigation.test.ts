import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import routedParentNavigation from "./parent-navigation.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";
import { writeRoutingManifest } from "./manifest.ts";

let temp: string | undefined;
const previousManifest = process.env.PI_ROUTING_MANIFEST;
const previousPane = process.env.HERDR_PANE_ID;
const previousWorkspace = process.env.HERDR_WORKSPACE_ID;

afterEach(() => {
  setHerdrTestTransportForTests(undefined);
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
  if (previousManifest === undefined) delete process.env.PI_ROUTING_MANIFEST; else process.env.PI_ROUTING_MANIFEST = previousManifest;
  if (previousPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousPane;
  if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
});

test("a routed worker renders and can follow its route back to the parent", async () => {
  temp = mkdtempSync(join(tmpdir(), "routing-parent-navigation-"));
  const manifestPath = join(temp, "manifest.json");
  writeRoutingManifest(manifestPath, {
    version: "pi-routing/v1", parentSessionId: "parent", parentPaneId: "w1:p1", updatedAt: 1, tasks: [],
  });
  process.env.PI_ROUTING_MANIFEST = manifestPath;
  process.env.HERDR_PANE_ID = "w1:p2";
  process.env.HERDR_WORKSPACE_ID = "w1";

  const lifecycle = new Map<string, Function>();
  const calls: string[][] = [];
  const fake: any = {
    on: (name: string, handler: Function) => lifecycle.set(name, handler),
  };
  setHerdrTestTransportForTests(async (_pi, args) => {
    calls.push(args);
    return JSON.stringify({ result: { panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] } });
  });
  routedParentNavigation(fake);

  const editor = { render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} };
  let focused: any = editor;
  const tui: any = { getFocusedComponent: () => focused, setFocus: (value: any) => { focused = value; }, requestRender: () => {} };
  let widget: any;
  let input: ((data: string) => unknown) | undefined;
  const ctx: any = {
    mode: "tui",
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setWidget: (_key: string, factory: any, options: any) => {
        expect(options).toEqual({ placement: "belowEditor" });
        widget = factory(tui);
      },
      onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => {}; },
      getEditorText: () => "",
      notify: () => {},
    },
  };

  await lifecycle.get("session_start")?.({}, ctx);
  expect(widget.render(120).join("\n")).toContain("↩ Parent · main");
  expect(input?.("\x1b[B")).toEqual({ consume: true });
  expect(input?.("\r")).toEqual({ consume: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.at(-1)).toEqual(["pane", "focus", "w1:p1"]);
});
