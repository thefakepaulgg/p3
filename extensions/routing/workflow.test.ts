import { describe, expect, test } from "bun:test";
import type { TaskHandle } from "./state.ts";
import { ExplicitRouteRetryGuard, inferPhase, normalizeOwnedPaths, validateWorkflowLaunch } from "./workflow.ts";

const task = (patch: Partial<TaskHandle> = {}): TaskHandle => ({
  handle: "rt-existing", route: "sol", routeExplicit: false,
  target: "herdr", model: "openai-codex/gpt-6-sol", thinking: "medium", label: "Plan",
  cwd: "/repo", phase: "plan", state: "running", startedAt: 1, transitions: 0, notifiedStates: [], ...patch,
});

const validate = (patch: Partial<Parameters<typeof validateWorkflowLaunch>[0]> = {}, tasks: TaskHandle[] = []) =>
  validateWorkflowLaunch({ cwd: "/repo", phase: "implement", dependsOn: [], ownedPaths: [], allowConcurrent: false, tasks, ...patch });

describe("explicit route retry protection", () => {
  test("rejects dropping a recently failed explicit route", () => {
    const guard = new ExplicitRouteRetryGuard(1000);
    guard.record("task", "luna", 100);
    expect(() => guard.assertAllowed("task", false, 200)).toThrow("instead of dropping the override");
  });
  test("allows another explicit route and expired failures", () => {
    const guard = new ExplicitRouteRetryGuard(1000);
    guard.record("task", "luna", 100);
    expect(() => guard.assertAllowed("task", true, 200)).not.toThrow();
    expect(() => guard.assertAllowed("task", false, 1200)).not.toThrow();
  });
});

describe("phase inference", () => {
  test("planning language is plan", () => expect(inferPhase("write the implementation plan", "sol")).toBe("plan"));
  test("implementation verbs are implement", () => expect(inferPhase("remove ledger code", "luna")).toBe("implement"));
  test("review language is review", () => expect(inferPhase("review final diff", "sol")).toBe("review"));
});

describe("workflow guards", () => {
  test("blocks implementation while planning is active", () => expect(() => validate({}, [task()])).toThrow("implement cannot start while plan task rt-existing is running"));
  test("blocks review while implementation is active", () => expect(() => validate({ phase: "review" }, [task({ phase: "implement", route: "luna" })])).toThrow("review cannot start while implement task"));
  test("requires explicit dependency on completed plan", () => expect(() => validate({}, [task({ state: "completed" })])).toThrow('depends_on: ["rt-existing"]'));
  test("accepts implementation after completed declared plan", () => expect(() => validate({ dependsOn: ["rt-existing"] }, [task({ state: "completed" })])).not.toThrow());
  test("rejects incomplete dependency", () => expect(() => validate({ dependsOn: ["rt-existing"] }, [task()])).toThrow("requires successful completion"));
  test("serializes same-tree writers by default", () => expect(() => validate({}, [task({ phase: "implement", route: "luna" })])).toThrow("already active"));
  test("allows opted-in disjoint same-tree writers", () => expect(() => validate({ allowConcurrent: true, ownedPaths: ["/repo/src/b"] }, [task({ phase: "implement", route: "luna", allowConcurrent: true, ownedPaths: ["/repo/src/a"] })])).not.toThrow());
  test("rejects overlapping owned paths", () => expect(() => validate({ allowConcurrent: true, ownedPaths: ["/repo/src/a/file.ts"] }, [task({ phase: "implement", route: "luna", allowConcurrent: true, ownedPaths: ["/repo/src/a"] })])).toThrow("already active"));
  test("permits work in a different working tree", () => expect(() => validate({}, [task({ cwd: "/other", phase: "implement", route: "luna" })])).not.toThrow());
  test("normalizes relative ownership paths", () => expect(normalizeOwnedPaths("/repo", ["src/b", "src/a", "src/a"])).toEqual(["/repo/src/a", "/repo/src/b"]));
});
