import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRoutingManifest, removeRoutingManifest, ROUTING_MANIFEST_VERSION, writeRoutingManifest } from "./manifest.ts";

test("atomically round-trips and removes a session manifest", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-manifest-")), "manifest.json");
  const manifest = {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "session", parentPaneId: "w1:p1", updatedAt: 1,
    sessionTotal: 0.0123, sessionTotalKnown: true,
    tasks: [{ handle: "rt-1", label: "Worker", agentName: "worker", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-5.6-luna", state: "running", startedAt: 1 }],
  };
  writeRoutingManifest(path, manifest);
  expect(readRoutingManifest(path)).toEqual(manifest);
  removeRoutingManifest(path);
  expect(readRoutingManifest(path)).toBeUndefined();
});

test("ignores malformed and incompatible manifests", () => {
  expect(readRoutingManifest("/does/not/exist")).toBeUndefined();
});
