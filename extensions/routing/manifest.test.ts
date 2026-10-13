import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifestPathForPane, readRoutingManifest, removeRoutingManifest, restoreTaskHandle, taskManifestRecord, ROUTING_MANIFEST_VERSION, writeRoutingManifest } from "./manifest.ts";

let temp: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  temp = mkdtempSync(join(tmpdir(), "routing-manifest-"));
  process.env.PI_CODING_AGENT_DIR = temp;
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
});

test("atomically round-trips and removes a session manifest", () => {
  const path = join(temp, "manifest.json");
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

test("restores exact executor, request, durable result and pending receipt context", () => {
  const saved = restoreTaskHandle({
    handle: "rt-durable", label: "Worker", agentName: "worker", paneId: "w1:p2", route: "luna",
    model: "openai-codex/gpt-6-luna", state: "completed", startedAt: 1,
    assignmentId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222",
    sessionId: "worker-session", terminalId: "terminal-2", sessionPath: "/session.jsonl",
    minimumGeneration: 2, outcomeGeneration: 2, resultRef: "result:22222222-2222-4222-8222-222222222222",
    resultPath: "/private/output.md", resultHash: "hash", pendingCompletion: true, paneRetention: "close",
  });
  expect(saved.result).toBeUndefined();
  expect(saved.completionNotifiedAt).toBeUndefined();
  expect(restoreTaskHandle(taskManifestRecord(saved)!)).toEqual(saved);
});

test("round-trips continuation, question delivery, process and usage boundaries without dropping empty capabilities", () => {
  const profile = restoreTaskHandle({
    handle: "rt-follow-up", label: "Follow-up", agentName: "worker", paneId: "w1:p2", route: "luna",
    model: "openai-codex/gpt-6-luna", thinking: "high", state: "running", startedAt: 1,
    parentSessionId: "parent", sessionId: "saved-session", sessionPath: "/saved.jsonl", terminalId: "native-terminal", workerPid: 1234,
    capabilities: [], readonly: true, continuedFrom: "rt-original", instructionIds: ["11111111-1111-4111-8111-111111111111"],
    pendingAskId: "22222222-2222-4222-8222-222222222222", askDeliveredId: "22222222-2222-4222-8222-222222222222",
    usageStartOffset: 4096, costComplete: false, paneRetention: "close",
  });
  const record = taskManifestRecord(profile)!;
  expect(record.capabilities).toEqual([]); expect(record.workerPid).toBe(1234);
  expect(record.continuedFrom).toBe("rt-original"); expect(record.instructionIds).toEqual(profile.instructionIds);
  expect(record.pendingAskId).toBe(profile.pendingAskId); expect(record.askDeliveredId).toBe(profile.askDeliveredId);
  expect(record.usageStartOffset).toBe(4096); expect(record.costComplete).toBe(false);
  const path = join(temp, "continued-manifest.json");
  writeRoutingManifest(path, { version: ROUTING_MANIFEST_VERSION, parentSessionId: "parent", parentPaneId: "w1:p1", updatedAt: 1, tasks: [record] });
  const restored = restoreTaskHandle(readRoutingManifest(path)!.tasks[0]);
  expect(restored).toEqual(profile);
});
