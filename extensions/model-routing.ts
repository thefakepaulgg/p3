import { StringEnum } from "@earendil-works/pi-ai";
import { rmSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { Server } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyDelegation, classifyModelRoute, planFallback, routes, selectEligibleRoute, clampThinkingLevel, routeTier, type CapabilityTier, type Route, type RouteName, type RoutingDecision, type ThinkingLevel } from "./routing/policy.ts";
import { availableTaskActions, buildCompletionMessage, canDeliverCompletion, boundNotification, COMPLETION_KIND, formatModelLabel, formatTaskWidget, isActiveTask, markCompletionDelivered, markNotified, recommendEscalation, resetCompletionDelivery, taskMetadata, taskWidgetItems, telemetryRecord, WIDGET_KEY, type TaskHandle, type TaskWidgetItem } from "./routing/state.ts";
import { parseJson, proveTaskAbsent, readHerdrResult, runHerdr, verifyTaskAgent, watchHerdrTask as startHerdrWatcher } from "./routing/herdr.ts";
import { pathForResultRef, askPathForAssignment, readAssignmentReceipt, readAssignmentResult, writeCancellationIntent } from "./routing/artifacts.ts";
import { readAssignmentAsk, readPendingAssignmentAsk, writeAssignmentReply, cancelAssignmentAsk, type AssignmentAsk } from "./routing/questions.ts";
import { orchestrationError, orchestrationErrorResult } from "./routing/errors.ts";
import { ensureWorkerEditor, saveRoutedInstruction } from "./routing/editor-guard.ts";
import { prepareEvidence } from "./routing/evidence.ts";
import { ExplicitRouteRetryGuard } from "./routing/workflow.ts";
import { openSavedAttachment, closeAttachment, refreshAttachment, listParentAttachments } from "./routing/attachments.ts";
import { continueRoutedTask, launchRoutedTask, type RoutedTaskLaunchParams } from "./routing/launch.ts";
import { registerRoutingRpc, type RoutingRpcResult } from "./routing/rpc.ts";
import { emitTaskLifecycle } from "./routing/lifecycle.ts";
import { manifestPathForPane, readRoutingManifest, restoreTaskHandle, ROUTING_MANIFEST_VERSION, taskManifestRecord, writeRoutingManifest, type RoutingManifest } from "./routing/manifest.ts";
import { focusManifestPane, RoutedTaskWidget } from "./routing/navigator.ts";
import { inboxPath, sendParentMessage, startParentInbox } from "./routing/messages.ts";
import { formatEstimatedCost, sumSessionCost, aggregateUsageCoverage, readIncrementalUsage } from "./routing/usage.ts";
import { registerIndependentAgentTools } from "./routing/independent.ts";
import { providerIsCoolingDown, registerFailoverModels, wrappedModelRef } from "./routing/failover.ts";

const RouteParams = Type.Object({
  action: StringEnum(["status", "recommend"] as const),
  task: Type.Optional(Type.String({ description: "Task to classify when action is recommend" })),
});

const RoutedTaskParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Self-contained assignment for the subagent" }),
  description: Type.String({ minLength: 3, maxLength: 80, description: "Short task label" }),
  route: Type.Optional(Type.String({ minLength: 1, description: "Model override. Omit it or use auto for automatic task routing: capability routing chooses Haiku/Luna for exact bounded work (including tiny implementation), Sonnet/Sol for standard work, and Opus/Sol for strong work. It considers ambiguity, horizon, checkability and consequences, then actual availability and current-provider preference. Set it only when the user named a model for this specific task." })),
  effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high"] as const, {
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
    description: "Herdr-only completed-pane policy. close (default for bounded tasks) removes it only after persisting the result and proving receipt in the parent conversation. keep explicitly preserves it; background workers stay open.",
  })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32, description: "Explicit evidence files or durable result:<UUID> references; small UTF-8 files are snapshotted, larger files remain canonical references." })),
  readonly: Type.Optional(Type.Boolean({ description: "Restrict this worker to read/search and parent reporting; no bash, edits, writes, delegation, or MCP tools." })),
  capabilities: Type.Optional(Type.Array(StringEnum(["memory"] as const), {
    description: "Declared task capabilities. Subagents inherit configured extensions.",
  })),
  mode: Type.Optional(StringEnum(["task", "background"] as const, {
    description: "task (default) completes and wakes the primary once. background is long-lived: it is never marked complete on idle, never wakes the primary, and does not count toward the active-task limit. Pull its latest output with subagent_control action=result; stop it explicitly.",
  })),
});

const RoutedTaskControlParams = Type.Object({
  action: StringEnum(["list", "status", "result", "open", "focus", "close", "clear", "steer", "interrupt", "reply", "resume", "stop"] as const),
  handle: Type.Optional(Type.String({ description: "Subagent handle; required except for list" })),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: "Explicit direction for steer/interrupt/resume, or the answer for reply. Original tasks are never replayed." })),
  ask_id: Type.Optional(Type.String({ minLength: 1, description: "Exact outstanding question ID; required for reply." })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32, description: "Explicit evidence accompanying steer." })), 
  close_pane: Type.Optional(Type.Boolean({ description: "For Herdr stop, also close the owned pane. Default false." })),
});

export { classifyDelegation, classifyModelRoute, planFallback } from "./routing/policy.ts";
export { recommendEscalation } from "./routing/state.ts";

export default function modelRoutingExtension(pi: ExtensionAPI) {
  registerFailoverModels(pi);
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
  let attachmentTimer: ReturnType<typeof setInterval> | undefined;
  let manifestTimer: ReturnType<typeof setInterval> | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;
  let routedWidget: RoutedTaskWidget | undefined;
  let manifestSignature = "";
  let parentMetadataCount: number | undefined;
  let parentInbox: Server | undefined;
  let parentInboxPath: string | undefined;
  const completionInFlight = new Set<string>();
  const questionInFlight = new Set<string>();
  const controlsInFlight = new Set<string>();
  let completionHeldForPrompt = false;

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
    const attachments = listParentAttachments(activeCtx.sessionManager.getSessionId());
    const coverage = aggregateUsageCoverage(primary, [...tasks, ...attachments.map((record) => ({ ...record, state: record.status === "starting" ? "queued" as const : record.status === "open" ? "running" as const : "stopped" as const }))]);
    routingManifest = {
      version: ROUTING_MANIFEST_VERSION,
      parentSessionId: activeCtx.sessionManager.getSessionId(), parentPaneId: process.env.HERDR_PANE_ID!, parentInbox: parentInboxPath,
      parentSessionPath: activeCtx.sessionManager.getSessionFile(), primaryCost: primary.cost, primaryCostKnown: primary.known,
      sessionTotal: coverage.cost, sessionTotalKnown: coverage.known, sessionCostComplete: coverage.complete, missingCostSources: coverage.missingSources, pendingCostSources: coverage.pendingSources, usageScope: coverage.scope, updatedAt: Date.now(), tasks, attachments,
    };
    writeRoutingManifest(manifestPath, routingManifest);
    // Workers retain their original env path when this exact parent session moves panes.
    for (const path of new Set(tasks.map((task) => task.workerManifestPath).filter((path): path is string => !!path && path !== manifestPath))) {
      if (dirname(path) !== dirname(manifestPath) || !/^routing-pane-[A-Za-z0-9_.-]+\.json$/.test(basename(path))) continue;
      if (readRoutingManifest(path)?.parentSessionId === routingManifest.parentSessionId) writeRoutingManifest(path, routingManifest);
    }
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
    if (lines.length && total) {
      const missing = routingManifest?.missingCostSources ?? 0;
      const pending = routingManifest?.pendingCostSources ?? 0;
      lines[0] += ` · tracked ${total} (chat + subagents)${missing ? ` · partial usage: ${missing} missing` : ""}${pending ? " · usage pending" : ""}`;
    }
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
          async (target) => {
            if (target.handle === "parent") return focusManifestPane(pi, target.paneId!);
            const task = taskHandles.get(target.handle);
            if (!task || !ownsManifest) throw new Error("Open saved subagents from their owning parent session");
            await openRoutedSession(task, ctx);
          },
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
    if (persist && (previous !== task.state || patch.error !== undefined || patch.resultChars !== undefined || patch.model !== undefined || patch.thinking !== undefined || patch.paneClosedAt !== undefined || "pendingAskId" in patch || "askDeliveredId" in patch)) persistTask(task);
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

  const durableTaskResult = (task: TaskHandle): string | undefined => {
    if (task.assignmentId && task.resultHash) return readAssignmentResult(task.requestId ?? task.assignmentId, task.resultHash);
    return task.result;
  };

  const verifiedAgent = async (task: TaskHandle) => {
    const agent = parseJson(await runHerdr(pi, ["agent", "get", task.agentName!], 5000), "worker control identity")?.result?.agent;
    verifyTaskAgent(task, agent);
    return agent;
  };

  const closeAfterReceipt = async (task: TaskHandle) => {
    if (task.paneRetention !== "close" || task.paneClosedAt || !task.paneId || !task.completionNotifiedAt) return;
    try {
      await verifiedAgent(task);
      const receipt = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
      if (!receipt || receipt.outcome !== "completed" || receipt.requestId !== task.requestId || receipt.generation !== task.outcomeGeneration || readPendingAssignmentAsk(task.assignmentId!)) return;
      const deadline = Date.now() + 10000;
      while (true) {
        try { await ensureWorkerEditor(task, false, true); break; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "Worker has not reached its idle boundary" || Date.now() >= deadline) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
      await verifiedAgent(task);
      await runHerdr(pi, ["pane", "close", task.paneId], 5000);
      updateTask(task, { paneClosedAt: Date.now() });
    } catch (error) {
      updateTask(task, { error: `Result delivered; retained pane because cleanup identity could not be verified: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const acknowledgeCompletion = (task: TaskHandle, via: "message" | "manual") => {
    if (!markCompletionDelivered(task, via)) return;
    completionInFlight.delete(task.handle);
    updateTask(task, { pendingCompletion: false });
    persistTask(task);
    void closeAfterReceipt(task);
  };

  const submitCompletion = (task: TaskHandle) => {
    if (!task.pendingCompletion || !canDeliverCompletion(task) || completionInFlight.has(task.handle)) return;
    const result = durableTaskResult(task);
    if (result === undefined) return;
    completionInFlight.add(task.handle);
    try {
      pi.sendMessage({
        customType: "subagent-completion", content: buildCompletionMessage(task, result), display: true,
        details: { handle: task.handle, assignmentId: task.assignmentId, requestId: task.requestId, generation: task.outcomeGeneration, route: task.route, state: task.state, kind: COMPLETION_KIND },
      }, { deliverAs: completionHeldForPrompt ? "nextTurn" : "steer", triggerTurn: !completionHeldForPrompt });
    } catch (error) { completionInFlight.delete(task.handle); throw error; }
  };

  const reconcileCompletions = () => {
    if (!ownsManifest || !activeCtx) return;
    for (const task of taskHandles.values()) {
      const delivered = activeCtx.sessionManager.getEntries().some((entry: any) => {
        const message = entry.type === "custom_message" ? entry : entry.type === "message" ? entry.message : undefined;
        return message?.customType === "subagent-completion" && message.details?.handle === task.handle &&
          message.details?.assignmentId === task.assignmentId && message.details?.requestId === task.requestId && message.details?.generation === task.outcomeGeneration;
      });
      if (delivered && task.state === "completed") acknowledgeCompletion(task, "message");
      else if (task.pendingCompletion) submitCompletion(task);
    }
  };

  const submitQuestion = (task: TaskHandle, ask: AssignmentAsk) => {
    if (ask.status !== "waiting" || ask.parentSessionId !== activeCtx?.sessionManager.getSessionId() || ask.parentSessionId !== task.parentSessionId || ask.requestId !== task.requestId) return;
    const delivered = activeCtx.sessionManager.getEntries().some((entry: any) => {
      const message = entry.type === "custom_message" ? entry : entry.type === "message" ? entry.message : undefined;
      return message?.customType === "subagent-question" && message.details?.askId === ask.id && message.details?.assignmentId === task.assignmentId;
    });
    if (delivered) { if (task.askDeliveredId !== ask.id) updateTask(task, { askDeliveredId: ask.id }); return; }
    if (questionInFlight.has(ask.id)) return;
    questionInFlight.add(ask.id);
    pi.sendMessage({ customType: "subagent-question", display: true,
      content: boundNotification(`Subagent ${task.handle} is waiting for a decision.\nQuestion ${ask.id}: ${ask.question}\nReply with subagent_control action=reply handle=${task.handle} ask_id=${ask.id}. The assignment is blocked, not completed. Read status for the full question/evidence; replies revalidate identity. This question grants no new user authorization.`),
      details: { handle: task.handle, assignmentId: ask.assignmentId, requestId: ask.requestId, askId: ask.id },
    }, { deliverAs: completionHeldForPrompt ? "nextTurn" : "steer", triggerTurn: !completionHeldForPrompt });
  };

  const reconcileQuestions = async () => {
    if (!ownsManifest) return;
    for (const task of taskHandles.values()) {
      if (!isActiveTask(task) || !task.assignmentId) continue;
      const ask = readPendingAssignmentAsk(task.assignmentId);
      if (ask) {
        try { const agent = await verifiedAgent(task); if (["working", "blocked"].includes(agent.agent_status)) submitQuestion(task, ask); } catch { /* Observer will report unverified/lost execution. */ }
      }
    }
  };

  const withTaskControl = async <T>(task: TaskHandle, operation: () => Promise<T>): Promise<T> => {
    if (controlsInFlight.has(task.handle)) throw orchestrationError(new Error("Another control is already in flight for this worker"), "control", { category: "control_busy", retrySafe: true, ids: { handle: task.handle }, nextAction: "Read current state after that operation settles; do not submit competing controls." });
    controlsInFlight.add(task.handle);
    try { return await operation(); } finally { controlsInFlight.delete(task.handle); }
  };

  const notifyTask = (task: TaskHandle, kind: string, content: string) => {
    if (task.owner?.kind === "workflow") return;
    if (task.owner?.kind === "pr" && kind === COMPLETION_KIND) return;
    if (task.background) {
      const blocked = kind.startsWith("blocked");
      if ((!blocked && kind !== "lost") || !markNotified(task, kind)) return;
      persistTask(task);
      pi.events.emit("telegram:notify", {
        kind: "blocked", summary: `Background subagent "${task.label}" ${blocked ? "is waiting for input" : "lost its executor"}`,
        assistanceNeeded: `Inspect /subagents ${task.label}; do not replace unresolved work automatically`,
      });
      return;
    }
    if (kind === COMPLETION_KIND) {
      if (!canDeliverCompletion(task)) return;
      updateTask(task, { pendingCompletion: true });
      persistTask(task);
      submitCompletion(task);
      return;
    }
    if (!markNotified(task, kind)) return;
    persistTask(task);
    pi.sendMessage({ customType: "subagent-notification", content: boundNotification(content), display: true,
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

  const resolveRoute = (ctx: ExtensionContext, requested: string, explicit: boolean, effort?: ThinkingLevel, tier?: CapabilityTier) => {
    if (effort !== undefined && !["off", "minimal", "low", "medium", "high"].includes(effort)) throw new Error(`Effort ${String(effort)} is unsupported; maximum effort is high`);
    if (!explicit || Object.prototype.hasOwnProperty.call(routes, requested)) {
      const providerForRoute = (name: RouteName) => {
        const config = routes[name];
        return config.provider === "openai-codex" && !hasAuth(ctx, config.provider, config.model) ? "openai" : config.provider;
      };
      const selected = explicit ? undefined : selectEligibleRoute(tier ?? routeTier[requested as RouteName], {
        isAvailable: (name) => availableRoute(ctx, name),
        preferredRoute: requested as RouteName, preferredProvider: ctx.model?.provider,
        providerForRoute, isCoolingDown: providerIsCoolingDown,
      });
      const plan = explicit ? planFallback(requested as RouteName, true, (name) => availableRoute(ctx, name))
        : selected ? { route: selected, ...(selected !== requested ? { fallbackFrom: requested as RouteName } : {}) }
        : { error: `No eligible model route for ${tier ?? routeTier[requested as RouteName]} capability` };
      if ("error" in plan) throw new Error(plan.error);
      const config = routes[plan.route];
      const provider = providerForRoute(plan.route);
      return { ...plan, config: { ...config, provider, thinking: clampThinkingLevel(effort ?? config.thinking), ...(!explicit ? { launchModel: wrappedModelRef(plan.route) } : {}) } };
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
    question: (ask) => submitQuestion(task, ask),
  });

  const routedLaunch = async (params: RoutedTaskLaunchParams, ctx: ExtensionContext, owner?: unknown) => {
    const result = await launchRoutedTask({
      pi, taskHandles, workflowLaunches, routeRetryGuard, recordDecision,
      resolveRoute, trackTask, watchHerdrTask, manifestPath,
    }, ctx, params, owner);
    return { content: [{ type: "text" as const, text: result.text }], details: result.details };
  };

  registerIndependentAgentTools(pi);

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
    description: "Launch one task in a visible Herdr agent with workflow guards. Automatic tasks have a fixed starting route with bounded provider failover on exhausted usage. Explicit choices stay fixed and never silently fall back. This is fire-and-forget: after launch, do independent work or end the turn; completion automatically wakes the primary exactly once with a bounded subagent message. Do not poll status/result, sleep, tail logs, or steer merely to ask whether it finished. Retrieve durable result text with subagent_control action=result; its displayed text is capped at 12,000 characters and resultRef identifies the complete artifact.",
    promptSnippet: "Launch a guarded routed task in Herdr",
    promptGuidelines: [
      "Use subagent and subagent_control for all agent orchestration; never manage agents through the herdr CLI directly. Subagents use bounded dedicated tabs in the root workspace; never create agent splits in the user-owned root tab.",
      "Omit route and effort. Policy judges ambiguity, dependency horizon, checkability and consequences: exact bounded tiny edits can use Haiku/Luna; ordinary scoped work uses Sonnet/Sol; hard or consequential work uses Opus/Sol. There is no blanket UI/debug premium. Automatic tasks have a fixed starting route with bounded provider failover on exhausted usage; effort never exceeds high. An accurate phase and clear brief are how to influence routing. Set route or effort only when the user names a model or effort for the task being launched. Explicit choices never silently fall back.",
      "A user's model or effort request applies only to the launches it names. Do not carry it forward to later subagents, and do not set route from memory notes or earlier launches. When relaunching a stopped or failed subagent, pass route/effort only if the original launch was explicitly user-directed.",
      "Parallel subagents may share a working tree; split the work so they do not edit the same files, and declare owned_paths when overlap matters. Use depends_on when a task must wait for another to finish. Do not use subagent for simple work cheaper to do directly.",
      "After launching, either continue genuinely independent work or end the turn. Automatic completion delivery will wake the primary. Never poll subagent_control, sleep, tail logs, or send impatience steering messages while a task is merely running.",
    ],
    parameters: RoutedTaskParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.hasUI !== true) throw new Error("subagent can only launch from the user-facing root Pi session");
      rememberUi(ctx);
      try { return await routedLaunch(params as RoutedTaskLaunchParams, ctx); }
      catch (error) { return orchestrationErrorResult(error, "subagent"); }
    },
  });

  const focusRoutedPane = async (task: TaskHandle): Promise<string> => {
    if (!task.paneId) throw new Error("This task does not have a retained Herdr pane");
    if (task.paneClosedAt) throw new Error(`Pane for ${task.label} has already been closed`);
    await verifiedAgent(task);
    await focusManifestPane(pi, task.paneId);
    return `Opened ${task.label}`;
  };

  const openRoutedSession = async (task: TaskHandle, ctx: ExtensionContext) => {
    const opened = await withTaskControl(task, () => openSavedAttachment(pi, ctx, task, taskHandles.values(), manifestPath));
    syncManifest(); refreshWidget();
    return opened;
  };

  const closeRoutedPane = async (task: TaskHandle): Promise<string> => {
    const attachment = activeCtx ? listParentAttachments(activeCtx.sessionManager.getSessionId()).find((record) => record.handle === task.handle && record.status !== "closed") : undefined;
    if (attachment) {
      await closeAttachment(pi, activeCtx!, attachment.attachmentId);
      syncManifest(); refreshWidget();
      return `Closed the reopened Pi session for ${task.label}; saved history and original result remain available`;
    }
    if (!task.paneId) throw new Error("This task does not have an owned Herdr pane");
    if (isActiveTask(task)) throw new Error("The task is still active; stop it before closing its pane");
    if (task.pendingCompletion) throw new Error("Result delivery is pending; retain the pane until receipt is proven");
    if (!task.paneClosedAt) {
      const agent = await verifiedAgent(task);
      if (!["idle", "done"].includes(agent.agent_status)) throw new Error("Worker is still executing or blocked; explicitly stop it before closing");
      await ensureWorkerEditor(task, false, true);
      await runHerdr(pi, ["pane", "close", task.paneId], 5000);
      task.paneClosedAt = Date.now();
      persistTask(task);
      syncManifest();
      refreshWidget();
    }
    return `Closed the pane for ${task.label}; any verified durable result remains available`;
  };

  const readRoutedTaskResult = async (task: TaskHandle) => {
    const result = durableTaskResult(task);
    if (result !== undefined) return { text: result.slice(0, 12000), cached: task.result !== undefined, durable: !!task.resultHash, requestId: task.requestId, resultHash: task.resultHash, truncated: result.length > 12000, consumedManually: false, resultRef: task.resultRef };
    if (task.state === "failed") return { text: task.error ?? "Pi execution failed; no successful result", cached: false, truncated: false, consumedManually: false };
    const agent = await verifiedAgent(task);
    const partial = readHerdrResult(agent.agent_session?.value);
    return { text: partial ? `Partial output, NOT a completed result:\n${partial.slice(0, 12000)}` : "No verified result available yet", cached: false, truncated: partial.length > 12000, consumedManually: false };
  };

  const readFullRoutedTaskResult = async (task: TaskHandle): Promise<RoutingRpcResult> => {
    const result = durableTaskResult(task);
    if (result === undefined) return { handle: task.handle, result: "", available: false };
    if (task.owner && task.state === "completed") acknowledgeCompletion(task, "manual");
    return { handle: task.handle, result, available: true };
  };

  const refreshRoutedTaskStatus = async (task: TaskHandle): Promise<string | undefined> => {
    if (task.assignmentId) {
      const ask = readPendingAssignmentAsk(task.assignmentId);
      if (task.pendingAskId !== ask?.id) updateTask(task, { pendingAskId: ask?.id });
    }
    if (!task.agentName || task.paneClosedAt) return undefined;
    try {
      const agent = await verifiedAgent(task);
      updateTask(task, { presence: "live" }, false);
      return agent.agent_status;
    } catch (error) {
      updateTask(task, { presence: "unknown", error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };

  const waitForSettledWorker = async (task: TaskHandle, generation: number) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const agent = await verifiedAgent(task);
      const receipt = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
      if (receipt && receipt.sessionId === task.sessionId && receipt.paneId === task.paneId && receipt.terminalId === task.terminalId && receipt.generation >= generation && receipt.outcome !== "running" && ["idle", "done"].includes(agent.agent_status)) return receipt;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Worker did not reach a verified settled boundary after interruption");
  };

  const stopRoutedTask = async (task: TaskHandle, closePane = false): Promise<string> => {
    if (task.state === "lost") {
      if (!await proveTaskAbsent(pi, task)) throw new Error("Original session is now present or moved; inspect before abandoning it");
      const receipt = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
      if (!receipt?.workerPid) throw new Error("Original process exit is unverified; inspect before abandonment");
      try { process.kill(receipt.workerPid, 0); throw new Error("Original process is still present despite missing registry evidence"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (task.assignmentId && readPendingAssignmentAsk(task.assignmentId)) cancelAssignmentAsk(task.assignmentId);
      watchers.get(task.handle)?.abort();
      updateTask(task, { state: "stopped", pendingAskId: undefined, pendingCompletion: false, endedAt: Date.now() });
      return `Abandoned unresolved subagent ${task.handle}; no physical resources were removed or external effects rolled back`;
    }
    await verifiedAgent(task);
    const original = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
    if (!original) throw new Error("Worker's current assignment is unverified; cancellation cannot guess it");
    watchers.get(task.handle)?.abort();
    try {
      writeCancellationIntent(original);
      await runHerdr(pi, ["agent", "send-keys", task.agentName!, "esc"], 5000);
      await waitForSettledWorker(task, original.generation);
      if (task.assignmentId && readPendingAssignmentAsk(task.assignmentId)) cancelAssignmentAsk(task.assignmentId);
    } catch (error) {
      watchHerdrTask(task);
      throw orchestrationError(error, "stop", { stage: "cancellation_boundary", retrySafe: "unknown", ids: { handle: task.handle, paneId: task.paneId }, nextAction: "Inspect the original worker before repeating cancellation; no settled boundary or question cancellation was guessed." });
    }
    completionInFlight.delete(task.handle);
    updateTask(task, { state: "stopped", pendingCompletion: false, pendingAskId: undefined, endedAt: Date.now() });
    if (closePane && task.paneId) {
      await verifiedAgent(task);
      await runHerdr(pi, ["pane", "close", task.paneId], 5000);
      updateTask(task, { paneClosedAt: Date.now() });
    }
    return `Stopped subagent ${task.handle}${closePane ? " and closed its pane" : ""}; external effects were not rolled back`;
  };

  const steerTask = async (task: TaskHandle, message: string, files?: string[], editorPrepared = false): Promise<void> => {
    const evidence = prepareEvidence(files, task.cwd ?? activeCtx!.cwd, pathForResultRef);
    if (task.assignmentId && readPendingAssignmentAsk(task.assignmentId)) throw new Error("Worker has a blocking question; use reply with its exact ask_id instead of steering");
    const previous = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
    if (!isActiveTask(task) || previous?.outcome === "completed" || previous?.outcome === "error") throw new Error("This assignment has finished; close its retained pane and resume the saved session for follow-up");
    await verifiedAgent(task);
    if (!editorPrepared) await ensureWorkerEditor(task, task.state === "interrupted");
    watchers.get(task.handle)?.abort();
    completionInFlight.delete(task.handle);
    resetCompletionDelivery(task);
    const requestId = crypto.randomUUID();
    const prompt = [`p3:routed-request ${requestId}`, message, evidence.text].filter(Boolean).join("\n");
    saveRoutedInstruction(task.assignmentId!, requestId, prompt);
    updateTask(task, { requestId, instructionIds: [...(task.instructionIds ?? []), requestId].slice(-32), state: "queued", outcomeGeneration: undefined, pendingCompletion: false, result: undefined, resultHash: undefined, resultRef: undefined, resultPath: undefined, error: undefined });
    persistTask(task);
    try {
      await runHerdr(pi, ["agent", "prompt", task.agentName!, prompt], 10000);
      updateTask(task, { state: "running" });
    } catch (error) {
      updateTask(task, { state: "unknown", presence: "unknown", error: `Steering submission is unresolved; do not resubmit blindly: ${error instanceof Error ? error.message : String(error)}` });
      throw orchestrationError(error, "steer", { stage: "direction_submission", ids: { handle: task.handle, requestId, paneId: task.paneId, sessionId: task.sessionId }, retrySafe: "unknown", nextAction: "Inspect the original worker and submitted request before retrying; the direction may already be queued." });
    } finally { watchHerdrTask(task); }
  };

  const interruptTask = async (task: TaskHandle, message: string, files?: string[]) => {
    prepareEvidence(files, task.cwd ?? activeCtx!.cwd, pathForResultRef);
    if (!task.assignmentId || readPendingAssignmentAsk(task.assignmentId)) throw new Error("Reply to the outstanding question or explicitly stop it; there is no interruptible working operation");
    const before = await verifiedAgent(task);
    const original = readAssignmentReceipt(task.assignmentId);
    if (before.agent_status !== "working" || !original || original.outcome !== "running") throw new Error("Worker has no verified current operation to interrupt");
    watchers.get(task.handle)?.abort();
    try {
      writeCancellationIntent(original);
      await runHerdr(pi, ["agent", "send-keys", task.agentName!, "esc"], 5000);
      const settled = await waitForSettledWorker(task, original.generation);
      if (settled.outcome === "completed") {
        updateTask(task, { requestId: settled.requestId, state: "running" });
        return "The operation completed before cancellation. Its verified result is preserved for delivery; no replacement instruction was submitted. Use resume for follow-up after cleanup.";
      }
      updateTask(task, { state: "interrupted" });
      await ensureWorkerEditor(task, true, true);
      await steerTask(task, message, files, true);
      return `Interrupted the current operation and continued ${task.handle} with the explicit replacement direction. Prior effects were not rolled back; queued owned corrections were superseded.`;
    } catch (error) {
      throw orchestrationError(error, "interrupt", { stage: "interruption_boundary", ids: { handle: task.handle, paneId: task.paneId, sessionId: task.sessionId }, retrySafe: "unknown", nextAction: "Inspect the settled worker and its preserved editor before retrying; cancellation may have happened, but no unverified draft is erased or concatenated." });
    } finally { if (isActiveTask(task)) watchHerdrTask(task); }
  };

  const replyTask = async (task: TaskHandle, askId: string, message: string, files?: string[]) => {
    const evidence = prepareEvidence(files, activeCtx!.cwd, pathForResultRef);
    const agent = await verifiedAgent(task);
    if (!task.assignmentId || !task.requestId || !task.sessionId || !task.terminalId || !["working", "blocked"].includes(agent.agent_status)) throw new Error("Worker is not live and waiting for this reply");
    let answered: AssignmentAsk;
    try { answered = writeAssignmentReply(task.assignmentId, askId, [message, evidence.text].filter(Boolean).join("\n\n"), {
      requestId: task.requestId, parentSessionId: activeCtx!.sessionManager.getSessionId(), sessionId: task.sessionId, paneId: task.paneId!, terminalId: task.terminalId,
    }); } catch (error) { throw orchestrationError(error, "reply", { stage: "question_reply", ids: { handle: task.handle, askId, assignmentId: task.assignmentId }, retrySafe: (error as NodeJS.ErrnoException).code === "EEXIST" ? true : false, nextAction: "Read the exact current question/reply state; an already retained answer must not be resubmitted." }); }
    return { text: `Recorded answer ${answered.replyId} for question ${askId}. The waiting tool resumes the same assignment; no task or prompt was replayed.`, askId, replyId: answered.replyId };
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
    description: "List, inspect, retrieve, focus, close, clear, steer, or stop Herdr agents launched by subagent. open focuses a live worker or reopens its owned saved Pi session without submitting a task; close also closes a human-reopened session. Bounded worker panes close after delivered completion unless keep was explicitly requested; resume creates a fresh generation from the exact saved session; result reads hash-verified durable worker output (returned text is capped at 12,000 characters). List/status expose available_actions and nextAction; unknown identity never authorizes a mutation.",
    promptSnippet: "Control and retrieve routed subagents",
    promptGuidelines: ["Use open only on an explicit user request to browse a saved worker conversation. It activates an interactive Pi session; it is not a progress-polling tool."],
    parameters: RoutedTaskControlParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rememberUi(ctx);
      try {
      if (params.action === "list") {
        const items = [...taskHandles.values()].filter((item) => !item.clearedAt).sort((a, b) => b.startedAt - a.startedAt);
        const attachments = activeCtx ? listParentAttachments(activeCtx.sessionManager.getSessionId()) : [];
        const text = items.length ? items.map((item) => `${item.handle} [${item.state}] ${item.route} — ${item.label}${item.paneClosedAt ? " · pane closed" : ""}`).join("\n") : "No subagents";
        return { content: [{ type: "text", text }], details: { tasks: items.map((task) => ({ ...task, ...taskMetadata(task), result: undefined })), attachments } };
      }
      if (!params.handle) throw new Error("handle is required");
      const task = taskHandles.get(params.handle);
      if (!task) throw new Error(`Unknown subagent handle: ${params.handle}`);

      if (params.action === "status") {
        const liveHerdrStatus = await refreshRoutedTaskStatus(task);
        const liveStatus = liveHerdrStatus ? `\nHerdr status: ${liveHerdrStatus}` : "";
        const question = task.assignmentId ? readAssignmentAsk(task.assignmentId) : undefined;
        const questionText = question ? `\nQuestion ${question.id} [${question.status}]: ${question.question}${question.evidence ? `\nComplete evidence snapshot: ${askPathForAssignment(task.assignmentId!)}` : ""}` : "";
        return { content: [{ type: "text", text: `${task.handle} [${task.state}] ${task.route} ${task.model} — ${task.label}${liveStatus}${questionText}${task.escalation ? `\nEscalation: ${task.escalation}` : ""}` }], details: { task: { ...task, ...taskMetadata(task), result: undefined }, ...taskMetadata(task), liveHerdrStatus, question: task.assignmentId ? readAssignmentAsk(task.assignmentId) : undefined } };
      }

      if (params.action === "open") {
        const opened = await openRoutedSession(task, ctx);
        return { content: [{ type: "text", text: opened.text }], details: { handle: task.handle, attachment: opened.record, ...opened.record } };
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

      if (params.action === "resume") {
        if (!params.message?.trim()) throw new Error("message is required for resume");
        return await withTaskControl(task, async () => {
          const result = await continueRoutedTask({ pi, taskHandles, workflowLaunches, routeRetryGuard, recordDecision, resolveRoute, trackTask, watchHerdrTask, manifestPath }, ctx, task, params.message!.trim(), params.files);
          return { content: [{ type: "text", text: result.text }], details: result.details };
        });
      }
      if (params.action === "reply") {
        if (!params.ask_id || !params.message?.trim()) throw new Error("ask_id and message are required for reply");
        return await withTaskControl(task, async () => { const result = await replyTask(task, params.ask_id!, params.message!.trim(), params.files); return { content: [{ type: "text", text: result.text }], details: result }; });
      }
      if (params.action === "interrupt") {
        if (!params.message?.trim()) throw new Error("message is required for interrupt");
        return await withTaskControl(task, async () => ({ content: [{ type: "text", text: await interruptTask(task, params.message!.trim(), params.files) }], details: { task: taskMetadata(task) } }));
      }
      if (params.action === "steer") {
        if (!params.message?.trim()) throw new Error("message is required for steer");
        await withTaskControl(task, () => steerTask(task, params.message!.trim(), params.files));
        return { content: [{ type: "text", text: `Steered subagent ${task.handle}` }], details: { task } };
      }

      if (params.action === "stop") {
        const text = await withTaskControl(task, () => stopRoutedTask(task, params.close_pane === true));
        return { content: [{ type: "text", text }], details: { task } };
      }

      throw new Error(`Unsupported action: ${params.action}`);
      } catch (error) { return orchestrationErrorResult(error, `subagent_control.${params.action}`, { ids: { handle: params.handle } }); }
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
        await withTaskControl(task, () => steerTask(task, message));
        return taskMetadata(task);
      },
      list: async () => [...taskHandles.values()].map(taskMetadata),
      stop: async (handle, closePane) => {
        const task = getRoutedTask(handle);
        await withTaskControl(task, () => stopRoutedTask(task, closePane));
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
    if (["resume", "reply", "interrupt"].includes(action)) {
      const ask = task.assignmentId ? readPendingAssignmentAsk(task.assignmentId) : undefined;
      if (action === "reply" && !ask) throw new Error("No outstanding question is available to reply to");
      const instruction = await ctx.ui.editor(action === "reply" ? `Reply to ${ask!.question}` : action === "resume" ? "Explicit follow-up for the saved session" : "Replacement direction after interrupting the current operation");
      if (!instruction?.trim()) return;
      if (instruction.length > 20000) throw new Error("Instruction exceeds 20,000 characters");
      await withTaskControl(task, async () => {
        if (action === "resume") {
          const result = await continueRoutedTask({ pi, taskHandles, workflowLaunches, routeRetryGuard, recordDecision, resolveRoute, trackTask, watchHerdrTask, manifestPath }, ctx, task, instruction.trim());
          ctx.ui.notify(result.text, "info");
        } else if (action === "reply") ctx.ui.notify((await replyTask(task, ask!.id, instruction.trim())).text, "info");
        else ctx.ui.notify(await interruptTask(task, instruction.trim()), "info");
      });
    } else if (action === "open") ctx.ui.notify((await openRoutedSession(task, ctx)).text, "info");
    else if (action === "focus") ctx.ui.notify(await focusRoutedPane(task), "info");
    else if (action === "result") {
      const result = await readRoutedTaskResult(task);
      ctx.ui.notify(boundNotification(result.text), "info");
    } else if (action === "close") ctx.ui.notify(await closeRoutedPane(task), "info");
    else if (action === "clear") ctx.ui.notify(clearRoutedTask(task), "info");
    else if (action === "stop") {
      if (!isActiveTask(task)) throw new Error(`${task.label} is already ${task.state}`);
      ctx.ui.notify(await withTaskControl(task, () => stopRoutedTask(task, true)), "info");
    }
    else throw new Error(`Unknown subagents action: ${action}`);
  };

  pi.registerCommand("subagents", {
    description: "Open a worker or its saved Pi conversation; reply, interrupt, resume, stop, close, or clear",
    getArgumentCompletions: (prefix) => {
      const actions = ["open", "focus", "result", "reply", "interrupt", "resume", "stop", "close", "clear"];
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
          const aliases: Record<string, string> = { open: "open", focus: "focus", show: "result", view: "result", result: "result", close: "close", clear: "clear", remove: "clear", stop: "stop", kill: "stop", reply: "reply", interrupt: "interrupt", resume: "resume" };
          action = aliases[verb.toLowerCase()];
          if (!action) throw new Error("Usage: /subagents [open|focus|result|reply|interrupt|resume|stop|close] <handle or task name>, or /subagents clear [<handle or task name>]");
          if (!queryParts.length) {
            if (action !== "clear") throw new Error("Usage: /subagents [open|focus|result|reply|interrupt|resume|stop|close] <handle or task name>, or /subagents clear [<handle or task name>]");
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
          action = "open";
        }
        await runRoutedCommandAction(action, task, ctx);
      } catch (error) {
        const failure = orchestrationError(error, "subagents");
        ctx.ui.notify(`${failure.message}\n${failure.detail.nextAction}`, "error");
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
    if (attachmentTimer) clearInterval(attachmentTimer);
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
        if (data?.parentSessionId && data.parentSessionId !== ctx.sessionManager.getSessionId()) continue;
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
    if (ownsManifest) {
      for (const task of taskHandles.values()) {
        if (task.costComplete !== false || !task.sessionPath) continue;
        if (!isActiveTask(task) && (task.usageOffset ?? 0) <= (task.usageStartOffset ?? 0)) continue;
        const usage = readIncrementalUsage(task.sessionPath, { sessionPath: task.sessionPath, offset: task.usageOffset ?? 0,
          cost: task.estimatedCost ?? 0, costKnown: task.costKnown ?? false, complete: false },
          { startOffset: task.usageStartOffset ?? 0, ...(!isActiveTask(task) ? { endOffset: task.usageOffset ?? 0 } : {}) });
        Object.assign(task, { usageOffset: usage.offset, estimatedCost: usage.cost, costKnown: usage.costKnown, costComplete: usage.complete });
        if (usage.changed) persistTask(task);
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
    completionInFlight.clear(); questionInFlight.clear();
    completionHeldForPrompt = false;
    reconcileCompletions(); await reconcileQuestions();
    let refreshingAttachments = false;
    const reconcileAttachments = async () => {
      if (refreshingAttachments || !activeCtx) return;
      refreshingAttachments = true;
      try {
        for (const record of listParentAttachments(activeCtx.sessionManager.getSessionId())) {
          if (record.status !== "closed") await refreshAttachment(pi, record.attachmentId).catch(() => undefined);
        }
        syncManifest(); refreshWidget();
      } finally { refreshingAttachments = false; }
    };
    await reconcileAttachments();
    attachmentTimer = setInterval(() => { void reconcileAttachments(); }, 1000);
    for (const task of taskHandles.values()) {
      if (isActiveTask(task) && task.agentName) watchHerdrTask(task);
      else if (task.completionNotifiedAt) void closeAfterReceipt(task);
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
    if (attachmentTimer) clearInterval(attachmentTimer);
    attachmentTimer = undefined;
    uiCtx = undefined;
    activeCtx = undefined;
    widgetSignature = undefined;
    for (const unsubscribe of eventUnsubs.splice(0)) unsubscribe();
  });

  pi.on("message_end", async (event) => {
    const message = event.message as any;
    if (message.role === "custom" && message.customType === "subagent-question") {
      const task = taskHandles.get(message.details?.handle);
      if (task && task.assignmentId === message.details?.assignmentId && task.pendingAskId === message.details?.askId) {
        questionInFlight.delete(message.details.askId); updateTask(task, { askDeliveredId: message.details.askId });
      }
    }
    if (message.role === "custom" && message.customType === "subagent-completion") {
      const task = taskHandles.get(message.details?.handle);
      if (task?.state === "completed" && task.assignmentId === message.details?.assignmentId && task.requestId === message.details?.requestId && task.outcomeGeneration === message.details?.generation) acknowledgeCompletion(task, "message");
    }
    if (message.role === "toolResult" && message.toolName === "subagent_control") {
      const task = taskHandles.get(message.details?.task?.handle);
      if (task?.state === "completed" && task.resultHash && message.details?.durable === true && message.details.requestId === task.requestId && message.details.resultHash === task.resultHash) acknowledgeCompletion(task, "manual");
    }
    syncManifest(); refreshWidget();
  });
  pi.on("agent_end", (event) => {
    const aborted = event.messages.some((message: any) => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error" && /aborted/i.test(message.errorMessage ?? "")));
    if (aborted) { completionInFlight.clear(); questionInFlight.clear(); completionHeldForPrompt = true; }
  });
  pi.on("agent_settled", async () => { reconcileCompletions(); await reconcileQuestions(); });
  pi.on("before_agent_start", () => { completionHeldForPrompt = false; });

  pi.on("model_select", async (_event, ctx) => {
    rememberUi(ctx);
    const detected = detectRoute(ctx);
    if (detected !== selectedRoute) selectedRoute = detected;
    updateStatus(ctx);
  });
}
