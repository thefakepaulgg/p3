import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifestPathForPane, readRoutingManifest, removeRoutingManifest, restoreTaskHandle, ROUTING_MANIFEST_VERSION, writeRoutingManifest } from "./manifest.ts";

test("atomically round-trips and removes a session manifest", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-manifest-")), "manifest.json");
  const manifest = {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "session", parentPaneId: "w1:p1", updatedAt: 1,
    sessionTotal: 0.0123, sessionTotalKnown: true,
    tasks: [{ handle: "rt-1", label: "Worker", agentName: "worker", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-6-luna", state: "running", startedAt: 1 }],
  };
  writeRoutingManifest(path, manifest);
  expect(readRoutingManifest(path)).toEqual(manifest);
  removeRoutingManifest(path);
  expect(readRoutingManifest(path)).toBeUndefined();
});

test("uses a stable manifest path for a Herdr pane", () => {
  expect(manifestPathForPane("/sessions/project", "w1:p2")).toBe("/sessions/project/routing-pane-w1_p2.json");
});

test("restores a task handle from persisted routing context", () => {
  const restored = restoreTaskHandle({
    handle: "rt-1", label: "Worker", agentName: "worker", paneId: "w1:p2", route: "luna",
    model: "openai-codex/gpt-6-luna", state: "completed", startedAt: 1, notifiedStates: ["completed"],
  });
  expect(restored.agentName).toBe("worker");
  expect(restored.notifiedStates).toEqual(["completed"]);
  expect(restored.target).toBe("herdr");
});

test("ignores malformed and incompatible manifests", () => {
  expect(readRoutingManifest("/does/not/exist")).toBeUndefined();
});
