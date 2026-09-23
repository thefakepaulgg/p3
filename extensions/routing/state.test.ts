import { describe, expect, test } from "bun:test";
import {
  boundNotification, buildCompletionMessage, canDeliverCompletion, COMPLETION_EXCERPT_LIMIT, formatElapsed,
  formatModelLabel, formatTaskWidget, markCompletionDelivered, markNotified, NOTIFICATION_LIMIT, recommendEscalation,
  taskMetadata, telemetryRecord, type TaskHandle,
} from "./state.ts";

const task = (patch: Partial<TaskHandle> = {}): TaskHandle => ({
  handle: "rt-test", route: "luna", routeExplicit: false,
  target: "herdr", model: "openai-codex/gpt-6-luna", thinking: "high", label: "Test task",
  state: "running", startedAt: 1, transitions: 0, notifiedStates: [], ...patch,
});

describe("escalation advice", () => {
  test("blocked Herdr task requests steering", () => expect(recommendEscalation(task({ state: "blocked" }))).toContain("Steer"));
  test("failed Luna work returns to Sol", () => expect(recommendEscalation(task({ state: "failed", error: "boom" }))).toContain("Sol primary"));
  test("short completion requires verification", () => expect(recommendEscalation(task({ state: "completed", resultChars: 5 }))).toContain("verify"));
  test("fallback remains explicit", () => expect(recommendEscalation(task({ state: "completed", resultChars: 100, fallbackFrom: "luna", route: "sol" }))).toContain("fallback"));
});

describe("bounded telemetry", () => {
  test("contains no task or result body", () => {
    const record = telemetryRecord(task({ label: "x".repeat(200), error: "e".repeat(500) }));
    expect(record).not.toHaveProperty("task");
    expect(record).not.toHaveProperty("result");
    expect(String(record.label).length).toBe(80);
    expect(String(record.error).length).toBe(240);
  });

  test("keeps cached result out of persisted telemetry", () => expect(telemetryRecord(task({ result: "private result body" }))).not.toHaveProperty("result"));
  test("persists bounded workflow ownership without exposing cached results", () => {
    const owner = { kind: "workflow" as const, runId: "r".repeat(200), stepId: "step", attemptId: "attempt" };
    const tracked = task({ owner, result: "private result body" });
    expect((telemetryRecord(tracked).owner as any).runId).toHaveLength(128);
    expect(taskMetadata(tracked)).not.toHaveProperty("result");
    expect((taskMetadata(tracked).owner as any).runId).toHaveLength(128);
  });
  test("records pane retention policy", () => expect(telemetryRecord(task({ paneRetention: "close" })).paneRetention).toBe("close"));
  test("records isolated tab ownership", () => expect(telemetryRecord(task({ tabId: "w1:t2" })).tabId).toBe("w1:t2"));

  test("persists only sanitized notification kinds", () => {
    const record = telemetryRecord(task({ notifiedStates: ["completed:secret worker output leaked here", "blocked#2"] }));
    expect(record.notifiedStates).toEqual(["completed", "blocked#2"]);
    expect(JSON.stringify(record)).not.toContain("secret worker output");
  });

  test("records the completion-delivery claim so reload can dedupe", () => {
    const pending = task({ state: "completed" });
    expect(markCompletionDelivered(pending, "message", 4242)).toBe(true);
    const record = telemetryRecord(pending);
    expect(record.completionNotifiedAt).toBe(4242);
    expect(record.completionDeliveredVia).toBe("message");
  });
});

describe("single bounded completion delivery", () => {
  test("claims the delivery slot exactly once", () => {
    const pending = task({ state: "completed" });
    expect(canDeliverCompletion(pending)).toBe(true);
    expect(markCompletionDelivered(pending, "message")).toBe(true);
    expect(canDeliverCompletion(pending)).toBe(false);
    expect(markCompletionDelivered(pending, "message")).toBe(false);
  });

  test("manual result retrieval consumes the same slot", () => {
    const pending = task({ state: "completed" });
    expect(markCompletionDelivered(pending, "manual")).toBe(true);
    expect(markCompletionDelivered(pending, "message")).toBe(false);
    expect(pending.completionDeliveredVia).toBe("manual");
  });

  test("legacy content-keyed notifications still suppress a repeat completion", () => {
    const replayed = task({ state: "completed", notifiedStates: ["completed:Routed Herdr task rt-test completed"] });
    expect(canDeliverCompletion(replayed)).toBe(false);
  });

  test("non-completion kinds dedupe per kind", () => {
    const blocked = task({ state: "blocked" });
    expect(markNotified(blocked, "blocked#1")).toBe(true);
    expect(markNotified(blocked, "blocked#1")).toBe(false);
    expect(markNotified(blocked, "blocked#2")).toBe(true);
    expect(markNotified(blocked, "timeout")).toBe(true);
  });

  test("retains at most a bounded number of kinds", () => {
    const noisy = task();
    for (let index = 0; index < 40; index += 1) markNotified(noisy, `blocked#${index}`);
    expect(noisy.notifiedStates.length).toBeLessThanOrEqual(12);
  });
});

describe("bounded completion message", () => {
  const long = "R".repeat(9000);

  test("excerpts the cached result and points at the full copy", () => {
    const completed = task({ state: "completed", paneId: "w1:p2", resultChars: long.length });
    const message = buildCompletionMessage(completed, long);
    expect(message.length).toBeLessThanOrEqual(NOTIFICATION_LIMIT);
    expect(message).toContain("subagent_control action=result handle=rt-test");
    expect(message).toContain("9000 chars");
    expect(message).toContain("Pane w1:p2 is retained for inspection");
    expect(message).not.toContain(long);
    const excerpt = message.split("\n").find((line) => line.startsWith("Excerpt: "))!.slice("Excerpt: ".length);
    expect(excerpt.length).toBeLessThanOrEqual(COMPLETION_EXCERPT_LIMIT);
  });

  test("reports empty output and closed panes", () => {
    const completed = task({ state: "completed", paneId: "w1:p2", paneClosedAt: 5 });
    const message = buildCompletionMessage(completed, "   ");
    expect(message).toContain("No assistant text was captured");
    expect(message).toContain("Pane w1:p2 was closed");
  });

  test("bounds any notification body", () => expect(boundNotification("x".repeat(5000)).length).toBe(NOTIFICATION_LIMIT));
});

describe("routed-task widget", () => {
  const now = 10_000_000;

  test("is empty when there is nothing active or recent", () => {
    expect(formatTaskWidget([], now)).toBeUndefined();
    expect(formatTaskWidget([task({ state: "completed", startedAt: 0, endedAt: 1 })], now)).toBeUndefined();
  });

  test("shows only human-facing label, model, elapsed and actionable exceptional state", () => {
    const lines = formatTaskWidget([
      task({ handle: "rt-a", route: "luna", model: "openai-codex/gpt-6-luna", label: "Parser fix", state: "running", startedAt: now - 125_000, paneId: "w1:p2" }),
      task({ handle: "rt-b", route: "sol", model: "openai-codex/gpt-6-sol", label: "Plan change", state: "blocked", startedAt: now - 3_600_000, paneId: "w1:p3", paneClosedAt: now }),
    ], now)!;
    expect(lines[0]).toBe("Subagents · 2 active");
    expect(lines[1]).toBe("◆ Plan change · gpt-6-sol · 1h00m · needs input");
    expect(lines[2]).toBe("● Parser fix · gpt-6-luna · 2m");
    expect(lines.join(" ")).not.toContain("rt-");
    expect(lines.join(" ")).not.toContain("w1:p");
    expect(lines.join(" ")).not.toContain("herdr/");
    expect(lines.join(" ")).not.toContain("retained");
  });

  test("shows closed pane state because it changes available actions", () => {
    const lines = formatTaskWidget([task({ label: "Finished", state: "completed", startedAt: now - 60_000, endedAt: now - 30_000, paneClosedAt: now })], now)!;
    expect(lines).toEqual(["Subagents · 1 recent", "✓ Finished · gpt-6-luna · 30s · closed"]);
  });

  test("keeps recent terminal tasks after active ones and bounds row count", () => {
    const items = [
      task({ handle: "rt-done", state: "completed", startedAt: now - 60_000, endedAt: now - 30_000 }),
      ...[1, 2, 3, 4].map((index) => task({ handle: `rt-${index}`, state: "running", startedAt: now - index * 1000 })),
    ];
    const lines = formatTaskWidget(items, now)!;
    expect(lines[0]).toBe("Subagents · 4 active · 1 recent");
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("… 1 more");
    expect(lines.every((line) => line.length <= 120)).toBe(true);
  });

  test("truncates long labels", () => {
    const lines = formatTaskWidget([task({ label: "L".repeat(120), state: "running", startedAt: now })], now)!;
    expect(lines[1]).toContain(`${"L".repeat(51)}\u2026`);
    expect(lines[1]).not.toContain("L".repeat(53));
  });

  test("formats model and elapsed labels compactly", () => {
    expect(formatModelLabel("openai-codex/gpt-6-sol")).toBe("gpt-6-sol");
    expect(formatModelLabel("openai-codex/gpt-6-luna")).toBe("gpt-6-luna");
    expect(formatModelLabel("anthropic/claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(180_000)).toBe("3m");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
  });
});
