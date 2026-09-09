import { expect, test } from "bun:test";
import { emitTaskLifecycle } from "./lifecycle.ts";
import type { TaskHandle } from "./state.ts";

const task = (patch: Partial<TaskHandle> = {}): TaskHandle => ({
  handle: "rt-life", route: "luna", routeExplicit: false,
  target: "herdr", model: "openai-codex/gpt-5.6-luna", thinking: "high", label: "Lifecycle task",
  state: "completed", startedAt: 1, result: "must stay in memory only", resultChars: 24,
  transitions: 1, notifiedStates: [], ...patch,
});

test("lifecycle events are versioned, state-specific, bounded, and omit full results", () => {
  const emitted: Array<[string, any]> = [];
  const owner = { kind: "workflow" as const, runId: "r".repeat(200), stepId: "step", attemptId: "attempt" };
  emitTaskLifecycle({ emit: (name, data) => emitted.push([name, data]) }, task({ owner }));
  emitTaskLifecycle({ emit: (name, data) => emitted.push([name, data]) }, task({ state: "abandoned", owner }));

  expect(emitted.map(([name]) => name)).toEqual(["routing:task:completed", "routing:task:failed"]);
  expect(emitted[0][1].version).toBe(1);
  expect(emitted[0][1].result).toBeUndefined();
  expect(emitted[0][1].owner.runId).toHaveLength(128);
  expect(JSON.stringify(emitted)).not.toContain("must stay in memory only");
});
