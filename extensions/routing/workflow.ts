import { resolve } from "node:path";
import type { TaskHandle } from "./state.ts";

export type TaskPhase = "plan" | "implement" | "review" | "other";

const activeStates = new Set(["queued", "running", "blocked"]);

export class ExplicitRouteRetryGuard {
  private readonly failures = new Map<string, { route: string; at: number }>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  record(key: string, route: string, now = Date.now()): void {
    this.failures.set(key, { route, at: now });
  }

  assertAllowed(key: string, routeExplicit: boolean, now = Date.now()): void {
    const failure = this.failures.get(key);
    if (!failure) return;
    if (now - failure.at > this.ttlMs) { this.failures.delete(key); return; }
    if (!routeExplicit) throw new Error(`Explicit route ${failure.route} recently failed for this task; select another explicit route or resolve its availability instead of dropping the override`);
  }

  clear(key: string): void { this.failures.delete(key); }
}

export function inferPhase(task: string, _route: string, explicit?: TaskPhase): TaskPhase {
  if (explicit) return explicit;
  if (/\b(plan|planning|architecture|design)\b/i.test(task)) return "plan";
  if (/\b(review|audit|second opinion)\b/i.test(task)) return "review";
  if (/\b(implement|fix|refactor|add|remove|update|change|write|edit|migrate)\b/i.test(task)) return "implement";
  return "other";
}

export function normalizeOwnedPaths(cwd: string, paths: string[] = []): string[] {
  return [...new Set(paths.map((path) => resolve(cwd, path)).sort())];
}

function pathsOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function validateWorkflowLaunch(options: {
  cwd: string;
  phase: TaskPhase;
  dependsOn: string[];
  ownedPaths: string[];
  allowConcurrent: boolean;
  tasks: Iterable<TaskHandle>;
}): void {
  const tasks = [...options.tasks];
  const dependencies = options.dependsOn.map((handle) => {
    const task = tasks.find((candidate) => candidate.handle === handle);
    if (!task) throw new Error(`Unknown dependency: ${handle}`);
    if (task.state !== "completed") throw new Error(`Dependency ${handle} is ${task.state}; dependent work requires successful completion`);
    return task;
  });

  const sameTree = tasks.filter((task) => task.cwd === options.cwd);
  const active = sameTree.filter((task) => activeStates.has(task.state));
  const conflictingPhase = active.find((task) =>
    (options.phase === "implement" && (task.phase === "plan" || task.phase === "review")) ||
    (options.phase === "review" && task.phase === "implement") ||
    (options.phase === "plan" && task.phase === "implement"));
  if (conflictingPhase) {
    throw new Error(`${options.phase} cannot start while ${conflictingPhase.phase} task ${conflictingPhase.handle} is ${conflictingPhase.state} in the same working tree`);
  }

  const requiredPredecessor = options.phase === "implement"
    ? sameTree.filter((task) => task.phase === "plan").sort((a, b) => b.startedAt - a.startedAt)[0]
    : options.phase === "review"
      ? sameTree.filter((task) => task.phase === "implement").sort((a, b) => b.startedAt - a.startedAt)[0]
      : undefined;
  if (requiredPredecessor && !dependencies.some((task) => task.handle === requiredPredecessor.handle)) {
    throw new Error(`${options.phase} must declare depends_on: ["${requiredPredecessor.handle}"] before following the ${requiredPredecessor.phase} phase in this working tree`);
  }

  if (options.phase !== "implement") return;
  const activeWriter = active.find((task) => task.phase === "implement");
  if (!activeWriter) return;
  const safelyDisjoint = options.allowConcurrent && activeWriter.allowConcurrent === true &&
    options.ownedPaths.length > 0 && (activeWriter.ownedPaths?.length ?? 0) > 0 &&
    !pathsOverlap(options.ownedPaths, activeWriter.ownedPaths!);
  if (!safelyDisjoint) {
    throw new Error(`Write task ${activeWriter.handle} is already active in this working tree; serialize the work or explicitly allow concurrency with disjoint owned_paths on both tasks`);
  }
}
