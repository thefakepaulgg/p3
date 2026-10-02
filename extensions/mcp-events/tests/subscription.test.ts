import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReferenceServer } from "../reference/server.ts";
import { EventsClient } from "../src/stream-client.ts";
import { DurableInbox } from "../src/inbox.ts";
import { PushSubscription } from "../src/subscription.ts";
import { waitFor, delay } from "./helpers.ts";

async function setup(t: import("node:test").TestContext, options: Parameters<typeof ReferenceServer.start>[0] = {}, maxEvents = 16) {
  const dir = await mkdtemp(join(tmpdir(), "events-contract-"));
  const server = await ReferenceServer.start({ heartbeatMs: 50, ...options });
  const client = await EventsClient.connectLocal(server.url);
  await client.listEvents();
  const identity = { endpoint: server.url, name: "job.completed", arguments: { jobId: "one" }, sessionId: "synthetic-session" };
  const inbox = await DurableInbox.open(join(dir, "inbox"), identity, { maxEvents });
  const subscription = new PushSubscription(client, inbox, { heartbeatMs: 80, openingMs: 100, reconnectMs: 30, reconnectMaxMs: 100 });
  t.after(async () => { await subscription.stop(); await client.close(); await inbox.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  subscription.start();
  await waitFor(() => subscription.status.state === "active");
  return { server, client, inbox, subscription };
}

test("disconnect reconnects from committed application cursor, replays missed events and deduplicates", async t => {
  const { server, inbox, subscription } = await setup(t);
  const first = server.emit("one", "a");
  await waitFor(() => inbox.snapshot.cursor === "ref-1");
  server.drop();
  server.emit("one", "b");
  await waitFor(() => server.opens.length === 2 && inbox.snapshot.pending.length === 2);
  assert.equal(server.opens[1].params.cursor, "ref-1");
  server.duplicate(first);
  await waitFor(() => inbox.snapshot.duplicates === 1);
  assert.equal(inbox.snapshot.cursor, "ref-2");
  assert.deepEqual(inbox.snapshot.pending.map(p => p.event.eventId), ["a", "b"]);
  assert.equal(server.maxConcurrent, 1);
  assert.equal(server.gets, 0, "SSE wire IDs must not start GET/Last-Event-ID replay");
  await subscription.stop();
  await waitFor(() => server.activeCount === 0);
});

test("quiet heartbeats checkpoint checked positions and a mid-stream gap is recorded without reopening", async t => {
  const { server, inbox } = await setup(t);
  server.emit("not-our-filter", "elsewhere");
  await waitFor(() => inbox.snapshot.cursor === "ref-1");
  assert.equal(inbox.snapshot.pending.length, 0);
  server.gap();
  await waitFor(() => inbox.snapshot.gaps === 1);
  server.emit("one", "after-gap");
  await waitFor(() => inbox.snapshot.pending.length === 1);
  assert.equal(server.opens.length, 1);
});

test("heartbeat watchdog retires old request before reconnecting", async t => {
  const { server, subscription } = await setup(t);
  const oldId = subscription.status.requestId;
  server.stopHeartbeats();
  await waitFor(() => server.opens.length >= 2);
  assert.notEqual(subscription.status.requestId, oldId);
  assert.equal(server.maxConcurrent, 1);
  assert.equal(server.gets, 0);
});

test("overflow never checkpoints discarded events; freeing a reserved batch permits explicit replay resume", async t => {
  const { server, inbox, subscription } = await setup(t, {}, 1);
  server.emit("one", "first");
  await waitFor(() => inbox.snapshot.pending.length === 1);
  server.emit("one", "second");
  await waitFor(() => subscription.status.state === "paused");
  assert.equal(subscription.status.reason, "inbox-overflow");
  assert.equal(inbox.snapshot.cursor, "ref-1");
  await waitFor(() => server.activeCount === 0);
  const batch = await inbox.takeBatch(1, 8192);
  assert.ok(batch);
  await inbox.record(batch.id, batch.events.map(e => e.eventId)); // Inbox seam ACK, not a Pi host claim.
  subscription.start();
  await waitFor(() => inbox.snapshot.pending[0]?.event.eventId === "second");
  assert.equal(server.opens[1].params.cursor, "ref-1");
});

test("bounded non-awaitable SDK intake pauses without committing later heartbeats", async t => {
  const { server, inbox, subscription } = await setup(t, {}, 128);
  for (let i = 0; i < 80; i++) server.emit("one", `burst-${i}`);
  await waitFor(() => subscription.status.state === "paused");
  assert.equal(subscription.status.reason, "intake-overflow");
  const durable = inbox.snapshot;
  assert.ok(durable.pending.length <= 32);
  assert.equal(durable.cursor, durable.pending.at(-1)?.event.cursor ?? "ref-0");
  await delay(100);
  assert.equal(inbox.snapshot.cursor, durable.cursor);
});

test("revocation termination stops permanently without fallback or blind reconnect", async t => {
  const { server, subscription } = await setup(t);
  server.notice("terminated", { error: { code: -32012, message: "Forbidden", data: { reason: "revoked" } } });
  await waitFor(() => subscription.status.state === "terminated");
  await delay(200);
  assert.equal(server.opens.length, 1);
  assert.equal(server.activeCount, 0);
});

test("schema violation pauses intake and retains the last accepted cursor", async t => {
  const { server, inbox, subscription } = await setup(t);
  server.notice("event", { eventId: "bad", name: "job.completed", timestamp: "2026-10-02T12:00:00Z", data: { jobId: "one", state: "malicious" }, cursor: "ref-999" });
  await waitFor(() => subscription.status.state === "paused");
  assert.equal(inbox.snapshot.cursor, "ref-0");
  assert.equal(inbox.snapshot.pending.length, 0);
  assert.equal(server.opens.length, 1);
});

test("non-replayable null cursor reconnects from now and reports no recovery of offline events", async t => {
  const { server, inbox } = await setup(t, { replayable: false });
  server.emit("one", "collected");
  await waitFor(() => inbox.snapshot.pending.length === 1);
  server.drop(); server.emit("one", "lost-offline");
  await waitFor(() => server.opens.length === 2);
  await delay(80);
  assert.equal(server.opens[1].params.cursor, null);
  assert.deepEqual(inbox.snapshot.pending.map(p => p.event.eventId), ["collected"]);
  assert.equal(inbox.snapshot.cursor, null);
});

test("retention gap on reconnect records truncated then continues live delivery", async t => {
  const { server, inbox } = await setup(t, { historyLimit: 1 });
  server.emit("one", "old");
  await waitFor(() => inbox.snapshot.cursor === "ref-1");
  server.drop();
  server.emit("one", "expired"); server.emit("one", "latest"); server.emit("one", "fresh-position");
  await waitFor(() => server.opens.length === 2 && inbox.snapshot.gaps === 1);
  assert.equal(inbox.snapshot.cursor, "ref-4");
  assert.deepEqual(inbox.snapshot.pending.map(p => p.event.eventId), ["old"]);
  server.emit("one", "live-after-gap");
  await waitFor(() => inbox.snapshot.pending.length === 2);
  assert.equal(server.opens.length, 2);
});

test("stop during backoff prevents any replacement and old-generation intake", async t => {
  const { server, inbox, subscription } = await setup(t);
  server.drop();
  await waitFor(() => subscription.status.state === "reconnecting");
  await subscription.stop();
  server.emit("one", "after-stop");
  await delay(120);
  assert.equal(subscription.status.state, "stopped");
  assert.equal(server.opens.length, 1);
  assert.equal(inbox.snapshot.pending.length, 0);
});

test("replay larger than bounded intake makes durable forward progress across explicit resumes", async t => {
  const { server, inbox, subscription } = await setup(t, {}, 128);
  for (let i = 0; i < 80; i++) server.emit("one", `replay-${i}`);
  await waitFor(() => subscription.status.state === "paused");
  assert.ok(inbox.snapshot.pending.length > 0, "earlier admitted writes cannot be discarded or replay would never progress");
  for (let attempt = 0; attempt < 4 && inbox.snapshot.pending.length < 80; attempt++) {
    subscription.start();
    await waitFor(() => subscription.status.state === "paused" || inbox.snapshot.pending.length === 80);
    if (inbox.snapshot.pending.length < 80) await delay(5);
  }
  await waitFor(() => inbox.snapshot.pending.length === 80);
  assert.equal(inbox.snapshot.cursor, "ref-80");
  assert.equal(new Set(inbox.snapshot.pending.map(p => p.event.eventId)).size, 80);
  assert.equal(server.maxConcurrent, 1);
});
