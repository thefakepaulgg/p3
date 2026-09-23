import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringEnum, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "notify_user";
const STATUS_KEY = "telegram-notify";
const OWNER_KEY = Symbol.for("pi-telegram-notify:primary-owner");
const DEDUPE_WINDOW_MS = 10 * 60 * 1_000;

const NotifyParams = Type.Object({
  kind: StringEnum(["completed", "blocked"] as const, {
    description: "Whether the root user task completed or needs user assistance.",
  }),
  summary: Type.String({
    description: "A short, sanitized description of the completed task or blocker.",
    minLength: 1,
    maxLength: 500,
  }),
  assistance_needed: Type.Optional(Type.String({
    description: "The concrete user action required. Required when kind is blocked.",
    minLength: 1,
    maxLength: 500,
  })),
});

type NotificationKind = "completed" | "blocked";
type StopReason = AssistantMessage["stopReason"];

interface NotificationIntent {
  kind: NotificationKind;
  summary: string;
  assistanceNeeded?: string;
}

interface NotificationState {
  enabled: boolean;
  repliesEnabled: boolean;
  testPassedAt?: string;
  lastSentAt?: string;
  lastKind?: NotificationKind | "test";
  lastFingerprint?: string;
  lastError?: string;
}

interface NotifyDetails {
  kind: NotificationKind;
  queued?: boolean;
  delivered?: boolean;
  duplicate?: boolean;
  error?: string;
}

export interface TelegramNotifyExtensionOptions {
  statePath?: string;
  helperPath?: string;
  helperTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  deliver?: (message: string) => Promise<void>;
  receive?: (routeId: string) => Promise<string[]>;
  replyPollIntervalMs?: number;
  claimPrimary?: (instance: object) => boolean;
  releasePrimary?: (instance: object) => void;
}

const defaultState = (): NotificationState => ({ enabled: false, repliesEnabled: false });

function normalizeText(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function sanitizeText(value: string, maxLength = 500): string {
  const redacted = value
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[REDACTED]");
  return normalizeText(redacted, maxLength);
}

function loadState(path: string): NotificationState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NotificationState>;
    return {
      enabled: parsed.enabled === true,
      repliesEnabled: parsed.repliesEnabled === true,
      ...(typeof parsed.testPassedAt === "string" && { testPassedAt: parsed.testPassedAt }),
      ...(typeof parsed.lastSentAt === "string" && { lastSentAt: parsed.lastSentAt }),
      ...((parsed.lastKind === "completed" || parsed.lastKind === "blocked" || parsed.lastKind === "test") && { lastKind: parsed.lastKind }),
      ...(typeof parsed.lastFingerprint === "string" && { lastFingerprint: parsed.lastFingerprint }),
      ...(typeof parsed.lastError === "string" && { lastError: normalizeText(parsed.lastError, 160) }),
    };
  } catch {
    return defaultState();
  }
}

function saveState(path: string, state: NotificationState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function claimPrimary(instance: object): boolean {
  const registry = globalThis as typeof globalThis & { [OWNER_KEY]?: object };
  if (!registry[OWNER_KEY]) registry[OWNER_KEY] = instance;
  return registry[OWNER_KEY] === instance;
}

function releasePrimary(instance: object): void {
  const registry = globalThis as typeof globalThis & { [OWNER_KEY]?: object };
  if (registry[OWNER_KEY] === instance) delete registry[OWNER_KEY];
}

const isBackgroundSubagent = (env: NodeJS.ProcessEnv) => env.PI_SUBAGENT_MODE === "background";

export function isEligiblePrimary(ctx: Pick<ExtensionContext, "mode" | "hasUI">, env: NodeJS.ProcessEnv): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  // Background subagents never report to the primary, so Telegram is their only outbound channel.
  if (isBackgroundSubagent(env)) return true;
  if (env.HERDR_ROLE === "helper") return false;
  const routedRootTab = env.PI_ROUTED_ROOT_TAB_ID?.trim();
  const currentTab = env.HERDR_TAB_ID?.trim();
  if (routedRootTab && currentTab !== routedRootTab) return false;
  return true;
}

function runHelper(
  helperPath: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    };
    const timeout = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(new Error("notification helper timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => finish(new Error("notification helper could not start")));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`notification helper exited with code ${code ?? "unknown"}`));
    });
    child.stdin.once("error", () => finish(new Error("notification helper input failed")));
    child.stdin.end(input);
  });
}

export async function deliverWithHelper(
  helperPath: string,
  message: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 12_000,
): Promise<void> {
  await runHelper(helperPath, ["send"], message, env, timeoutMs);
}

export async function receiveWithHelper(
  helperPath: string,
  routeId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 12_000,
): Promise<string[]> {
  const output = await runHelper(helperPath, ["receive", routeId], "", env, timeoutMs);
  const parsed: unknown = JSON.parse(output || "[]");
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("notification helper returned invalid replies");
  }
  return parsed;
}

function fingerprint(intent: NotificationIntent): string {
  return createHash("sha256")
    .update(intent.kind)
    .update("\0")
    .update(intent.summary)
    .update("\0")
    .update(intent.assistanceNeeded ?? "")
    .digest("hex");
}

function formatMessage(intent: NotificationIntent, ctx: ExtensionContext, routeId?: string): string {
  const project = basename(ctx.cwd) || ctx.cwd;
  const sessionName = ctx.sessionManager.getSessionName();
  const lines = [
    intent.kind === "completed" ? "✅ Pi task completed" : "⛔ Pi needs your help",
    `Task: ${normalizeText(intent.summary)}`,
  ];
  if (intent.kind === "blocked" && intent.assistanceNeeded) {
    lines.push(`Need: ${normalizeText(intent.assistanceNeeded)}`);
  }
  lines.push(`Project: ${normalizeText(project, 120)}`, `Host: ${normalizeText(hostname(), 120)}`);
  if (sessionName) lines.push(`Session: ${normalizeText(sessionName, 120)}`);
  if (routeId) lines.push("Reply to this message to respond.", `[pi:${routeId}]`);
  return lines.join("\n");
}

export function createTelegramNotifyExtension(options: TelegramNotifyExtensionOptions = {}) {
  return function telegramNotifyExtension(pi: ExtensionAPI) {
    const instance = {};
    const statePath = options.statePath ?? join(homedir(), ".local", "state", "pi", "telegram-notify.json");
    const helperPath = options.helperPath ?? join(homedir(), ".local", "bin", "pi-telegram-notify");
    const env = options.env ?? process.env;
    const helperTimeoutMs = options.helperTimeoutMs ?? 12_000;
    const now = options.now ?? (() => new Date());
    const deliver = options.deliver ?? ((message: string) => deliverWithHelper(helperPath, message, env, helperTimeoutMs));
    const receive = options.receive ?? ((routeId: string) => receiveWithHelper(helperPath, routeId, env, Math.max(helperTimeoutMs, 20_000)));
    const replyPollIntervalMs = options.replyPollIntervalMs ?? 3_000;
    let routeId = randomBytes(8).toString("hex");
    const claim = options.claimPrimary ?? claimPrimary;
    const release = options.releasePrimary ?? releasePrimary;

    let state = loadState(statePath);
    let eligible = false;
    let ownsPrimary = false;
    let toolRegistered = false;
    let pendingCompletion: NotificationIntent | undefined;
    let assistantEndedAfterIntent = false;
    let lastAssistantStopReason: StopReason | undefined;
    let warnedDeliveryFailure = false;
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    let replyContext: ExtensionContext | undefined;
    let replyGeneration = 0;

    const persist = () => saveState(statePath, state);
    const isEnabled = () => eligible && state.enabled;
    // Replies route to the primary only; a second poller would steal its updates.
    const areRepliesEnabled = () => isEnabled() && state.repliesEnabled && !isBackgroundSubagent(env);

    const updateStatus = (ctx: ExtensionContext) => {
      const value = !eligible
        ? "telegram:unavailable"
        : !state.enabled
          ? "telegram:off"
          : state.lastError
            ? "telegram:error"
            : "telegram:ready";
      ctx.ui.setStatus(STATUS_KEY, value);
    };

    const recordFailure = (ctx: ExtensionContext, error: unknown) => {
      state.lastError = normalizeText(error instanceof Error ? error.message : String(error), 160);
      persist();
      updateStatus(ctx);
      if (!warnedDeliveryFailure) {
        warnedDeliveryFailure = true;
        ctx.ui.notify("Telegram notification delivery failed. Run /notify status for details.", "warning");
      }
    };

    const send = async (intent: NotificationIntent, ctx: ExtensionContext, bypassDedupe = false): Promise<{ duplicate: boolean }> => {
      const digest = fingerprint(intent);
      const lastSentMs = state.lastSentAt ? Date.parse(state.lastSentAt) : Number.NaN;
      if (!bypassDedupe && state.lastFingerprint === digest && Number.isFinite(lastSentMs)
          && now().getTime() - lastSentMs < DEDUPE_WINDOW_MS) {
        return { duplicate: true };
      }

      await deliver(formatMessage(intent, ctx, areRepliesEnabled() ? routeId : undefined));
      state.lastSentAt = now().toISOString();
      state.lastKind = intent.kind;
      state.lastFingerprint = digest;
      state.lastError = undefined;
      persist();
      updateStatus(ctx);
      return { duplicate: false };
    };

    const scheduleReplyPoll = (delayMs: number, generation: number) => {
      replyTimer = setTimeout(() => pollReplies(generation), delayMs);
      replyTimer.unref?.();
    };

    const pollReplies = async (generation: number) => {
      const ctx = replyContext;
      if (!ctx || generation !== replyGeneration || !areRepliesEnabled()) return;
      try {
        const replies = await receive(routeId);
        if (state.lastError) {
          state.lastError = undefined;
          persist();
          updateStatus(ctx);
        }
        for (const reply of replies) {
          if (generation !== replyGeneration || !replyContext || !areRepliesEnabled()) return;
          pi.sendUserMessage(reply, { deliverAs: "steer" });
        }
      } catch (error) {
        if (generation === replyGeneration && replyContext) recordFailure(ctx, error);
      } finally {
        if (generation === replyGeneration && replyContext && areRepliesEnabled()) {
          const jitterMs = randomBytes(2).readUInt16BE() % 500;
          scheduleReplyPoll(replyPollIntervalMs + jitterMs, generation);
        }
      }
    };

    const startReplyPolling = (ctx: ExtensionContext) => {
      replyContext = ctx;
      if (!replyTimer && areRepliesEnabled()) {
        replyGeneration += 1;
        scheduleReplyPoll(0, replyGeneration);
      }
    };

    const stopReplyPolling = () => {
      replyGeneration += 1;
      replyContext = undefined;
      if (replyTimer) clearTimeout(replyTimer);
      replyTimer = undefined;
    };

    const ensureToolRegistered = () => {
      if (toolRegistered || !eligible) return;
      toolRegistered = true;
      pi.registerTool<typeof NotifyParams, NotifyDetails>({
        name: TOOL_NAME,
        label: "Notify User",
        description: "Notify the user through Telegram only when the user-owned root task is truly complete or when progress is blocked and concrete user assistance is required. Never use for progress, substeps, delegated-worker completion, recoverable errors, or routine answers. Completion is queued until Pi fully settles; blockers are sent immediately.",
        promptSnippet: "Notify the user only for verified root-task completion or a genuine user-action blocker",
        promptGuidelines: [
          "Call notify_user once with kind=completed only after the entire user-owned root task is finished and proportionately verified. Do not call it for substeps, partial work, delegated task completion, or merely because an agent turn is ending.",
          "Call notify_user with kind=blocked only after exhausting safe in-scope options and when a specific action from the user is required. Include that action in assistance_needed.",
          "Keep notification summaries short and sanitized. Never include secrets, command output, stack traces, source code, or the full final response.",
        ],
        parameters: NotifyParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const intent: NotificationIntent = {
            kind: params.kind,
            summary: sanitizeText(params.summary),
            ...(params.assistance_needed && { assistanceNeeded: sanitizeText(params.assistance_needed) }),
          };
          const details: NotifyDetails = { kind: intent.kind };
          if (!isEnabled()) {
            const error = "Telegram notifications are disabled. Run /notify test before enabling them.";
            return { content: [{ type: "text", text: error }], details: { ...details, error } };
          }
          if (intent.kind === "blocked" && !intent.assistanceNeeded) {
            const error = "assistance_needed is required for a blocker notification.";
            return { content: [{ type: "text", text: error }], details: { ...details, error } };
          }
          if (intent.kind === "completed") {
            pendingCompletion = intent;
            assistantEndedAfterIntent = false;
            lastAssistantStopReason = undefined;
            return {
              content: [{ type: "text", text: "Completion notification queued. It will send only after the agent settles successfully." }],
              details: { ...details, queued: true },
            };
          }

          try {
            const result = await send(intent, ctx);
            return {
              content: [{ type: "text", text: result.duplicate ? "Duplicate blocker notification suppressed." : "Blocker notification delivered." }],
              details: { ...details, delivered: !result.duplicate, duplicate: result.duplicate },
            };
          } catch (error) {
            recordFailure(ctx, error);
            const message = "Blocker notification could not be delivered. Tell the user directly and suggest /notify status.";
            return { content: [{ type: "text", text: message }], details: { ...details, error: state.lastError } };
          }
        },
      });
    };

    pi.registerCommand("notify", {
      description: "Test, enable, disable, or inspect Telegram notifications",
      getArgumentCompletions: (prefix) => {
        const items = ["status", "test", "on", "off", "replies-on", "replies-off"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value }));
        return items.length ? items : null;
      },
      handler: async (args, ctx) => {
        const action = args.trim() || "status";
        if (!eligible) {
          ctx.ui.notify("Telegram notifications are available only in the primary interactive Pi session.", "warning");
          return;
        }
        if (action === "test") {
          const testIntent: NotificationIntent = {
            kind: "completed",
            summary: "Telegram notifications are configured correctly",
          };
          try {
            await send(testIntent, ctx, true);
            state.enabled = true;
            state.testPassedAt = now().toISOString();
            state.lastKind = "test";
            persist();
            ensureToolRegistered();
            if (state.repliesEnabled) startReplyPolling(ctx);
            updateStatus(ctx);
            ctx.ui.notify("Telegram test delivered; notifications are now enabled.", "info");
          } catch (error) {
            state.enabled = false;
            recordFailure(ctx, error);
            ctx.ui.notify("Telegram test failed; notifications remain disabled.", "error");
          }
          return;
        }
        if (action === "on") {
          if (!state.testPassedAt) {
            ctx.ui.notify("Run /notify test successfully before enabling notifications.", "warning");
            return;
          }
          state.enabled = true;
          persist();
          ensureToolRegistered();
          if (state.repliesEnabled) startReplyPolling(ctx);
        } else if (action === "off") {
          state.enabled = false;
          pendingCompletion = undefined;
          stopReplyPolling();
          persist();
        } else if (action === "replies-on") {
          if (!state.enabled) {
            ctx.ui.notify("Enable Telegram notifications before enabling replies.", "warning");
            return;
          }
          state.repliesEnabled = true;
          routeId = randomBytes(8).toString("hex");
          persist();
          startReplyPolling(ctx);
        } else if (action === "replies-off") {
          state.repliesEnabled = false;
          routeId = randomBytes(8).toString("hex");
          stopReplyPolling();
          persist();
        } else if (action !== "status") {
          ctx.ui.notify("Usage: /notify [status|test|on|off|replies-on|replies-off]", "error");
          return;
        }

        updateStatus(ctx);
        const summary = [
          state.enabled ? "enabled" : "disabled",
          `replies=${state.repliesEnabled ? "on" : "off"}`,
          `tested=${state.testPassedAt ?? "never"}`,
          `last=${state.lastSentAt ?? "never"}`,
          `kind=${state.lastKind ?? "none"}`,
          `error=${state.lastError ?? "none"}`,
        ].join(" · ");
        ctx.ui.notify(summary, state.lastError ? "warning" : "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      state = loadState(statePath);
      routeId = randomBytes(8).toString("hex");
      eligible = isEligiblePrimary(ctx, env);
      ownsPrimary = eligible && claim(instance);
      eligible = eligible && ownsPrimary;
      pendingCompletion = undefined;
      warnedDeliveryFailure = false;
      if (state.enabled) {
        ensureToolRegistered();
        if (state.repliesEnabled) startReplyPolling(ctx);
      }
      updateStatus(ctx);
    });

    pi.on("agent_start", () => {
      pendingCompletion = undefined;
      assistantEndedAfterIntent = false;
      lastAssistantStopReason = undefined;
    });

    pi.on("tool_execution_start", (event) => {
      if (pendingCompletion && event.toolName !== TOOL_NAME) {
        pendingCompletion = undefined;
        assistantEndedAfterIntent = false;
      }
    });

    pi.on("tool_execution_end", (event) => {
      if (pendingCompletion && event.toolName !== TOOL_NAME && event.isError) {
        pendingCompletion = undefined;
        assistantEndedAfterIntent = false;
      }
    });

    pi.on("message_end", (event) => {
      if (!pendingCompletion || event.message.role !== "assistant") return;
      const message = event.message as AssistantMessage;
      assistantEndedAfterIntent = true;
      lastAssistantStopReason = message.stopReason;
    });

    pi.on("session_compact", (event) => {
      if (event.willRetry) pendingCompletion = undefined;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const intent = pendingCompletion;
      pendingCompletion = undefined;
      if (!intent || !assistantEndedAfterIntent || lastAssistantStopReason !== "stop" || ctx.hasPendingMessages()) return;
      try {
        await send(intent, ctx);
      } catch (error) {
        recordFailure(ctx, error);
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      pendingCompletion = undefined;
      stopReplyPolling();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      if (ownsPrimary) release(instance);
      ownsPrimary = false;
      eligible = false;
    });
  };
}

export default createTelegramNotifyExtension();
