import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableInbox, InboxFullError } from "../src/inbox.ts";
import type { EventOccurrence, SubscriptionIdentity } from "../src/types.ts";

const identity: SubscriptionIdentity = { endpoint: "https://example.invalid/mcp", name: "changed", arguments: {}, sessionId: "session-a" };
const event = (eventId: string, cursor?: string | null): EventOccurrence => ({ eventId, name: "changed", timestamp: "2026-01-01T00:00:00Z", data: { instruction: "untrusted" }, ...(cursor === undefined ? {} : { cursor }) });
async function temp(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-inbox-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("persists ordered events, cursor erase, duplicates and heartbeat checkpoints", async () => temp(async dir => {
  const inbox = await DurableInbox.open(dir, identity);
  try {
    await inbox.accept(event("one", "c1"));
    await inbox.accept(event("two", "c2"));
    assert.equal(await inbox.accept(event("one", "old-cursor")), false);
    assert.equal(inbox.snapshot.cursor, "c2", "late duplicate must not regress opaque cursor");
    await inbox.checkpoint("c3", { truncated: true });
    await inbox.accept(event("three"));
    assert.equal(inbox.snapshot.cursor, "c3");
    await inbox.accept(event("four", null));
    assert.equal(inbox.snapshot.cursor, null);
    assert.deepEqual([inbox.snapshot.duplicates, inbox.snapshot.gaps], [1, 1]);
    const view = inbox.snapshot; view.pending.length = 0;
    assert.equal(inbox.snapshot.pending.length, 4);
  } finally { await inbox.close(); }
  const reopened = await DurableInbox.open(dir, identity);
  try { assert.deepEqual(reopened.snapshot.pending.map(p => p.event.eventId), ["one", "two", "three", "four"]); }
  finally { await reopened.close(); }
}));

test("exclusive lock fails closed and reopening after clean close succeeds", async () => temp(async dir => {
  const first = await DurableInbox.open(dir, identity);
  try { await assert.rejects(DurableInbox.open(dir, identity), { code: "EEXIST" }); }
  finally { await first.close(); }
  const second = await DurableInbox.open(dir, identity);
  await second.close();
}));

test("overflow leaves disk cursor and pending untouched", async () => temp(async dir => {
  const inbox = await DurableInbox.open(dir, identity, { maxEvents: 1 });
  try {
    await inbox.accept(event("one", "c1"));
    await assert.rejects(inbox.accept(event("two", "c2")), InboxFullError);
    assert.equal(inbox.snapshot.cursor, "c1");
    assert.deepEqual(inbox.snapshot.pending.map(p => p.event.eventId), ["one"]);
  } finally { await inbox.close(); }
  const reopened = await DurableInbox.open(dir, identity, { maxEvents: 1 });
  try { assert.equal(reopened.snapshot.cursor, "c1"); } finally { await reopened.close(); }
}));

test("one reserved batch survives restart; record retains bounded dedup", async () => temp(async dir => {
  let inbox = await DurableInbox.open(dir, identity, { maxDedup: 2 });
  await inbox.accept(event("one")); await inbox.accept(event("two"));
  const first = await inbox.takeBatch(1, 1024);
  assert.deepEqual(first?.events.map(e => e.eventId), ["one"]);
  assert.equal((await inbox.takeBatch(2, 2048))?.id, first?.id);
  await inbox.close();
  inbox = await DurableInbox.open(dir, identity, { maxDedup: 2 });
  try {
    assert.equal((await inbox.takeBatch(1, 1024))?.id, first?.id);
    await inbox.record(first!.id, ["one"]);
    assert.equal(await inbox.accept(event("one")), false);
    await inbox.accept(event("three"));
    assert.equal(inbox.snapshot.dedup.length, 2);
    assert.deepEqual(inbox.snapshot.pending.map(p => p.event.eventId), ["two", "three"]);
  } finally { await inbox.close(); }
}));

test("an event exceeding the dispatch batch cap reports overflow instead of silently stalling", async () => temp(async dir => {
  const inbox = await DurableInbox.open(dir, identity);
  try {
    await inbox.accept(event("big", "c1"));
    await assert.rejects(inbox.takeBatch(1, 1), InboxFullError);
    assert.equal(inbox.snapshot.pending.length, 1);
    assert.equal(inbox.snapshot.cursor, "c1");
  } finally { await inbox.close(); }
}));

test("startup rejects an oversized snapshot before parsing and malformed snapshot shape fails closed", async () => temp(async dir => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const snapshotPath = join(dir, "snapshot.json");
  await writeFile(snapshotPath, "x".repeat(1025));
  await assert.rejects(DurableInbox.open(dir, identity, { maxBytes: 1024 }), InboxFullError);
  await writeFile(snapshotPath, JSON.stringify({ identity, cursor: null, pending: "not-an-array", dedup: [], duplicates: 0, gaps: 0 }));
  await assert.rejects(DurableInbox.open(dir, identity), /Invalid durable inbox snapshot/);
  assert.equal(await readFile(join(dir, "owner.lock")).catch(() => undefined), undefined, "failed admission must release only its own lock");
}));
