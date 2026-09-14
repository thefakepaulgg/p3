import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelegramNotifyExtension,
  deliverWithHelper,
  isEligiblePrimary,
} from "../telegram-notify.ts";

let temp: string | undefined;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

function setup(options: {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  claimPrimary?: (instance: object) => boolean;
  releasePrimary?: (instance: object) => void;
} = {}) {
  temp = mkdtempSync(join(tmpdir(), "telegram-notify-"));
  const statePath = join(temp, "state.json");
  if (options.enabled !== false) {
    writeFileSync(statePath, JSON.stringify({
      enabled: true,
      testPassedAt: "2026-03-01T00:00:00.000Z",
    }));
  }

  const tools: any[] = [];
  const commands: any[] = [];
  const handlers = new Map<string, Function>();
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const deliveries: string[] = [];
  const fakePi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) => commands.push({ name, command }),
    sendUserMessage: () => {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
  };

  createTelegramNotifyExtension({
    statePath,
    helperPath: join(temp, "unused-helper"),
    env: options.env ?? {},
    deliver: async (message) => { deliveries.push(message); },
    receive: async () => [],
    claimPrimary: options.claimPrimary ?? (() => true),
    releasePrimary: options.releasePrimary ?? (() => {}),
  })(fakePi);

  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo/example-api",
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionName: () => "telegram tests",
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  };

  return { tools, commands, handlers, statuses, notifications, deliveries, ctx, statePath };
}

async function start(harness: ReturnType<typeof setup>) {
  await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, harness.ctx);
}

function assistantMessage(stopReason: "stop" | "error" | "aborted" | "length" = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Final response" }],
    stopReason,
    timestamp: Date.now(),
  };
}

test("helper delivery rejects boundedly on hangs and spawn failures", async () => {
  temp = mkdtempSync(join(tmpdir(), "telegram-delivery-"));
  const hanging = join(temp, "hang.sh");
  writeFileSync(hanging, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o700 });

  const startedAt = Date.now();
  await expect(deliverWithHelper(hanging, "message", process.env, 50)).rejects.toThrow("timed out");
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  await expect(deliverWithHelper(join(temp, "missing"), "message", process.env, 50))
    .rejects.toThrow("could not start");
});

test("primary eligibility excludes noninteractive and delegated Herdr sessions", () => {
  expect(isEligiblePrimary({ mode: "tui", hasUI: true }, {})).toBe(true);
  expect(isEligiblePrimary({ mode: "rpc", hasUI: true }, {})).toBe(false);
  expect(isEligiblePrimary({ mode: "tui", hasUI: true }, { HERDR_ROLE: "helper" })).toBe(false);
  expect(isEligiblePrimary(
    { mode: "tui", hasUI: true },
    { PI_ROUTED_ROOT_TAB_ID: "w1:t1", HERDR_TAB_ID: "w1:t2" },
  )).toBe(false);
  expect(isEligiblePrimary(
    { mode: "tui", hasUI: true },
    { PI_ROUTED_ROOT_TAB_ID: "w1:t1", HERDR_TAB_ID: "w1:t1" },
  )).toBe(true);
});

test("disabled sessions register no model-facing tool until a test succeeds", async () => {
  const harness = setup({ enabled: false });
  await start(harness);
  expect(harness.tools).toHaveLength(0);

  const command = harness.commands.find(({ name }) => name === "notify").command;
  await command.handler("test", harness.ctx);

  expect(harness.deliveries).toHaveLength(1);
  expect(harness.deliveries[0]).toContain("Telegram notifications are configured correctly");
  expect(harness.tools).toHaveLength(1);
  expect(harness.notifications.at(-1)?.message).toContain("now enabled");
});

test("replies default off and can be toggled independently", async () => {
  const harness = setup();
  await start(harness);
  const command = harness.commands.find(({ name }) => name === "notify").command;
  const tool = harness.tools.find(({ name }) => name === "notify_user");

  await command.handler("status", harness.ctx);
  expect(harness.notifications.at(-1)?.message).toContain("replies=off");

  await tool.execute("call-1", {
    kind: "blocked",
    summary: "First blocker",
    assistance_needed: "Reply once",
  }, new AbortController().signal, () => {}, harness.ctx);
  expect(harness.deliveries.at(-1)).not.toContain("[pi:");

  await command.handler("replies-on", harness.ctx);
  await tool.execute("call-2", {
    kind: "blocked",
    summary: "Second blocker",
    assistance_needed: "Reply twice",
  }, new AbortController().signal, () => {}, harness.ctx);
  expect(harness.deliveries.at(-1)).toContain("Reply to this message to respond.");
  expect(harness.deliveries.at(-1)).toMatch(/\[pi:[0-9a-f]{16}\]/);

  await command.handler("replies-off", harness.ctx);
  await tool.execute("call-3", {
    kind: "blocked",
    summary: "Third blocker",
    assistance_needed: "Reply three times",
  }, new AbortController().signal, () => {}, harness.ctx);
  expect(harness.deliveries.at(-1)).not.toContain("[pi:");
});

test("completion sends only after a normal final response and agent_settled", async () => {
  const harness = setup();
  await start(harness);
  await harness.handlers.get("agent_start")?.({ type: "agent_start" }, harness.ctx);
  const tool = harness.tools.find(({ name }) => name === "notify_user");

  const result = await tool.execute(
    "call-1",
    { kind: "completed", summary: "Implemented and verified Telegram notifications" },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );
  expect(result.details.queued).toBe(true);
  expect(harness.deliveries).toHaveLength(0);

  await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
  expect(harness.deliveries).toHaveLength(0);

  await tool.execute(
    "call-2",
    { kind: "completed", summary: "Implemented and verified Telegram notifications" },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );
  harness.handlers.get("message_end")?.({ type: "message_end", message: assistantMessage("stop") }, harness.ctx);
  await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);

  expect(harness.deliveries).toHaveLength(1);
  expect(harness.deliveries[0]).toContain("✅ Pi task completed");
  expect(harness.deliveries[0]).toContain("Project: example-api");
});

test("completion is invalidated by later tool work", async () => {
  const harness = setup();
  await start(harness);
  await harness.handlers.get("agent_start")?.({ type: "agent_start" }, harness.ctx);
  const tool = harness.tools.find(({ name }) => name === "notify_user");

  await tool.execute(
    "call-1",
    { kind: "completed", summary: "Finished too early" },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );
  harness.handlers.get("tool_execution_start")?.({
    type: "tool_execution_start",
    toolCallId: "later",
    toolName: "bash",
    args: {},
  }, harness.ctx);
  harness.handlers.get("message_end")?.({ type: "message_end", message: assistantMessage("stop") }, harness.ctx);
  await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);

  expect(harness.deliveries).toHaveLength(0);
});

test("completion is not sent after error, abort, or truncated final output", async () => {
  for (const stopReason of ["error", "aborted", "length"] as const) {
    const harness = setup();
    await start(harness);
    await harness.handlers.get("agent_start")?.({ type: "agent_start" }, harness.ctx);
    const tool = harness.tools.find(({ name }) => name === "notify_user");
    await tool.execute(
      "call-1",
      { kind: "completed", summary: `Final response ended with ${stopReason}` },
      new AbortController().signal,
      () => {},
      harness.ctx,
    );
    harness.handlers.get("message_end")?.({ type: "message_end", message: assistantMessage(stopReason) }, harness.ctx);
    await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
    expect(harness.deliveries).toHaveLength(0);
    rmSync(temp!, { recursive: true, force: true });
    temp = undefined;
  }
});

test("blocker sends immediately and requires a concrete user action", async () => {
  const harness = setup();
  await start(harness);
  const tool = harness.tools.find(({ name }) => name === "notify_user");

  const missing = await tool.execute(
    "call-1",
    { kind: "blocked", summary: "Production approval is missing" },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );
  expect(missing.details.error).toContain("assistance_needed");
  expect(harness.deliveries).toHaveLength(0);

  const sent = await tool.execute(
    "call-2",
    {
      kind: "blocked",
      summary: "Production approval is missing",
      assistance_needed: "Approve change request CR-1234",
    },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );
  expect(sent.details.delivered).toBe(true);
  expect(harness.deliveries).toHaveLength(1);
  expect(harness.deliveries[0]).toContain("⛔ Pi needs your help");
  expect(harness.deliveries[0]).toContain("Need: Approve change request CR-1234");
});

test("notification content redacts common credential patterns", async () => {
  const harness = setup();
  await start(harness);
  const tool = harness.tools.find(({ name }) => name === "notify_user");
  const token = `123456:${"a".repeat(32)}`;

  await tool.execute(
    "call-1",
    {
      kind: "blocked",
      summary: `Telegram token=${token}`,
      assistance_needed: "Rotate password=hunter2",
    },
    new AbortController().signal,
    () => {},
    harness.ctx,
  );

  expect(harness.deliveries[0]).not.toContain(token);
  expect(harness.deliveries[0]).not.toContain("hunter2");
  expect(harness.deliveries[0]).toContain("[REDACTED]");
});

test("duplicate blocker notifications are suppressed", async () => {
  const harness = setup();
  await start(harness);
  const tool = harness.tools.find(({ name }) => name === "notify_user");
  const params = {
    kind: "blocked",
    summary: "A physical device is required",
    assistance_needed: "Connect the device",
  };

  const first = await tool.execute("call-1", params, new AbortController().signal, () => {}, harness.ctx);
  const second = await tool.execute("call-2", params, new AbortController().signal, () => {}, harness.ctx);

  expect(first.details.delivered).toBe(true);
  expect(second.details.duplicate).toBe(true);
  expect(harness.deliveries).toHaveLength(1);
});

test("routed helpers do not register the notification tool", async () => {
  const harness = setup({
    env: { PI_ROUTED_ROOT_TAB_ID: "w1:t1", HERDR_TAB_ID: "w1:t2" },
  });
  await start(harness);
  expect(harness.tools).toHaveLength(0);
  expect(harness.statuses.at(-1)).toBe("telegram:unavailable");
});

test("only the owning top-level session registers the tool in one process", async () => {
  let owner: object | undefined;
  const claimPrimary = (instance: object) => {
    owner ??= instance;
    return owner === instance;
  };
  const releasePrimary = (instance: object) => {
    if (owner === instance) owner = undefined;
  };

  const root = setup({ claimPrimary, releasePrimary });
  const rootTemp = temp!;
  await start(root);
  const child = setup({ claimPrimary, releasePrimary });
  await start(child);

  expect(root.tools).toHaveLength(1);
  expect(child.tools).toHaveLength(0);
  expect(child.statuses.at(-1)).toBe("telegram:unavailable");

  await root.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, root.ctx);
  expect(owner).toBeUndefined();
  rmSync(rootTemp, { recursive: true, force: true });
});
