import { describe, expect, test } from "bun:test";
import type { TaskHandle } from "./state.ts";
import { ExplicitRouteRetryGuard, inferPhase, normalizeOwnedPaths, validateWorkflowLaunch } from "./workflow.ts";

const task = (patch: Partial<TaskHandle> = {}): TaskHandle => ({
  handle: "rt-existing", route: "sol", routeExplicit: false,
  target: "herdr", model: "openai-codex/gpt-6-sol", thinking: "medium", label: "Plan",
  cwd: "/repo", phase: "plan", state: "running", startedAt: 1, transitions: 0, notifiedStates: [], ...patch,
});

const validate = (patch: Partial<Parameters<typeof validateWorkflowLaunch>[0]> = {}, tasks: TaskHandle[] = []) =>
  validateWorkflowLaunch({ cwd: "/repo", dependsOn: [], ownedPaths: [], tasks, ...patch });

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
  test("planning language is plan", () => expect(inferPhase("write the implementation plan")).toBe("plan"));
  test("implementation verbs are implement", () => expect(inferPhase("remove ledger code")).toBe("implement"));
  test("review language is review", () => expect(inferPhase("review final diff")).toBe("review"));
});

describe("workflow guards", () => {
  test("allows parallel work in the same tree", () => expect(() => validate({}, [task(), task({ handle: "rt-writer", phase: "implement" })])).not.toThrow());
  test("does not require a dependency on an earlier plan", () => expect(() => validate({}, [task({ state: "completed" })])).not.toThrow());
  test("accepts a completed declared dependency", () => expect(() => validate({ dependsOn: ["rt-existing"] }, [task({ state: "completed" })])).not.toThrow());
  test("rejects an incomplete dependency", () => expect(() => validate({ dependsOn: ["rt-existing"] }, [task()])).toThrow("requires successful completion"));
  test("rejects an unknown dependency", () => expect(() => validate({ dependsOn: ["rt-missing"] })).toThrow("Unknown dependency"));
  test("allows disjoint owned paths", () => expect(() => validate({ ownedPaths: ["/repo/src/b"] }, [task({ ownedPaths: ["/repo/src/a"] })])).not.toThrow());
  test("rejects overlapping owned paths", () => expect(() => validate({ ownedPaths: ["/repo/src/a/file.ts"] }, [task({ ownedPaths: ["/repo/src/a"] })])).toThrow("overlapping paths"));
  test("ignores overlap when only one side declares paths", () => expect(() => validate({ ownedPaths: ["/repo/src/a"] }, [task()])).not.toThrow());
  test("ignores finished tasks and other trees", () => expect(() => validate({ ownedPaths: ["/repo/src/a"] }, [task({ state: "completed", ownedPaths: ["/repo/src/a"] }), task({ cwd: "/other", ownedPaths: ["/repo/src/a"] })])).not.toThrow());
  test("normalizes relative ownership paths", () => expect(normalizeOwnedPaths("/repo", ["src/b", "src/a", "src/a"])).toEqual(["/repo/src/a", "/repo/src/b"]));
});
