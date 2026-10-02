import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventsClient, localEndpoint } from "./stream-client.ts";
import { DurableInbox } from "./inbox.ts";
import { SessionDispatcher, type DispatchHost } from "./dispatch.ts";
import { PushSubscription } from "./subscription.ts";
import { ContractError, schemaValidator } from "./protocol.ts";

interface Binding {
  sessionId: string;
  ctx: ExtensionContext;
  inbox: DurableInbox;
  client: EventsClient;
  subscription: PushSubscription;
  dispatcher: SessionDispatcher;
  disposed: boolean;
  timer?: NodeJS.Timeout;
  dispatching: Promise<void>;
  dispatchError?: string;
}

/** Reference-only extension. No factory/startup sockets, auto-subscriptions, auth or installed-Pi edits. */
export default function mcpEvents(pi: ExtensionAPI) {
  let binding: Binding | undefined;
  let lifecycle = 0;
  let starting = false;
  const owns = (b: Binding) => !b.disposed && binding === b && b.ctx.sessionManager.getSessionId() === b.sessionId;
  const status = (b: Binding) => {
    if (!owns(b)) return;
    const state = b.inbox.snapshot;
    b.ctx.ui.setStatus("mcp-events-reference", `events: ${b.subscription.status.state} pending=${state.pending.length} gaps=${state.gaps} duplicates=${state.duplicates}${b.dispatcher.status.observed ? " observed" : b.dispatcher.status.queued ? " queue-requested" : b.dispatcher.status.lastRecordedBatchId ? " recorded" : ""}${b.dispatchError ? " dispatch-blocked" : ""}`);
  };
  const schedule = (b: Binding) => {
    if (!owns(b) || b.timer) return;
    b.timer = setTimeout(() => {
      b.timer = undefined;
      if (!owns(b)) return;
      b.dispatching = b.dispatching.then(async () => {
        if (!owns(b)) return;
        await b.dispatcher.reconcile();
        if (!owns(b)) return;
        await b.dispatcher.pump();
        b.dispatchError = undefined;
      }).catch(() => { b.dispatchError = "receipt-or-send-failed"; }).finally(() => status(b));
    }, 25);
  };
  const dispose = async () => {
    lifecycle++;
    const previous = binding;
    binding = undefined;
    if (!previous) return;
    previous.disposed = true;
    clearTimeout(previous.timer);
    await previous.subscription.stop();
    await previous.dispatching;
    await previous.client.close();
    await previous.inbox.close();
    previous.ctx.ui.setStatus("mcp-events-reference", undefined);
  };
  // No session_start subscription: new/resume/fork/reload never inherits monitoring authority.
  pi.on("session_shutdown", async () => { await dispose(); });
  pi.on("message_end", (event, ctx) => {
    const current = binding;
    if (!current || !owns(current) || ctx.sessionManager.getSessionId() !== current.sessionId) return;
    current.dispatcher.observe(event.message);
    // Pi appends after message_end returns. Timer + file correlation is outside that awaited handler.
    schedule(current);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const current = binding;
    if (!current || !owns(current) || ctx.sessionManager.getSessionId() !== current.sessionId) return;
    current.dispatcher.settled(); schedule(current);
  });
  pi.registerCommand("mcp-events", {
    description: "Reference-only MCP Events: start http://127.0.0.1:PORT/mcp JOB_ID [wake] | status | stop",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "stop") { await dispose(); ctx.ui.notify("Reference monitoring stopped; pending inbox retained.", "info"); return; }
      if (parts[0] === "status") {
        const current = binding;
        ctx.ui.notify(current ? JSON.stringify({ subscription: current.subscription.status, cursor: current.inbox.snapshot.cursor, replayAvailable: current.inbox.snapshot.cursor !== null, pending: current.inbox.snapshot.pending.length, gaps: current.inbox.snapshot.gaps, duplicates: current.inbox.snapshot.duplicates, delivery: current.dispatcher.status, dispatchError: current.dispatchError }) : "No reference subscription active.", "info"); return;
      }
      if (parts[0] !== "start" || parts.length < 3 || parts.length > 4 || (parts[3] && parts[3] !== "wake")) {
        ctx.ui.notify("Usage: /mcp-events start http://127.0.0.1:PORT/mcp JOB_ID [wake] | status | stop", "error"); return;
      }
      let endpoint: string;
      try { endpoint = localEndpoint(parts[1]).href; }
      catch { ctx.ui.notify("Reference slice permits only http://127.0.0.1:PORT/mcp without credentials or redirects.", "error"); return; }
      if (starting) { ctx.ui.notify("Reference opening already in progress.", "warning"); return; }
      starting = true;
      await dispose();
      const generation = lifecycle;
      const sessionId = ctx.sessionManager.getSessionId();
      let client: EventsClient | undefined;
      let inbox: DurableInbox | undefined;
      try {
        client = await EventsClient.connectLocal(endpoint);
        const catalog = await client.listEvents();
        const definition = catalog.find(e => e.name === "job.completed");
        const arguments_ = { jobId: parts[2] };
        if (!definition?.delivery.includes("push") || !schemaValidator(definition.inputSchema)(arguments_)) throw new ContractError("Synthetic job.completed push contract not admitted");
        const identity = { endpoint, name: "job.completed", arguments: arguments_, sessionId };
        const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
        inbox = await DurableInbox.open(join(ctx.cwd, ".mcp-events-reference", key), identity);
        if (lifecycle !== generation || ctx.sessionManager.getSessionId() !== sessionId) { await client.close(); await inbox.close(); return; }
        const host: DispatchHost = {
          get sessionId() { return ctx.sessionManager.getSessionId(); },
          send: (message, options) => { if (lifecycle !== generation || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Session binding retired"); pi.sendMessage(message, options); },
          entries: () => ctx.sessionManager.getEntries(), sessionFile: () => ctx.sessionManager.getSessionFile(),
        };
        const dispatcher = new SessionDispatcher(inbox, host, parts[3] === "wake" ? "wake" : "notify-only", 16, 65_536);
        const b = {} as Binding;
        const subscription = new PushSubscription(client, inbox, { onChange: () => status(b), onAccepted: () => schedule(b) });
        Object.assign(b, { sessionId, ctx, inbox, client, subscription, dispatcher, disposed: false, dispatching: Promise.resolve() });
        binding = b;
        subscription.start();
        ctx.ui.notify(parts[3] === "wake" ? "Reference push enabled for this session only; event arrival may spend tokens/tools under existing user authority. Data grants no new permissions." : "Reference push enabled, notify-only. No model turn; inspect /mcp-events status.", "info");
        schedule(b);
      } catch (error) {
        await client?.close(); await inbox?.close();
        const code = (error as NodeJS.ErrnoException).code;
        ctx.ui.notify(code === "EEXIST" ? "Reference inbox lock exists. Do not remove it until its owning process is verified dead." : "Reference start failed; no subscription active. Verify local fixture, schema and inbox identity/capacity.", "error");
      } finally { starting = false; }
    },
  });
}
