import { expect, test } from "bun:test";
import { parseWorkflowYaml } from "./schema.ts";
import { createRun, readyStepIds, transitiveDescendants, workflowReducer } from "./scheduler.ts";

const definition = parseWorkflowYaml(`
version: pi-workflow/v1
id: dag
name: DAG
description: synthetic DAG
inputs: { goal: { type: string, required: true } }
defaults: { retry: 0 }
steps:
  - { id: a, name: A, route: luna, phase: other, prompt: "{{inputs.goal}}" }
  - { id: b, name: B, route: luna, phase: implement, needs: [a], prompt: "{{steps.a.output}}" }
  - { id: c, name: C, route: luna, phase: review, needs: [b], prompt: "{{steps.b.output}}" }
`);

test("scheduler selects serial ready steps and preserves immutable definition", () => {
  const run = createRun(definition, { goal: "test" }, "session-1", 1);
  definition.steps[0].name = "mutated source";
  expect(run.definition.steps[0].name).toBe("A");
  expect(readyStepIds(run)).toEqual(["a"]);
  expect(transitiveDescendants(run.definition, "a")).toEqual(["b", "c"]);
  const launched = workflowReducer(run, { type: "step-launched", stepId: "a", attempt: { attemptId: "attempt-a", status: "running", startedAt: 2 } }, 2);
  expect(readyStepIds(launched)).toEqual([]);
  const completed = workflowReducer(launched, { type: "step-completed", stepId: "a", attemptId: "attempt-a", outputPath: "/tmp/a.md", outputHash: "a", outputChars: 1 }, 3);
  expect(readyStepIds(completed)).toEqual(["b"]);
  expect(completed.definition).toEqual(run.definition);
});

test("approval pauses scheduling until continue", () => {
  let run = createRun(definition, { goal: "test" }, "session-1");
  run = workflowReducer(run, { type: "step-launched", stepId: "a", attempt: { attemptId: "a1", status: "running", startedAt: 1 } });
  run = workflowReducer(run, { type: "step-completed", stepId: "a", attemptId: "a1", outputPath: "/tmp/a", outputHash: "a", outputChars: 1 });
  run = workflowReducer(run, { type: "approval", stepId: "a" });
  expect(run.status).toBe("paused"); expect(readyStepIds(run)).toEqual([]);
  run = workflowReducer(run, { type: "continue" });
  expect(run.status).toBe("running"); expect(readyStepIds(run)).toEqual(["b"]);
});

test("retry is bounded by the configured attempt policy", () => {
  const retryDefinition = parseWorkflowYaml(`
version: pi-workflow/v1
id: retry
name: Retry
description: retry test
inputs: { goal: { type: string, required: true } }
defaults: { retry: 1 }
steps: [{ id: only, name: Only, route: luna, phase: other, prompt: "{{inputs.goal}}" }]
`);
  let run = createRun(retryDefinition, { goal: "x" }, "session-1");
  run = workflowReducer(run, { type: "step-launched", stepId: "only", attempt: { attemptId: "a1", status: "running", startedAt: 1 } });
  run = workflowReducer(run, { type: "step-failed", stepId: "only", attemptId: "a1", error: "first" });
  run = workflowReducer(run, { type: "retry", stepId: "only" });
  expect(run.steps.only.status).toBe("pending");
  run = workflowReducer(run, { type: "step-launched", stepId: "only", attempt: { attemptId: "a2", status: "running", startedAt: 2 } });
  run = workflowReducer(run, { type: "step-failed", stepId: "only", attemptId: "a2", error: "second" });
  expect(run.status).toBe("failed");
  expect(() => workflowReducer(run, { type: "retry", stepId: "missing" })).toThrow();
});

test("back invalidates only the selected step and its descendants while retaining attempts", () => {
  let run = createRun(definition, { goal: "test" }, "session-1", 1);
  run = workflowReducer(run, { type: "step-launched", stepId: "a", attempt: { attemptId: "a1", status: "running", startedAt: 2 } }, 2);
  run = workflowReducer(run, { type: "step-completed", stepId: "a", attemptId: "a1", outputPath: "/tmp/a", outputHash: "a", outputChars: 1 }, 3);
  run = workflowReducer(run, { type: "step-launched", stepId: "b", attempt: { attemptId: "b1", status: "running", startedAt: 4 } }, 4);
  run = workflowReducer(run, { type: "step-completed", stepId: "b", attemptId: "b1", outputPath: "/tmp/b", outputHash: "b", outputChars: 1 }, 5);
  const backed = workflowReducer(run, { type: "back", stepId: "a" }, 6);
  expect(backed.steps.a.status).toBe("stale");
  expect(backed.steps.b.status).toBe("stale");
  expect(backed.steps.c.status).toBe("stale");
  expect(backed.steps.a.attempts).toHaveLength(1);
  expect(backed.steps.b.attempts).toHaveLength(1);
  expect(readyStepIds(backed)).toEqual(["a"]);
});
