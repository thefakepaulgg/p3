import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { classifyDelegation, classifyModelRoute, type Route, type RouteName, type RoutingDecision } from "./policy.ts";
import { normalizeTaskOwner, type TaskHandle, type TaskOwner } from "./state.ts";
import { launchHerdrAgent, type HerdrLaunch, type RoutedWorkerCapability } from "./herdr.ts";
import { ExplicitRouteRetryGuard, inferPhase, normalizeOwnedPaths, validateWorkflowLaunch, type TaskPhase } from "./workflow.ts";

export interface RoutedTaskLaunchParams {
  task: string;
  description: string;
  route?: string;
  cwd?: string;
  phase?: TaskPhase;
  depends_on?: string[];
  owned_paths?: string[];
  allow_concurrent?: boolean;
  pane_retention?: "keep" | "close";
  capabilities?: RoutedWorkerCapability[];
  owner?: TaskOwner;
}

export interface LaunchRoutePlan { route: string; config: Route; fallbackFrom?: RouteName }
export interface RoutedTaskLaunchResult { text: string; details: Record<string, unknown>; task?: TaskHandle }

export interface LaunchDependencies {
  pi: ExtensionAPI;
  taskHandles: Map<string, TaskHandle>;
  workflowLaunches: Map<string, Promise<RoutedTaskLaunchResult>>;
  routeRetryGuard: ExplicitRouteRetryGuard;
  recordDecision: (task: string, decision: RoutingDecision) => void;
  resolveRoute: (ctx: ExtensionContext, requested: string, explicit: boolean) => LaunchRoutePlan;
  trackTask: (task: TaskHandle) => void;
  watchHerdrTask: (task: TaskHandle) => void;
  manifestPath?: string;
}

const newHandle = () => `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const MAX_TASK_LENGTH = 20_000;
const MAX_ARRAY_ITEMS = 32;
const MAX_PATH_LENGTH = 4_096;

export function validateRoutedTaskLaunchParams(input: RoutedTaskLaunchParams): void {
  if (!input || typeof input !== "object") throw new Error("launch params are required");
  if (typeof input.task !== "string" || !input.task.trim()) throw new Error("task is required");
  if (input.task.length > MAX_TASK_LENGTH) throw new Error(`task exceeds the ${MAX_TASK_LENGTH} character limit`);
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error("description is required");
  if (input.description.length > 80) throw new Error("description exceeds the 80 character limit");
  if ((input as any).surface !== undefined) throw new Error("surface is no longer supported; routed tasks always run in Herdr");
  if ((input as any).isolation !== undefined) throw new Error("isolation is no longer supported; pass an existing worktree as cwd");
  if (input.route !== undefined && (typeof input.route !== "string" || !input.route.trim())) throw new Error("route must be a non-empty model or route name");
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > MAX_PATH_LENGTH)) throw new Error("cwd is invalid or exceeds its limit");
  if (input.phase !== undefined && !["plan", "implement", "review", "other"].includes(input.phase)) throw new Error(`unknown workflow phase ${String(input.phase)}`);
  for (const [name, value] of [["depends_on", input.depends_on], ["owned_paths", input.owned_paths]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_PATH_LENGTH))) throw new Error(`${name} must contain at most ${MAX_ARRAY_ITEMS} bounded strings`);
  }
  if (input.allow_concurrent !== undefined && typeof input.allow_concurrent !== "boolean") throw new Error("allow_concurrent must be boolean");
  if (input.pane_retention !== undefined && input.pane_retention !== "keep" && input.pane_retention !== "close") throw new Error("pane_retention must be keep or close");
  if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.some((capability) => capability !== "memory"))) throw new Error("capabilities must contain only memory");
}

const workflowOwnerKey = (owner?: TaskOwner): string | undefined => owner ? `workflow:${owner.runId}:${owner.stepId}:${owner.attemptId}` : undefined;

async function launchRoutedTaskOnce(deps: LaunchDependencies, ctx: ExtensionContext, input: RoutedTaskLaunchParams, owner?: unknown): Promise<RoutedTaskLaunchResult> {
  validateRoutedTaskLaunchParams(input);
  const params = { ...input, owner: normalizeTaskOwner(owner ?? input.owner) };
  const task = params.task.trim();
  const description = params.description.trim();
  const decision = classifyDelegation(`${description}\n${task}`);
  deps.recordDecision(task, decision);
  const requestedRoute = params.route?.trim() ?? classifyModelRoute(task, decision);
  const cwd = resolve(params.cwd ?? ctx.cwd);
  const phase = inferPhase(`${description}\n${task}`, requestedRoute, params.phase);
  const dependsOn = params.depends_on ?? [];
  const ownedPaths = normalizeOwnedPaths(cwd, params.owned_paths ?? []);
  const allowConcurrent = params.allow_concurrent ?? false;
  validateWorkflowLaunch({ cwd, phase, dependsOn, ownedPaths, allowConcurrent, tasks: deps.taskHandles.values() });

  const retryKey = `${cwd}\n${description}\n${task}`;
  deps.routeRetryGuard.assertAllowed(retryKey, params.route !== undefined);
  let routePlan: LaunchRoutePlan;
  try { routePlan = deps.resolveRoute(ctx, requestedRoute, params.route !== undefined); }
  catch (error) { if (params.route !== undefined) deps.routeRetryGuard.record(retryKey, requestedRoute); throw error; }
  deps.routeRetryGuard.clear(retryKey);

  const active = [...deps.taskHandles.values()].filter((item) => ["queued", "running", "blocked"].includes(item.state)).length;
  if (active >= 4) throw new Error("Herdr routed-task concurrency limit reached (4 active tasks)");
  const routeName = routePlan.route;
  const route = routePlan.config;
  const launched: HerdrLaunch = await launchHerdrAgent(deps.pi, task, description, routeName, route, cwd, undefined, deps.manifestPath, params.capabilities);
  const handle = newHandle();
  const tracked: TaskHandle = {
    handle, route: routeName, fallbackFrom: routePlan.fallbackFrom, routeExplicit: params.route !== undefined,
    target: "herdr", model: `${route.provider}/${route.model}`, thinking: route.thinking, label: description,
    cwd, phase, dependsOn, ownedPaths, allowConcurrent, owner: params.owner, state: "running", startedAt: Date.now(),
    agentName: launched.agent, paneId: launched.paneId, tabId: launched.tabId, paneRetention: params.pane_retention ?? "keep",
    transitions: 0, notifiedStates: [], usageOffset: 0, estimatedCost: 0, costKnown: false,
  };
  deps.trackTask(tracked);
  deps.watchHerdrTask(tracked);
  const fallbackNote = routePlan.fallbackFrom ? ` Policy fallback: ${routePlan.fallbackFrom} was unavailable, so ${routeName} was selected.` : "";
  return {
    text: `Launched Herdr ${phase} task ${handle}: agent ${launched.agent}, pane ${launched.paneId}, using ${route.provider}/${route.model} (${route.thinking}). The model is fixed. Do not poll; completion will wake the primary.${fallbackNote}`,
    details: { handle, phase, dependsOn, ownedPaths, allowConcurrent, capabilities: params.capabilities, ...launched, fallbackFrom: routePlan.fallbackFrom, model: `${route.provider}/${route.model}`, thinking: route.thinking, decision, owner: params.owner },
    task: tracked,
  };
}

export async function launchRoutedTask(deps: LaunchDependencies, ctx: ExtensionContext, input: RoutedTaskLaunchParams, owner?: unknown): Promise<RoutedTaskLaunchResult> {
  validateRoutedTaskLaunchParams(input);
  const normalizedOwner = normalizeTaskOwner(owner ?? input.owner);
  const key = workflowOwnerKey(normalizedOwner);
  if (!key) return launchRoutedTaskOnce(deps, ctx, input, normalizedOwner);
  const existingTracked = [...deps.taskHandles.values()].find((task) => task.owner && workflowOwnerKey(task.owner) === key);
  if (existingTracked) return { text: `Workflow-owned routed task ${existingTracked.handle} already exists; returning the existing handle.`, details: { handle: existingTracked.handle, owner: normalizedOwner, coalesced: true }, task: existingTracked };
  const existing = deps.workflowLaunches.get(key);
  if (existing) return existing;
  const pending = launchRoutedTaskOnce(deps, ctx, { ...input, owner: normalizedOwner }, normalizedOwner);
  deps.workflowLaunches.set(key, pending);
  try { return await pending; }
  finally { if (deps.workflowLaunches.get(key) === pending) deps.workflowLaunches.delete(key); }
}
