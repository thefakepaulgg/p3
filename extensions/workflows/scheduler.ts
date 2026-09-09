import { randomUUID } from "node:crypto";
import type { LoadedWorkflow, WorkflowDefinition, WorkflowStep } from "./schema.ts";

export type WorkflowRunStatus = "running" | "paused" | "completed" | "failed" | "stopped" | "fork-mismatch";
export type WorkflowStepStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "stopped" | "stale";

export interface GitLedger {
  head?: string;
  porcelain?: string;
  changedPaths?: string[];
  capturedAt?: number;
}

export interface WorkflowAttempt {
  attemptId: string;
  handle?: string;
  status: WorkflowStepStatus;
  startedAt: number;
  endedAt?: number;
  outputPath?: string;
  outputHash?: string;
  outputChars?: number;
  gitBefore?: GitLedger;
  gitAfter?: GitLedger;
  error?: string;
}

export interface WorkflowStepState {
  status: WorkflowStepStatus;
  attempts: WorkflowAttempt[];
}

export interface WorkflowRun {
  version: "workflow-run-v1";
  runId: string;
  workflowId: string;
  controllerSessionId: string;
  startedAt: number;
  updatedAt: number;
  status: WorkflowRunStatus;
  inputs: Record<string, string>;
  definition: WorkflowDefinition;
  sourcePath: string;
  definitionHash: string;
  steps: Record<string, WorkflowStepState>;
  activeStepId?: string;
  activeAttemptId?: string;
  approvalStepId?: string;
  error?: string;
}

export type WorkflowAction =
  | { type: "step-launched"; stepId: string; attempt: WorkflowAttempt }
  | { type: "step-completed"; stepId: string; attemptId: string; outputPath: string; outputHash: string; outputChars: number; gitAfter?: GitLedger }
  | { type: "step-failed"; stepId: string; attemptId: string; error: string }
  | { type: "approval"; stepId: string }
  | { type: "continue" }
  | { type: "stop"; error?: string }
  | { type: "back"; stepId: string }
  | { type: "retry"; stepId?: string };

export const newAttemptId = () => `attempt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
export const newRunId = () => `workflow-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

export function createRun(workflow: LoadedWorkflow, inputs: Record<string, string>, controllerSessionId: string, now = Date.now()): WorkflowRun {
  const steps: Record<string, WorkflowStepState> = {};
  for (const step of workflow.steps) steps[step.id] = { status: "pending", attempts: [] };
  return {
    version: "workflow-run-v1", runId: newRunId(), workflowId: workflow.id, controllerSessionId, startedAt: now, updatedAt: now,
    status: "running", inputs: { ...inputs }, definition: structuredClone(workflow), sourcePath: workflow.sourcePath, definitionHash: workflow.hash, steps,
  };
}

export function stepById(run: WorkflowRun, stepId: string): WorkflowStep {
  const step = run.definition.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown workflow step ${stepId}`);
  return step;
}

export function readyStepIds(run: WorkflowRun): string[] {
  if (run.status !== "running" || run.activeStepId) return [];
  return run.definition.steps.filter((step) => {
    const state = run.steps[step.id];
    return (state.status === "pending" || state.status === "stale") && step.needs.every((need) => run.steps[need]?.status === "completed");
  }).map((step) => step.id);
}

export function transitiveDescendants(definition: WorkflowDefinition, rootId: string): string[] {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of definition.steps) {
      if (!descendants.has(step.id) && step.needs.some((need) => need === rootId || descendants.has(need))) { descendants.add(step.id); changed = true; }
    }
  }
  return definition.steps.filter((step) => descendants.has(step.id)).map((step) => step.id);
}

export function latestAttempt(run: WorkflowRun, stepId: string): WorkflowAttempt | undefined {
  return run.steps[stepId]?.attempts.at(-1);
}

export function hasLiveAttempt(run: WorkflowRun): boolean {
  return !!run.activeStepId && !!run.activeAttemptId && run.steps[run.activeStepId]?.attempts.some((attempt) => attempt.attemptId === run.activeAttemptId && attempt.status === "running");
}

export function workflowReducer(run: WorkflowRun, action: WorkflowAction, now = Date.now()): WorkflowRun {
  const next = structuredClone(run);
  next.updatedAt = now;
  if (action.type === "step-launched") {
    const state = next.steps[action.stepId];
    state.status = "running"; state.attempts.push(structuredClone(action.attempt));
    next.activeStepId = action.stepId; next.activeAttemptId = action.attempt.attemptId; next.status = "running"; next.error = undefined; return next;
  }
  if (action.type === "step-completed") {
    const state = next.steps[action.stepId]; const attempt = state.attempts.find((candidate) => candidate.attemptId === action.attemptId);
    if (!attempt) throw new Error(`Unknown attempt ${action.attemptId}`);
    attempt.status = "completed"; attempt.endedAt = now; attempt.outputPath = action.outputPath; attempt.outputHash = action.outputHash; attempt.outputChars = action.outputChars; attempt.gitAfter = action.gitAfter;
    state.status = "completed"; next.activeStepId = undefined; next.activeAttemptId = undefined; next.error = undefined; return next;
  }
  if (action.type === "step-failed") {
    const state = next.steps[action.stepId]; const attempt = state.attempts.find((candidate) => candidate.attemptId === action.attemptId);
    if (!attempt) throw new Error(`Unknown attempt ${action.attemptId}`);
    attempt.status = "failed"; attempt.endedAt = now; attempt.error = action.error; state.status = "failed";
    next.activeStepId = undefined; next.activeAttemptId = undefined; next.status = "failed"; next.error = action.error; return next;
  }
  if (action.type === "approval") { next.status = "paused"; next.approvalStepId = action.stepId; return next; }
  if (action.type === "continue") { next.status = "running"; next.approvalStepId = undefined; return next; }
  if (action.type === "stop") { next.status = "stopped"; next.error = action.error; return next; }
  if (action.type === "retry") {
    const target = action.stepId ?? next.definition.steps.find((step) => ["failed", "stale"].includes(next.steps[step.id].status))?.id;
    if (!target) throw new Error("No failed or stale step to retry");
    next.steps[target].status = "pending"; next.activeStepId = undefined; next.activeAttemptId = undefined;
    next.status = "running"; next.error = undefined; return next;
  }
  if (action.type === "back") {
    const stale = new Set([action.stepId, ...transitiveDescendants(next.definition, action.stepId)]);
    for (const id of stale) { next.steps[id].status = "stale"; next.steps[id].attempts = next.steps[id].attempts.map((attempt) => attempt.status === "running" ? { ...attempt, status: "stale", endedAt: now } : attempt); }
    next.activeStepId = undefined; next.activeAttemptId = undefined; next.approvalStepId = undefined; next.status = "running"; next.error = undefined; return next;
  }
  return next;
}

export function completeIfNoReadySteps(run: WorkflowRun): WorkflowRun {
  if (run.status === "running" && !run.activeStepId && !readyStepIds(run).length && run.definition.steps.every((step) => run.steps[step.id].status === "completed")) {
    return { ...run, status: "completed", updatedAt: Date.now() };
  }
  return run;
}
