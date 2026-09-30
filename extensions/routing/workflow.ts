import { resolve } from "node:path";
import type { TaskHandle } from "./state.ts";

export type TaskPhase = "plan" | "implement" | "review" | "other";

const activeStates = new Set(["queued", "running", "blocked", "interrupted"]);

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

export function inferPhase(task: string, explicit?: TaskPhase): TaskPhase {
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

/**
 * Launch guards. depends_on handles must exist and have completed. Same-tree parallel work is
 * allowed; the only conflict is two active tasks whose declared owned_paths overlap.
 */
export function validateWorkflowLaunch(options: {
  cwd: string;
  dependsOn: string[];
  ownedPaths: string[];
  tasks: Iterable<TaskHandle>;
}): void {
  const tasks = [...options.tasks];
  for (const handle of options.dependsOn) {
    const task = tasks.find((candidate) => candidate.handle === handle);
    if (!task) throw new Error(`Unknown dependency: ${handle}`);
    if (task.state !== "completed") throw new Error(`Dependency ${handle} is ${task.state}; dependent work requires successful completion`);
  }

  if (!options.ownedPaths.length) return;
  const conflict = tasks.find((task) => task.cwd === options.cwd && activeStates.has(task.state) &&
    (task.ownedPaths?.length ?? 0) > 0 && pathsOverlap(options.ownedPaths, task.ownedPaths!));
  if (conflict) throw new Error(`Active task ${conflict.handle} already owns overlapping paths in this working tree; wait for it or declare disjoint owned_paths`);
}
