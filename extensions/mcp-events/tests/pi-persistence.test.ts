import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DurableInbox } from "../src/inbox.ts";
import { SessionDispatcher, type DispatchDetails, type DispatchHost } from "../src/dispatch.ts";

// Actual Pi 1.0.0 storage component, but no live AgentSession, extension activation or model/provider.
for (const persistent of [true, false]) test(`Pi 1.0.0 ${persistent ? "deferred transcript flush" : "in-memory session"} does not create a false recorded receipt`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-events-persistence-"));
  const manager = persistent ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
  const identity = { endpoint: "http://127.0.0.1:1/mcp", name: "job.completed", arguments: { jobId: "synthetic" }, sessionId: manager.getSessionId() };
  const inbox = await DurableInbox.open(join(dir, "inbox"), identity);
  let message: { customType: string; content: string; display: boolean; details: DispatchDetails } | undefined;
  const host: DispatchHost = { sessionId: manager.getSessionId(), send: m => { message = m; }, entries: () => manager.getEntries(), sessionFile: () => manager.getSessionFile() };
  const dispatcher = new SessionDispatcher(inbox, host, "wake");
  try {
    await inbox.accept({ eventId: "storage-proof", name: "job.completed", timestamp: "2026-10-02T12:00:00Z", data: { jobId: "synthetic", state: "complete" }, cursor: "opaque-1" });
    await dispatcher.pump();
    assert.ok(message);
    dispatcher.observe({ ...message, role: "custom" });
    assert.equal(await dispatcher.reconcile(), false);
    manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    assert.equal(await dispatcher.reconcile(), false, "custom-only Pi session has no persisted transcript yet");
    manager.appendMessage({ role: "user", content: "Synthetic user conversation to test storage only", timestamp: Date.now() });
    assert.equal(await dispatcher.reconcile(), persistent);
    assert.equal(inbox.snapshot.pending.length, persistent ? 0 : 1);
  } finally { await inbox.close(); await rm(dir, { recursive: true, force: true }); }
});
