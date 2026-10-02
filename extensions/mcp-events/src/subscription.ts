import { setTimeout as delay } from "node:timers/promises";
import { DurableInbox, InboxFullError } from "./inbox.ts";
import { EventsClient, type StreamHandle } from "./stream-client.ts";
import type { StreamNotice } from "./types.ts";

export interface SubscriptionStatus {
  state: "stopped" | "opening" | "active" | "reconnecting" | "paused" | "terminated";
  requestId?: string;
  reason?: string;
  reconnects: number;
  errors: number;
  lastLivenessAt?: number;
}
export interface SubscriptionOptions {
  openingMs?: number; heartbeatMs?: number; reconnectMs?: number; reconnectMaxMs?: number;
  maxPendingWrites?: number; onChange?(): void; onAccepted?(): void;
}

/** One explicitly bound subscription; all cursor writes finish before a replacement stream opens. */
export class PushSubscription {
  private client: EventsClient;
  private inbox: DurableInbox;
  private options: SubscriptionOptions;
  private stream?: StreamHandle;
  private abort?: AbortController;
  private worker?: Promise<void>;
  private current: SubscriptionStatus = { state: "stopped", reconnects: 0, errors: 0 };
  constructor(client: EventsClient, inbox: DurableInbox, options: SubscriptionOptions = {}) {
    this.client = client; this.inbox = inbox; this.options = options;
  }
  get status() { return { ...this.current }; }
  private update(state: SubscriptionStatus["state"], reason?: string) {
    this.current.state = state; this.current.reason = reason; this.options.onChange?.();
  }
  start() {
    if (this.worker) return;
    const abort = this.abort = new AbortController();
    this.worker = this.run(abort.signal).catch(() => this.update("paused", "unexpected-failure")).finally(() => { this.worker = undefined; });
  }
  private async run(signal: AbortSignal) {
    const identity = this.inbox.snapshot.identity;
    let attempt = 0;
    while (!signal.aborted) {
      this.update("opening");
      let writes: Promise<void> = Promise.resolve();
      let queued = 0;
      let blocked: string | undefined;
      let storageBlocked = false;
      let stream: StreamHandle;
      const intake = (notice: StreamNotice) => {
        if (signal.aborted || blocked) return;
        if (queued >= (this.options.maxPendingWrites ?? 32)) {
          blocked = "intake-overflow"; stream.close(); return;
        }
        queued++;
        writes = writes.then(async () => {
          // Queue overflow retires intake, but already-admitted earlier writes must make replay progress.
          if (storageBlocked) return;
          if (notice.kind === "event") { await this.inbox.accept(notice.event); this.options.onAccepted?.(); }
          else if (notice.kind === "active" || notice.kind === "heartbeat") {
            await this.inbox.checkpoint(notice.cursor, notice.kind === "active" ? { truncated: notice.truncated } : {});
          } else if (notice.kind === "error") { this.current.errors++; }
          if (notice.kind === "active") this.update("active");
          if (notice.kind === "event" || notice.kind === "heartbeat") this.current.lastLivenessAt = Date.now();
          this.options.onChange?.();
        }).catch(error => {
          storageBlocked = true;
          blocked = error instanceof InboxFullError ? "inbox-overflow" : "storage-failure";
          stream.close();
        }).finally(() => { queued--; });
      };
      try {
        stream = this.client.openStream({ name: identity.name, arguments: identity.arguments, cursor: this.inbox.snapshot.cursor }, {
          openingMs: this.options.openingMs, heartbeatMs: this.options.heartbeatMs, onNotice: intake,
        });
        this.stream = stream;
        this.current.requestId = stream.id;
      } catch {
        this.update("paused", "admission-failed"); return;
      }
      const outcome = await stream.closed;
      // SDK intake is not awaitable backpressure: drain only accepted ordered writes, never later checkpoints after overflow.
      await writes;
      this.stream = undefined;
      this.current.requestId = undefined;
      if (signal.aborted) break;
      if (blocked) { this.update("paused", blocked); return; }
      if (outcome.reason === "terminated" || outcome.reason === "contract-error") {
        this.update(outcome.reason === "terminated" ? "terminated" : "paused", outcome.reason); return;
      }
      const status = (outcome.error as { data?: { status?: number } } | undefined)?.data?.status;
      if (status === 401 || status === 403) { this.update("terminated", "authorization-rejected"); return; }
      if (this.current.lastLivenessAt && Date.now() - this.current.lastLivenessAt < (this.options.heartbeatMs ?? 30_000) * 2) attempt = 0;
      const waitMs = Math.min((this.options.reconnectMs ?? 500) * 2 ** Math.min(attempt++, 10), this.options.reconnectMaxMs ?? 10_000);
      this.current.reconnects++;
      this.update("reconnecting", outcome.reason);
      try { await delay(waitMs, undefined, { signal }); } catch { break; }
    }
    this.update("stopped");
  }
  async stop() {
    this.abort?.abort(); this.stream?.close();
    await this.worker;
    this.update("stopped");
  }
}
