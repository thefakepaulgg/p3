import { StringEnum } from "@earendil-works/pi-ai";
import { rmSync } from "node:fs";
import type { Server } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyDelegation, classifyModelRoute, planFallback, routes, type Route, type RouteName, type RoutingDecision, type ThinkingLevel } from "./routing/policy.ts";
import { boundNotification, COMPLETION_KIND, formatModelLabel, formatTaskWidget, isActiveTask, markCompletionDelivered, markNotified, recommendEscalation, resetCompletionDelivery, taskMetadata, taskWidgetItems, telemetryRecord, WIDGET_KEY, type TaskHandle, type TaskWidgetItem } from "./routing/state.ts";
import { parseJson, readHerdrResult, runHerdr, watchHerdrTask as startHerdrWatcher } from "./routing/herdr.ts";
import { ExplicitRouteRetryGuard } from "./routing/workflow.ts";
import { launchRoutedTask, type RoutedTaskLaunchParams } from "./routing/launch.ts";
import { registerRoutingRpc, type RoutingRpcResult } from "./routing/rpc.ts";
import { emitTaskLifecycle } from "./routing/lifecycle.ts";
import { manifestPathForPane, readRoutingManifest, restoreTaskHandle, ROUTING_MANIFEST_VERSION, taskManifestRecord, writeRoutingManifest, type RoutingManifest } from "./routing/manifest.ts";
import { focusManifestPane, RoutedTaskWidget } from "./routing/navigator.ts";
import { inboxPath, sendParentMessage, startParentInbox } from "./routing/messages.ts";
import { formatEstimatedCost, sumSessionCost } from "./routing/usage.ts";

const RouteParams = Type.Object({
  action: StringEnum(["status", "recommend"] as const),
  task: Type.Optional(Type.String({ description: "Task to classify when action is recommend" })),
});

const RoutedTaskParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Self-contained assignment for the subagent" }),
  description: Type.String({ minLength: 3, maxLength: 80, description: "Short task label" }),
  route: Type.Optional(Type.String({ minLength: 1, description: "Model override. Omit it: policy picks Sol (gpt-6-sol, medium) for general planning, implementation, and judgment; Opus (claude-opus-5-5, medium) for deep bugs and UI work; and Luna (gpt-6-luna, high) only for clearly mechanical review/discovery. Set it only when the user named a model for this specific task." })),
  effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
    description: "Reasoning effort override. Omit for the route default unless the user asked for an effort level for this specific task.",
  })),
  cwd: Type.Optional(Type.String({ description: "Absolute working directory. Defaults to the current session directory." })),
  phase: Type.Optional(StringEnum(["plan", "implement", "review", "other"] as const, {
    description: "Workflow phase. Inferred when omitted; explicit phases improve dependency enforcement.",
  })),
  depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Subagent handles that must have completed successfully before this task starts.",
  })),
  owned_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Optional paths this task owns, relative to cwd unless absolute. Launch is refused only if another active task in the same tree declared overlapping paths.",
  })),
  pane_retention: Type.Optional(StringEnum(["keep", "close"] as const, {
    description: "Herdr-only completed-pane policy. keep (default) preserves the pane for later inspection; close removes it after caching the result and delivering the single completion message.",
  })),
  capabilities: Type.Optional(Type.Array(StringEnum(["memory"] as const), {
    description: "Declared task capabilities. Subagents inherit configured extensions.",
  })),
  mode: Type.Optional(StringEnum(["task", "background"] as const, {
    description: "task (default) completes and wakes the primary once. background is long-lived: it is never marked complete on idle, never wakes the primary, and does not count toward the active-task limit. Pull its latest output with subagent_control action=result; stop it explicitly.",
  })),
});

const RoutedTaskControlParams = Type.Object({
  action: StringEnum(["list", "status", "result", "focus", "close", "clear", "steer", "stop"] as const),
  handle: Type.Optional(Type.String({ description: "Subagent handle; required except for list" })),
  message: Type.Optional(Type.String({ description: "Message for steer" })),
  close_pane: Type.Optional(Type.Boolean({ description: "For Herdr stop, also close the owned pane. Default false." })),
});

export { classifyDelegation, classifyModelRoute, planFallback } from "./routing/policy.ts";
export { recommendEscalation } from "./routing/state.ts";

export default function modelRoutingExtension(pi: ExtensionAPI) {
  let selectedRoute: RouteName | undefined;
  let lastDecision: (RoutingDecision & { timestamp: number }) | undefined;
  const taskHandles = new Map<string, TaskHandle>();
  const workflowLaunches = new Map<string, Promise<Awaited<ReturnType<typeof launchRoutedTask>>>>();
  const watchers = new Map<string, AbortController>();
  const eventUnsubs: Array<() => void> = [];
  const routeRetryGuard = new ExplicitRouteRetryGuard();
  let uiCtx: ExtensionContext | undefined;
  let activeCtx: ExtensionContext | undefined;
  let widgetSignature: string | undefined;
  let manifestPath: string | undefined;
  let routingManifest: RoutingManifest | undefined;
  let ownsManifest = false;
  let manifestTimer: ReturnType<typeof setInterval> | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;
  let routedWidget: RoutedTaskWidget | undefined;
  let manifestSignature = "";
  let parentMetadataCount: number | undefined;
  let parentInbox: Server | undefined;
  let parentInboxPath: string | undefined;

  const routeSummary = (name: RouteName) => {
    const route = routes[name];
    return `${name}: ${route.provider}/${route.model} (${route.thinking}) — ${route.purpose}`;
  };

  const decisionSummary = (decision: RoutingDecision) =>
    `${decision.delegate ? `Delegate to ${decision.target}` : `Keep with ${decision.target}`} (${decision.confidence} confidence) — ${decision.rationale}`;

  const detectRoute = (ctx: ExtensionContext): RouteName | undefined => {
    if (!ctx.model) return undefined;
    const match = (Object.entries(routes) as [RouteName, Route][]).find(([, route]) =>
      route.provider === ctx.model?.provider && route.model === ctx.model?.id,
    );
    return match?.[0];
  };

  const rememberUi = (ctx?: ExtensionContext) => {
    if (!ctx) return;
    activeCtx = ctx;
    if (ctx.hasUI === true && typeof ctx.ui?.setWidget === "function") uiCtx = ctx;
  };

  const syncManifest = () => {
    if (!ownsManifest || !manifestPath || !activeCtx) return;
    const primary = sumSessionCost(activeCtx.sessionManager.getEntries());
    const tasks = [...taskHandles.values()].map(taskManifestRecord).filter((task): task is NonNullable<typeof task> => !!task);
    const knownChildren = tasks.filter((task) => task.costKnown && typeof task.estimatedCost === "number");
    const sessionTotalKnown = primary.known || knownChildren.length > 0;
    const sessionTotal = primary.cost + knownChildren.reduce((sum, task) => sum + (task.estimatedCost ?? 0), 0);
    routingManifest = {
      version: ROUTING_MANIFEST_VERSION,
      parentSessionId: activeCtx.sessionManager.getSessionId(), parentPaneId: process.env.HERDR_PANE_ID!, parentInbox: parentInboxPath,
      parentSessionPath: activeCtx.sessionManager.getSessionFile(), primaryCost: primary.cost, primaryCostKnown: primary.known,
      sessionTotal, sessionTotalKnown, updatedAt: Date.now(), tasks,
    };
    writeRoutingManifest(manifestPath, routingManifest);
    manifestSignature = JSON.stringify(routingManifest);
  };

  const widgetData = () => {
    const manifestTasks = routingManifest?.tasks;
    const tasks: TaskWidgetItem[] = ownsManifest || !manifestTasks ? [...taskHandles.values()] : [...manifestTasks];
    const shown = taskWidgetItems(tasks);
    const lines = formatTaskWidget(tasks) ?? [];
    const targets = [...shown];
    const parentPaneId = routingManifest?.parentPaneId;
    const isChildPane = !ownsManifest && parentPaneId && process.env.HERDR_PANE_ID !== parentPaneId;
    if (isChildPane) {
      if (!lines.length) lines.push("Subagents");
      lines.splice(1, 0, "↩ Parent · main");
      targets.unshift({ handle: "parent", label: "Parent", model: "main", state: "completed", startedAt: 0, paneId: parentPaneId });
    }
    const total = formatEstimatedCost(routingManifest?.sessionTotal, routingManifest?.sessionTotalKnown);
    if (lines.length && total) lines[0] += ` · session total ${total}`;
    return { lines, targets };
  };

  /** Repaint a compact, themed routed-agent card. Internal handles remain in the control tool, not the widget. */
  const refreshWidget = () => {
    const ctx = uiCtx;
    if (!ctx || typeof ctx.ui?.setWidget !== "function") return;
    const initial = widgetData();
    const signature = initial.lines.join("\n");
    if (signature === widgetSignature) return;
    widgetSignature = signature;
    if (!initial.lines.length) {
      routedWidget = undefined;
      try { ctx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* the UI may already be gone */ }
      return;
    }
    const renderLines = (selectedHandle?: string) => {
      const current = widgetData();
      if (!current.lines.length) return [];
      const theme = ctx.ui.theme;
      const markerColor = { "○": "muted", "●": "accent", "◆": "warning", "‖": "warning", "✓": "success", "×": "error", "−": "dim", "?": "warning", "↩": "accent" } as const;
      const title = typeof theme.bold === "function" ? theme.bold(current.lines[0]) : current.lines[0];
      // Keep the whole frame dim; only the title carries the accent color.
      const rendered = [`${theme.fg("dim", "╭─")} ${theme.fg("accent", title)}`];
      for (const [index, line] of current.lines.slice(1).entries()) {
        if (line.startsWith("…")) {
          rendered.push(`${theme.fg("dim", "│")} ${theme.fg("dim", line)}`);
          continue;
        }
        const marker = line[0] ?? "?";
        const segments = line.slice(2).split(" · ");
        const label = segments.shift() ?? "";
        const meta = segments.map((segment) => theme.fg(segment === "needs input" || segment === "interrupted" || segment === "failed" || segment === "abandoned" ? "warning" : "muted", segment)).join(theme.fg("dim", " · "));
        const color = markerColor[marker as keyof typeof markerColor] ?? "muted";
        const branch = current.targets[index]?.handle === selectedHandle ? theme.fg("accent", "›") : theme.fg("dim", "│");
        rendered.push(`${branch} ${theme.fg(color, marker)} ${theme.fg("text", label)}${meta ? `${theme.fg("dim", " · ")}${meta}` : ""}`);
      }
      rendered.push(ctx.ui.theme.fg("dim", "╰─"));
      return rendered;
    };
    if (ctx.mode !== "tui") {
      try { ctx.ui.setWidget(WIDGET_KEY, renderLines(), { placement: "belowEditor" }); } catch { /* the UI may already be gone */ }
      return;
    }
    if (routedWidget) { routedWidget.requestRender(); return; }
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        routedWidget = new RoutedTaskWidget(
          tui,
          () => widgetData().targets,
          renderLines,
          (paneId) => focusManifestPane(pi, paneId),
          (message) => ctx.ui.notify(message, "warning"),
        );
        return routedWidget;
      }, { placement: "belowEditor" });
    } catch { /* the UI may already be gone */ }
  };

  const refreshParentMetadata = () => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!ownsManifest || !paneId) return;
    const count = [...taskHandles.values()].filter(isActiveTask).length;
    if (count === parentMetadataCount) return;
    parentMetadataCount = count;
    const routedArgs = count > 0
      ? ["--token", `subagents=${count} subagents active`]
      : ["--clear-token", "subagents"];
    void runHerdr(pi, [
      "pane", "report-metadata", paneId,
      "--source", "pi-routing:delegation",
      ...routedArgs,
    ], 5000).catch(() => undefined);
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const route = selectedRoute ?? detectRoute(ctx);
    ctx.ui.setStatus("model-route", route ? ctx.ui.theme.fg("muted", `route:${route}`) : undefined);
  };

  const applyRoute = async (name: RouteName, ctx: ExtensionContext): Promise<string> => {
    const route = routes[name];
    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) throw new Error(`Model unavailable: ${route.provider}/${route.model}`);
    const changed = await pi.setModel(model);
    if (!changed) throw new Error(`No credentials available for ${route.provider}/${route.model}`);
    pi.setThinkingLevel(route.thinking);
    selectedRoute = name;
    pi.appendEntry("model-route", { name });
    updateStatus(ctx);
    return `Routed current session to ${routeSummary(name)}`;
  };

  const recordDecision = (_task: string, decision: RoutingDecision) => {
    lastDecision = { ...decision, timestamp: Date.now() };
    pi.appendEntry("delegation-route", lastDecision);
  };

  const persistTask = (task: TaskHandle) => {
    const terminal = ["completed", "failed", "stopped", "abandoned"].includes(task.state);
    if (task.transitions >= 8 && !terminal) return;
    task.transitions += 1;
    pi.appendEntry("routed-task", telemetryRecord(task));
  };

  const updateTask = (task: TaskHandle, patch: Partial<TaskHandle>, persist = true) => {
    const previous = task.state;
    Object.assign(task, patch);
    task.escalation = recommendEscalation(task);
    if (persist && (previous !== task.state || patch.error !== undefined || patch.resultChars !== undefined)) persistTask(task);
    if (previous !== task.state) emitTaskLifecycle(pi.events, task);
    syncManifest();
    refreshWidget();
    refreshParentMetadata();
  };

  const trackTask = (task: TaskHandle) => {
    taskHandles.set(task.handle, task);
    persistTask(task);
    emitTaskLifecycle(pi.events, task);
    syncManifest();
    refreshWidget();
    refreshParentMetadata();
  };

  /**
   * Deliver one bounded routed-task custom message per notification kind.
   * Completion uses a persisted single-delivery claim, so watcher restarts, session reload,
   * and manual result retrieval cannot produce a second completion turn.
   */
  const notifyTask = (task: TaskHandle, kind: string, content: string) => {
    // Workflow runs consume lifecycle events themselves and display bounded run-level
    // status. Never wake the primary with routed-task custom messages for them.
    if (task.owner?.kind === "workflow") return;
    if (task.owner?.kind === "pr" && kind === COMPLETION_KIND) return;
    // Background subagents never report back to the primary; only a stuck or vanished one
    // reaches the user, through Telegram.
    if (task.background) {
      const blocked = kind.startsWith("blocked");
      if ((!blocked && kind !== "abandoned") || !markNotified(task, kind)) return;
      persistTask(task);
      pi.events.emit("telegram:notify", {
        kind: "blocked",
        summary: `Background subagent "${task.label}" ${blocked ? "is waiting for input" : "exited unexpectedly"}`,
        assistanceNeeded: blocked ? `Open it with /subagents focus ${task.label}` : "Check /subagents and relaunch it if still needed",
      });
      return;
    }
    const completion = kind === COMPLETION_KIND;
    if (completion ? !markCompletionDelivered(task, "message") : !markNotified(task, kind)) return;
    persistTask(task);
    refreshWidget();
    pi.sendMessage({
      customType: completion ? "subagent-completion" : "subagent-notification",
      content: boundNotification(content),
      display: true,
      details: { handle: task.handle, route: task.route, state: task.state, kind, escalation: task.escalation },
    }, { deliverAs: "steer", triggerTurn: true });
  };

  const hasAuth = (ctx: ExtensionContext, provider: string, id: string) => {
    const model = ctx.modelRegistry.find(provider, id);
    return !!model && ctx.modelRegistry.hasConfiguredAuth(model);
  };

  const availableRoute = (ctx: ExtensionContext, name: RouteName) => {
    const route = routes[name];
    return hasAuth(ctx, route.provider, route.model) ||
      (route.provider === "openai-codex" && hasAuth(ctx, "openai", route.model));
  };

  const resolveRoute = (ctx: ExtensionContext, requested: string, explicit: boolean, effort?: ThinkingLevel) => {
    if (!explicit || Object.prototype.hasOwnProperty.call(routes, requested)) {
      const plan = planFallback(requested as RouteName, explicit, (name) => availableRoute(ctx, name));
      if ("error" in plan) throw new Error(plan.error);
      const config = routes[plan.route];
      const provider = config.provider === "openai-codex" && !hasAuth(ctx, config.provider, config.model) ? "openai" : config.provider;
      return { ...plan, config: { ...config, provider, thinking: effort ?? config.thinking } };
    }

    if (requested.startsWith("openai/") && hasAuth(ctx, "openai-codex", requested.slice("openai/".length))) {
      throw new Error(`openai-codex/${requested.slice("openai/".length)} is available; use it instead of ${requested}`);
    }

    const slash = requested.indexOf("/");
    const candidates = slash > 0
      ? [ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1))].filter(Boolean)
      : ctx.modelRegistry.getAll().filter((model) => model.id === requested);
    if (candidates.length === 0) throw new Error(`Model unavailable: ${requested}`);
    if (candidates.length > 1) throw new Error(`Model ID ${requested} is ambiguous; specify provider/model`);
    const model = candidates[0]!;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No credentials available for ${model.provider}/${model.id}`);
    return {
      route: requested,
      config: {
        label: model.name,
        provider: model.provider,
        model: model.id,
        thinking: effort ?? (model.reasoning ? "medium" as const : "off" as const),
        purpose: "User-selected model",
      },
    };
  };

  const watchHerdrTask = (task: TaskHandle, baselineResult = "") => startHerdrWatcher({
    pi, task, watchers, baselineResult,
    update: (patch, persist) => updateTask(task, patch, persist),
    persist: () => persistTask(task),
    notify: (kind, content) => notifyTask(task, kind, content),
  });

  const routedLaunch = async (params: RoutedTaskLaunchParams, ctx: ExtensionContext, owner?: unknown) => {
    const result = await launchRoutedTask({
      pi, taskHandles, workflowLaunches, routeRetryGuard, recordDecision,
      resolveRoute, trackTask, watchHerdrTask, manifestPath,
    }, ctx, params, owner);
    return { content: [{ type: "text" as const, text: result.text }], details: result.details };
  };

  pi.registerTool({
    name: "message_parent",
    label: "Message Parent",
    description: "Send a message to the parent chat immediately without ending this subagent's task. Use for questions or decisions requiring the parent, not routine progress.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_toolCallId, params) {
      if (ownsManifest) throw new Error("Only subagents can message a parent");
      const manifest = readRoutingManifest(manifestPath);
      const task = manifest?.tasks.find((candidate) => candidate.paneId === process.env.HERDR_PANE_ID);
      if (!manifest?.parentInbox || !task?.messageToken) throw new Error("Parent inbox is unavailable");
      await sendParentMessage(manifest.parentInbox, { handle: task.handle, paneId: task.paneId, token: task.messageToken, text: params.text });
      return { content: [{ type: "text", text: "Message delivered to parent" }], details: { handle: task.handle } };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Launch one sticky-model task in a visible Herdr agent with workflow guards. The model stays fixed. Explicit choices never silently fall back. This is fire-and-forget: after launch, do independent work or end the turn; completion automatically wakes the primary exactly once with a bounded subagent message. Do not poll status/result, sleep, tail logs, or steer merely to ask whether it finished. Retrieve the full cached result with subagent_control action=result.",
    promptSnippet: "Launch a guarded sticky-model task in Herdr",
    promptGuidelines: [
      "Use subagent and subagent_control for all agent orchestration; never manage agents through the herdr CLI directly. Subagents use bounded dedicated tabs in the root workspace; never create agent splits in the user-owned root tab.",
      "Omit route and effort. Policy already sends general planning, implementation, and judgment to Sol, deep bugs and UI work to Opus, and only clearly mechanical review/discovery to Luna; an accurate phase and a clear brief are how to influence it. Set route or effort only when the user names a model or effort for the task being launched. Explicit choices never silently fall back.",
      "A user's model or effort request applies only to the launches it names. Do not carry it forward to later subagents, and do not set route from memory notes or earlier launches. When relaunching a stopped or failed subagent, pass route/effort only if the original launch was explicitly user-directed.",
      "Parallel subagents may share a working tree; split the work so they do not edit the same files, and declare owned_paths when overlap matters. Use depends_on when a task must wait for another to finish. Do not use subagent for simple work cheaper to do directly.",
      "After launching, either continue genuinely independent work or end the turn. Automatic completion delivery will wake the primary. Never poll subagent_control, sleep, tail logs, or send impatience steering messages while a task is merely running.",
    ],
    parameters: RoutedTaskParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.hasUI !== true) throw new Error("subagent can only launch from the user-facing root Pi session");
      rememberUi(ctx);
      return routedLaunch(params as RoutedTaskLaunchParams, ctx);
    },
  });

  const focusRoutedPane = async (task: TaskHandle): Promise<string> => {
    if (!task.paneId) throw new Error("This task does not have a retained Herdr pane");
    if (task.paneClosedAt) throw new Error(`Pane for ${task.label} has already been closed`);
    await focusManifestPane(pi, task.paneId);
    return `Opened ${task.label}`;
  };

  const closeRoutedPane = async (task: TaskHandle): Promise<string> => {
    if (!task.paneId) throw new Error("This task does not have an owned Herdr pane");
    if (isActiveTask(task)) throw new Error("The task is still active; stop it before closing its pane");
    if (!task.paneClosedAt) {
      await runHerdr(pi, ["pane", "close", task.paneId], 5000);
      task.paneClosedAt = Date.now();
      persistTask(task);
      syncManifest();
      refreshWidget();
    }
    return `Closed the pane for ${task.label}; its result remains available`;
  };

  const readRoutedTaskResult = async (task: TaskHandle) => {
    if (task.state === "completed" && task.result !== undefined) {
      const consumedManually = markCompletionDelivered(task, "manual");
      if (consumedManually) persistTask(task);
      return { text: task.result.slice(0, 12000) || "No assistant text was captured", cached: true, truncated: task.result.length > 12000, consumedManually };
    }
    const raw = await runHerdr(pi, ["agent", "get", task.agentName!], 5000);
    const sessionPath = parseJson(raw, "herdr agent get")?.result?.agent?.agent_session?.value;
    let result = readHerdrResult(sessionPath);
    if (!result) result = await runHerdr(pi, ["agent", "read", task.agentName!, "--source", "recent-unwrapped", "--lines", "120"], 5000);
    return { text: result.slice(0, 12000) || "No result available yet", cached: false, truncated: result.length > 12000, consumedManually: false };
  };

  const readFullRoutedTaskResult = async (task: TaskHandle): Promise<RoutingRpcResult> => {
    if (task.result !== undefined) return { handle: task.handle, result: task.result, available: true };
    if (!task.agentName) return { handle: task.handle, result: "", available: false };
    try {
      const raw = await runHerdr(pi, ["agent", "get", task.agentName], 5000);
      const sessionPath = parseJson(raw, "herdr agent get")?.result?.agent?.agent_session?.value;
      let result = readHerdrResult(sessionPath);
      if (!result) result = await runHerdr(pi, ["agent", "read", task.agentName, "--source", "recent-unwrapped", "--lines", "120"], 5000);
      return { handle: task.handle, result, available: !!result };
    } catch { return { handle: task.handle, result: "", available: false }; }
  };

  const refreshRoutedTaskStatus = async (task: TaskHandle): Promise<string | undefined> => {
    if (!task.agentName) return undefined;
    try {
      const raw = await runHerdr(pi, ["agent", "get", task.agentName], 5000);
      const liveStatus = parseJson(raw, "herdr agent get")?.result?.agent?.agent_status as string | undefined;
      if (liveStatus === "working") updateTask(task, { state: "running" }, false);
      if (liveStatus === "blocked") updateTask(task, { state: "blocked" }, false);
      return liveStatus;
    } catch { return undefined; }
  };

  const stopRoutedTask = async (task: TaskHandle, closePane = false): Promise<string> => {
    watchers.get(task.handle)?.abort();
    try { await runHerdr(pi, ["agent", "send-keys", task.agentName!, "esc"], 5000); }
    catch (error) {
      if (!/agent_not_found/.test(error instanceof Error ? error.message : String(error))) { watchHerdrTask(task); throw error; }
    }
    updateTask(task, { state: "stopped", endedAt: Date.now() });
    if (closePane && task.paneId) {
      await runHerdr(pi, ["pane", "close", task.paneId], 5000);
      updateTask(task, { paneClosedAt: Date.now() }, false); persistTask(task);
    }
    return `Stopped subagent ${task.handle}${closePane ? " and closed its pane" : ""}`;
  };

  const steerTask = async (task: TaskHandle, message: string): Promise<void> => {
    let baseline = "";
    try {
      const beforeRaw = await runHerdr(pi, ["agent", "get", task.agentName!], 5000);
      baseline = readHerdrResult(parseJson(beforeRaw, "herdr agent get")?.result?.agent?.agent_session?.value);
    } catch { /* steering still proceeds */ }
    watchers.get(task.handle)?.abort();
    await runHerdr(pi, ["agent", "prompt", task.agentName!, message], 10000);
    resetCompletionDelivery(task);
    updateTask(task, { state: "running" });
    watchHerdrTask(task, baseline);
  };

  const clearRoutedTask = (task: TaskHandle): string => {
    if (isActiveTask(task)) throw new Error("Active tasks cannot be cleared; stop the task first");
    if (!task.clearedAt) {
      task.clearedAt = Date.now();
      persistTask(task);
      syncManifest();
      refreshWidget();
    }
    const retained = task.paneId && !task.paneClosedAt ? " Its pane remains open." : "";
    return `Cleared ${task.label} from the subagent list.${retained}`;
  };

  pi.registerTool<typeof RoutedTaskControlParams, any>({
    name: "subagent_control",
    label: "Subagent Control",
    description: "List, inspect, retrieve, focus, close, clear, steer, or stop Herdr agents launched by subagent. Completed panes remain available by default until explicitly closed; result returns the full cached worker output.",
    promptSnippet: "Control and retrieve sticky-model subagents",
    parameters: RoutedTaskControlParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rememberUi(ctx);
      if (params.action === "list") {
        const items = [...taskHandles.values()].filter((item) => !item.clearedAt).sort((a, b) => b.startedAt - a.startedAt);
        const text = items.length ? items.map((item) => `${item.handle} [${item.state}] ${item.route} — ${item.label}${item.paneClosedAt ? " · pane closed" : ""}`).join("\n") : "No subagents";
        return { content: [{ type: "text", text }], details: { tasks: items } };
      }
      if (!params.handle) throw new Error("handle is required");
      const task = taskHandles.get(params.handle);
      if (!task) throw new Error(`Unknown subagent handle: ${params.handle}`);

      if (params.action === "status") {
        const liveHerdrStatus = await refreshRoutedTaskStatus(task);
        const liveStatus = liveHerdrStatus ? `\nHerdr status: ${liveHerdrStatus}` : "";
        return { content: [{ type: "text", text: `${task.handle} [${task.state}] ${task.route} ${task.model} — ${task.label}${liveStatus}${task.escalation ? `\nEscalation: ${task.escalation}` : ""}` }], details: { task, liveHerdrStatus } };
      }

      if (params.action === "focus") {
        const text = await focusRoutedPane(task);
        return { content: [{ type: "text", text }], details: { task } };
      }

      if (params.action === "close") {
        const text = await closeRoutedPane(task);
        return { content: [{ type: "text", text }], details: { task } };
      }

      if (params.action === "clear") {
        const text = clearRoutedTask(task);
        return { content: [{ type: "text", text }], details: { task } };
      }

      if (params.action === "result") {
        const result = await readRoutedTaskResult(task);
        return { content: [{ type: "text", text: result.text }], details: { task, ...result } };
      }

      if (params.action === "steer") {
        if (!params.message?.trim()) throw new Error("message is required for steer");
        await steerTask(task, params.message.trim());
        return { content: [{ type: "text", text: `Steered subagent ${task.handle}` }], details: { task } };
      }

      if (params.action === "stop") {
        const text = await stopRoutedTask(task, params.close_pane === true);
        return { content: [{ type: "text", text }], details: { task } };
      }

      throw new Error(`Unsupported action: ${params.action}`);
    },
  });

  const getRoutedTask = (handle: string): TaskHandle => {
    const task = taskHandles.get(handle);
    if (!task) throw new Error(`Unknown subagent handle: ${handle}`);
    return task;
  };
  const bindEventSubscriptions = () => {
    for (const unsubscribe of eventUnsubs.splice(0)) unsubscribe();
    const routingRpc = registerRoutingRpc(pi.events, {
      launch: async (params, owner) => {
        const ctx = activeCtx ?? (() => { throw new Error("No active session"); })();
        if (ctx.hasUI !== true) throw new Error("routing RPC can only launch from the user-facing root Pi session");
        const result = await launchRoutedTask({
          pi, taskHandles, workflowLaunches, routeRetryGuard, recordDecision,
          resolveRoute, trackTask, watchHerdrTask, manifestPath,
        }, ctx, params, owner);
        return { ...result, handle: result.task?.handle ?? result.details.handle };
      },
      status: async (handle) => {
        const task = getRoutedTask(handle);
        await refreshRoutedTaskStatus(task);
        return taskMetadata(task);
      },
      result: async (handle) => readFullRoutedTaskResult(getRoutedTask(handle)),
      steer: async (handle, message) => {
        const task = getRoutedTask(handle);
        await steerTask(task, message);
        return taskMetadata(task);
      },
      list: async () => [...taskHandles.values()].map(taskMetadata),
      stop: async (handle, closePane) => {
        const task = getRoutedTask(handle);
        await stopRoutedTask(task, closePane);
        return taskMetadata(task);
      },
    });
    eventUnsubs.push(routingRpc.unsubscribe);
  };

  const listedTasks = () => [...taskHandles.values()].filter((task) => !task.clearedAt).sort((a, b) => b.startedAt - a.startedAt);

  const resolveListedTask = (query: string): TaskHandle => {
    const normalized = query.trim().toLowerCase();
    const tasks = listedTasks();
    const exact = tasks.find((task) => task.handle.toLowerCase() === normalized || task.label.toLowerCase() === normalized);
    if (exact) return exact;
    const matches = tasks.filter((task) => task.label.toLowerCase().includes(normalized));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`More than one subagent matches ${JSON.stringify(query)}`);
    throw new Error(`No subagent matches ${JSON.stringify(query)}`);
  };

  const runRoutedCommandAction = async (action: string, task: TaskHandle, ctx: ExtensionContext) => {
    if (action === "focus") ctx.ui.notify(await focusRoutedPane(task), "info");
    else if (action === "result") {
      const result = await readRoutedTaskResult(task);
      ctx.ui.notify(boundNotification(result.text), "info");
    } else if (action === "close") ctx.ui.notify(await closeRoutedPane(task), "info");
    else if (action === "clear") ctx.ui.notify(clearRoutedTask(task), "info");
    else if (action === "stop") {
      if (!isActiveTask(task)) throw new Error(`${task.label} is already ${task.state}`);
      ctx.ui.notify(await stopRoutedTask(task, true), "info");
    }
    else throw new Error(`Unknown subagents action: ${action}`);
  };

  pi.registerCommand("subagents", {
    description: "Open, inspect, stop, close, or clear a subagent",
    getArgumentCompletions: (prefix) => {
      const actions = ["focus", "result", "stop", "close", "clear"];
      const separator = prefix.indexOf(" ");
      if (separator < 0) {
        const matches = actions.filter((action) => action.startsWith(prefix.toLowerCase()));
        return matches.length ? matches.map((action) => ({ value: action, label: action })) : null;
      }
      const verb = prefix.slice(0, separator).toLowerCase();
      if (!actions.includes(verb)) return null;
      const query = prefix.slice(separator + 1).trimStart().toLowerCase();
      const tasks = listedTasks();
      const duplicateLabels = new Map<string, number>();
      for (const task of tasks) duplicateLabels.set(task.label, (duplicateLabels.get(task.label) ?? 0) + 1);
      const matches = tasks.filter((task) => !query || task.label.toLowerCase().includes(query) || task.handle.toLowerCase().startsWith(query));
      if (!matches.length) return null;
      return matches.map((task) => {
        const useHandle = query.startsWith("rt-") || (duplicateLabels.get(task.label) ?? 0) > 1;
        return {
          value: `${verb} ${useHandle ? task.handle : task.label}`,
          label: task.label,
          description: `${formatModelLabel(task.model)} · ${task.state}${task.paneClosedAt ? " · closed" : ""}`,
        };
      });
    },
    handler: async (args, ctx) => {
      rememberUi(ctx);
      try {
        const trimmed = args.trim();
        let task: TaskHandle;
        let action: string | undefined;
        if (trimmed) {
          const [verb, ...queryParts] = trimmed.split(/\s+/);
          const aliases: Record<string, string> = { open: "focus", focus: "focus", show: "result", view: "result", result: "result", close: "close", clear: "clear", remove: "clear", stop: "stop", kill: "stop" };
          action = aliases[verb.toLowerCase()];
          if (!action) throw new Error("Usage: /subagents [focus|result|stop|close] <handle or task name>, or /subagents clear [<handle or task name>]");
          if (!queryParts.length) {
            if (action !== "clear") throw new Error("Usage: /subagents [focus|result|stop|close] <handle or task name>, or /subagents clear [<handle or task name>]");
            const finished = listedTasks().filter((item) => !isActiveTask(item));
            if (!finished.length) { ctx.ui.notify("No finished subagents to clear", "info"); return; }
            const retainedPanes = finished.filter((item) => item.paneId && !item.paneClosedAt).length;
            for (const item of finished) clearRoutedTask(item);
            const agentWord = finished.length === 1 ? "subagent" : "subagents";
            const paneNote = retainedPanes ? ` ${retainedPanes} retained ${retainedPanes === 1 ? "pane remains" : "panes remain"} open.` : "";
            ctx.ui.notify(`Cleared ${finished.length} finished ${agentWord} from the list.${paneNote}`, "info");
            return;
          }
          task = resolveListedTask(queryParts.join(" "));
        } else {
          const tasks = listedTasks();
          if (!tasks.length) { ctx.ui.notify("No subagents", "info"); return; }
          const duplicateLabels = new Map<string, number>();
          for (const item of tasks) duplicateLabels.set(item.label, (duplicateLabels.get(item.label) ?? 0) + 1);
          const choices = tasks.map((item) => {
            const disambiguator = (duplicateLabels.get(item.label) ?? 0) > 1 ? ` · ${item.handle.slice(-4)}` : "";
            return { item, label: `${item.label} · ${formatModelLabel(item.model)} · ${item.state}${item.paneClosedAt ? " · closed" : ""}${disambiguator}` };
          });
          const selected = await ctx.ui.select("Subagents", choices.map((choice) => choice.label));
          if (!selected) return;
          task = choices.find((choice) => choice.label === selected)!.item;
          const actions: Array<{ label: string; action: string }> = [];
          if (task.paneId && !task.paneClosedAt) actions.push({ label: "Open pane", action: "focus" });
          actions.push({ label: "Show result", action: "result" });
          if (isActiveTask(task)) actions.push({ label: "Stop and close pane", action: "stop" });
          if (!isActiveTask(task) && task.paneId && !task.paneClosedAt) actions.push({ label: "Close pane", action: "close" });
          if (!isActiveTask(task)) actions.push({ label: "Clear from list", action: "clear" });
          const selectedAction = await ctx.ui.select(task.label, actions.map((item) => item.label));
          if (!selectedAction) return;
          action = actions.find((item) => item.label === selectedAction)!.action;
        }
        await runRoutedCommandAction(action, task, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "model_route",
    label: "Model Route",
    description: "Inspect the current primary session's route or recommend a task-level delegation target. It never changes the primary model; use the user-invoked /route command for an explicit manual override.",
    promptSnippet: "Inspect routing, classify delegation, or explicitly change the primary model route",
    promptGuidelines: [
      "Use model_route recommend only when a delegation target is genuinely unclear. Normally keep the primary on Sol and launch coherent delegated assignments through subagent.",
    ],
    parameters: RouteParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "status") {
        const current = selectedRoute ?? detectRoute(ctx);
        const lines = [current ? `Current route: ${routeSummary(current)}` : `Current model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`];
        if (lastDecision) lines.push(`Last delegation decision: ${decisionSummary(lastDecision)}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { route: current, lastDecision } };
      }
      if (params.action === "recommend") {
        if (!params.task?.trim()) throw new Error("task is required for recommend");
        const decision = classifyDelegation(params.task);
        recordDecision(params.task, decision);
        return { content: [{ type: "text", text: decisionSummary(decision) }], details: { decision } };
      }
      throw new Error(`Unsupported action: ${params.action}`);
    },
  });

  pi.registerCommand("route", {
    description: "Inspect/select the primary route, or run `recommend <task>` for delegation advice",
    getArgumentCompletions: (prefix) => {
      const names = ["status", "recommend", ...Object.keys(routes)];
      const items = names.filter((name) => name.startsWith(prefix)).map((name) => ({
        value: name,
        label: name,
        description: name in routes ? routeSummary(name as RouteName) : name === "recommend" ? "Classify a task without switching models" : "Show current routing state",
      }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "status") {
        const current = selectedRoute ?? detectRoute(ctx);
        ctx.ui.notify(current ? routeSummary(current) : `${ctx.model?.provider}/${ctx.model?.id}`, "info");
        return;
      }
      if (trimmed.startsWith("recommend ")) {
        const task = trimmed.slice("recommend ".length).trim();
        const decision = classifyDelegation(task);
        recordDecision(task, decision);
        ctx.ui.notify(decisionSummary(decision), "info");
        return;
      }

      let name = trimmed as RouteName;
      if (!name) {
        const selected = await ctx.ui.select(
          "Manual primary-model override",
          (Object.keys(routes) as RouteName[]).map((key) => `${key} — ${routes[key].provider}/${routes[key].model} — ${routes[key].purpose}`),
        );
        if (!selected) return;
        name = selected.split(" — ", 1)[0] as RouteName;
      }
      if (!routes[name]) {
        ctx.ui.notify(`Unknown route: ${name}`, "error");
        return;
      }
      try {
        ctx.ui.notify(await applyRoute(name, ctx), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "Agent") return;
    return {
      block: true,
      reason: "Direct Agent launch bypasses Herdr routing and dependency guards. Use subagent.",
    };
  });

  bindEventSubscriptions();

  pi.on("session_start", async (_event, ctx) => {
    bindEventSubscriptions();
    rememberUi(ctx);
    if (manifestTimer) clearInterval(manifestTimer);
    terminalInputUnsubscribe?.();
    const inheritedManifest = process.env.PI_ROUTING_MANIFEST?.trim();
    ownsManifest = !inheritedManifest && process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
    manifestPath = inheritedManifest || (ownsManifest ? manifestPathForPane(ctx.sessionManager.getSessionDir(), process.env.HERDR_PANE_ID!) : undefined);
    taskHandles.clear();
    routingManifest = readRoutingManifest(manifestPath);
    if (ownsManifest && routingManifest?.parentSessionId !== ctx.sessionManager.getSessionId()) routingManifest = undefined;
    if (inheritedManifest && routingManifest) {
      const stableParentPath = manifestPathForPane(ctx.sessionManager.getSessionDir(), routingManifest.parentPaneId);
      const stableManifest = readRoutingManifest(stableParentPath);
      if (stableManifest) { manifestPath = stableParentPath; routingManifest = stableManifest; }
    }
    const seenTasks = new Set<string>();
    for (const candidate of [...ctx.sessionManager.getEntries()].reverse()) {
      if (candidate.type !== "custom") continue;
      if (!selectedRoute && candidate.customType === "model-route") selectedRoute = (candidate.data as { name?: RouteName } | undefined)?.name;
      if (!lastDecision && candidate.customType === "delegation-route") lastDecision = candidate.data as typeof lastDecision;
      if (candidate.customType === "routed-task") {
        const data = candidate.data as TaskHandle | undefined;
        if (data?.handle && data.agentName && data.paneId && typeof data.route === "string" && data.route && !seenTasks.has(data.handle)) {
          seenTasks.add(data.handle);
          taskHandles.set(data.handle, { ...data, messageToken: data.messageToken ?? routingManifest?.tasks.find((task) => task.handle === data.handle)?.messageToken, transitions: data.transitions ?? 0, notifiedStates: data.notifiedStates ?? [] });
        }
      }
    }
    if (ownsManifest) {
      for (const task of routingManifest?.tasks ?? []) {
        if (!seenTasks.has(task.handle) && !taskHandles.has(task.handle) && typeof task.route === "string" && task.route) {
          taskHandles.set(task.handle, restoreTaskHandle(task));
        }
      }
    }
    if (parentInbox) { parentInbox.close(); parentInbox = undefined; }
    if (ownsManifest) {
      parentInboxPath = inboxPath(ctx.sessionManager.getSessionId());
      try {
        parentInbox = await startParentInbox(parentInboxPath, (message) => {
          const task = taskHandles.get(message.handle);
          if (!task || task.paneId !== message.paneId || task.messageToken !== message.token || !isActiveTask(task) || typeof message.text !== "string" || !message.text.trim() || message.text.length > 4000) return false;
          pi.sendMessage({ customType: "subagent-message", content: `Subagent ${task.label} (${task.handle}) asks:\n${message.text}`, display: true, details: { handle: task.handle } }, { deliverAs: "steer", triggerTurn: true });
          return true;
        });
      } catch { parentInboxPath = undefined; }
    } else parentInboxPath = undefined;
    syncManifest();
    updateStatus(ctx);
    refreshWidget();
    refreshParentMetadata();
    if (ctx.mode === "tui" && manifestPath) {
      terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => routedWidget?.handleTerminalInput(data, ctx.ui.getEditorText()));
      manifestTimer = setInterval(() => {
        const next = readRoutingManifest(manifestPath);
        if (!next) return;
        const signature = JSON.stringify(next);
        if (signature === manifestSignature) return;
        manifestSignature = signature;
        routingManifest = next;
        refreshWidget();
      }, 500);
    }

    if (!ownsManifest) return;
    for (const task of taskHandles.values()) {
      if (["completed", "failed", "stopped", "abandoned"].includes(task.state)) continue;
      if (!task.agentName) continue;
      try { await runHerdr(pi, ["agent", "get", task.agentName], 3000); watchHerdrTask(task); }
      catch (error) { updateTask(task, { state: "abandoned", endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }); }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const watcher of watchers.values()) watcher.abort();
    watchers.clear();
    if (parentInbox) { parentInbox.close(); parentInbox = undefined; }
    if (parentInboxPath) { rmSync(parentInboxPath, { force: true }); parentInboxPath = undefined; }
    if (uiCtx && typeof uiCtx.ui?.setWidget === "function") {
      try { uiCtx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* the UI may already be gone */ }
    }
    routedWidget = undefined;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    if (manifestTimer) clearInterval(manifestTimer);
    manifestTimer = undefined;
    uiCtx = undefined;
    activeCtx = undefined;
    widgetSignature = undefined;
    for (const unsubscribe of eventUnsubs.splice(0)) unsubscribe();
  });

  pi.on("message_end", async (event) => {
    if ((event.message as any)?.role !== "assistant") return;
    syncManifest();
    refreshWidget();
  });

  pi.on("model_select", async (_event, ctx) => {
    rememberUi(ctx);
    const detected = detectRoute(ctx);
    if (detected !== selectedRoute) selectedRoute = detected;
    updateStatus(ctx);
  });
}
