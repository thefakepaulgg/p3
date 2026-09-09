import { afterEach, expect, test } from "bun:test";
import { focusManifestPane, installRoutedNavigator } from "./navigator.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";
import { ROUTING_MANIFEST_VERSION, type RoutingManifest } from "./manifest.ts";

afterEach(() => setHerdrTestTransportForTests(undefined));

const manifest: RoutingManifest = {
  version: ROUTING_MANIFEST_VERSION, parentSessionId: "session", parentPaneId: "w1:p1", updatedAt: 1,
  sessionTotal: 0.0123, sessionTotalKnown: true,
  tasks: [{ handle: "rt-1", label: "Sibling", agentName: "sibling", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-5.6-luna", state: "running", startedAt: Date.now() - 1000 }],
};

const install = (getManifest: () => RoutingManifest | undefined, editorText = "") => {
  let input: ((data: string) => any) | undefined;
  let rendered: string[] = [];
  const ctx: any = {
    ui: {
      getEditorText: () => editorText,
      onTerminalInput: (handler: (data: string) => any) => { input = handler; return () => {}; },
      custom: async (factory: any) => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const component = await factory({ requestRender: () => {} }, theme, {}, () => {});
        rendered = component.render(120);
        component.dispose?.();
        return undefined;
      },
      notify: () => {},
    },
  };
  installRoutedNavigator({ pi: {} as any, ctx, getManifest });
  return { trigger: (data: string) => input?.(data), rendered: () => rendered };
};

test("Down on an empty parent editor opens main and routed siblings", async () => {
  const navigator = install(() => manifest);
  expect(navigator.trigger("\x1b[B")).toEqual({ consume: true });
  await Promise.resolve();
  expect(navigator.rendered().join("\n")).toContain("main · parent");
  expect(navigator.rendered().join("\n")).toContain("Sibling · running · Luna");
  expect(navigator.rendered()[0]).toContain("session total ~$0.01");
});

test("manifest-fed child has the same navigator and typed editors keep normal arrows", async () => {
  process.env.PI_ROUTING_MANIFEST = "/tmp/manifest.json";
  try {
    const child = install(() => manifest);
    expect(child.trigger("\x1b[B")).toEqual({ consume: true });
    await Promise.resolve();
    expect(child.rendered().join("\n")).toContain("Sibling");
    expect(install(() => manifest, "draft").trigger("\x1b[B")).toBeUndefined();
  } finally { delete process.env.PI_ROUTING_MANIFEST; }
});

test("focus validates that the target pane still exists", async () => {
  setHerdrTestTransportForTests(async () => JSON.stringify({ result: { panes: [{ pane_id: "w1:p1" }] } }));
  await expect(focusManifestPane({} as any, "w1:p2")).rejects.toThrow("no longer exists");
});
