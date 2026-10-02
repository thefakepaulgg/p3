import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { ReferenceServer } from "../reference/server.ts";
import { waitFor, delay } from "./helpers.ts";

// Pi API boundary simulation, not a real AgentSession scheduling/activation test.
async function hostHarness(t: import("node:test").TestContext, busy: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "pi-events-host-"));
  const path = join(dir, "session.jsonl");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: ExtensionCommandContext) => Promise<void> | void>();
  const entries: any[] = [];
  const messages: { message: any; options: unknown; busy: boolean }[] = [];
  const notices: string[] = [];
  const statuses: string[] = [];
  let sessionId = "harness-original";
  const context = {
    cwd: dir, hasUI: true,
    ui: { setStatus(_key: string, text: string) { statuses.push(text); }, notify(text: string) { notices.push(text); } },
    isIdle: () => !busy,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path, getEntries: () => entries },
  } as unknown as ExtensionCommandContext;
  const api = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { handlers.set(name, handler); return () => {}; },
    sendMessage(message: any, options: unknown) { messages.push({ message, options, busy }); },
  } as unknown as ExtensionAPI;
  extension(api);
  t.after(async () => { await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context); await rm(dir, { recursive: true, force: true }); });
  await handlers.get("session_start")?.({ type: "session_start" }, context);
  return { context, messages, commands, handlers, entries, notices, statuses, path, switchSession: () => { sessionId = "harness-fork"; } };
}

test("extension factory/session_start creates no connection; default reference start is notify-only", async t => {
  const host = await hostHarness(t, false);
  const server = await ReferenceServer.start({ heartbeatMs: 50 });
  t.after(() => server.close());
  assert.equal(server.requests.length, 0);
  await host.commands.get("mcp-events")!.handler(`start ${server.url} job`, host.context);
  await waitFor(() => server.activeCount === 1);
  server.emit("job", "first");
  await waitFor(() => host.statuses.some(s => s.includes("pending=1")));
  assert.equal(host.messages.length, 0);
  await host.commands.get("mcp-events")!.handler("stop", host.context);
  await waitFor(() => server.activeCount === 0);
});

for (const busy of [false, true]) test(`authorized reference wake in ${busy ? "busy" : "idle"} host requests one follow-up and waits for actual append`, async t => {
  const host = await hostHarness(t, busy);
  const server = await ReferenceServer.start({ heartbeatMs: 50 });
  t.after(() => server.close());
  await host.commands.get("mcp-events")!.handler(`start ${server.url} job wake`, host.context);
  await waitFor(() => server.activeCount === 1);
  server.emit("job", "one"); server.emit("job", "two");
  await waitFor(() => host.messages.length === 1 && host.statuses.at(-1)?.includes("pending=2") === true);
  const recorded: string[] = [];
  for (let batch = 0; recorded.length < 2; batch++) {
    await waitFor(() => host.messages.length > batch);
    assert.equal(host.messages.length, batch + 1, "only one unrecorded batch may be requested");
    assert.deepEqual(host.messages[batch].options, { triggerTurn: true, deliverAs: "followUp" });
    const message = host.messages[batch].message;
    await host.handlers.get("message_end")?.({ type: "message_end", message: { ...message, role: "custom" } }, host.context);
    await delay(60);
    assert.ok(host.statuses.at(-1)?.includes(`pending=${2 - recorded.length}`), "message_end alone cannot ACK");
    const entry = { type: "custom_message", id: `entry-harness-${batch}`, ...message };
    host.entries.push(entry);
    if (batch === 0) await writeFile(host.path, `${JSON.stringify({ type: "session", id: "harness-original" })}\n`);
    await host.handlers.get("agent_settled")?.({ type: "agent_settled" }, host.context);
    await delay(60);
    assert.ok(host.statuses.at(-1)?.includes(`pending=${2 - recorded.length}`), "memory-only entries cannot ACK");
    await appendFile(host.path, `${JSON.stringify(entry)}\n`);
    recorded.push(...message.details.eventIds);
    await host.handlers.get("agent_settled")?.({ type: "agent_settled" }, host.context);
    await waitFor(() => host.statuses.at(-1)?.includes(`pending=${2 - recorded.length}`) ?? false);
  }
  assert.deepEqual(recorded, ["one", "two"]);
  assert.ok(host.messages.length <= 2);
});

test("shutdown/fork cancels stream and does not inherit monitoring authority", async t => {
  const host = await hostHarness(t, true);
  const server = await ReferenceServer.start({ heartbeatMs: 50 });
  t.after(() => server.close());
  await host.commands.get("mcp-events")!.handler(`start ${server.url} job wake`, host.context);
  await waitFor(() => server.activeCount === 1);
  await host.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "fork" }, host.context);
  host.switchSession();
  await host.handlers.get("session_start")?.({ type: "session_start" }, host.context);
  server.emit("job", "after-fork");
  await delay(100);
  assert.equal(server.activeCount, 0);
  assert.equal(server.opens.length, 1);
  assert.equal(host.messages.length, 0);
});

test("non-loopback admission is rejected before any subscription or model delivery", async t => {
  const host = await hostHarness(t, false);
  await host.commands.get("mcp-events")!.handler("start https://example.invalid/mcp job wake", host.context);
  assert.equal(host.messages.length, 0);
  assert.ok(host.notices.some(n => n.includes("127.0.0.1")));
});
