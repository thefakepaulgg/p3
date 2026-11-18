import { expect, test } from "bun:test";
import {
  buildTitlePrompt,
  cleanTitle,
  conversationTurns,
  createSessionNamingExtension,
  isEligibleSession,
  sessionNamingConfig,
} from "../session-naming.ts";

const haiku: any = { provider: "anthropic", id: "claude-haiku-5-5", api: "anthropic-messages", reasoning: true };
const luna: any = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", reasoning: true };

function entry(role: "user" | "assistant", text: string): any {
  return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

function reply(text: string, stopReason = "stop"): any {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { name?: string; settings?: unknown; complete?: (model: any, context: any) => Promise<any>; mode?: string; env?: NodeJS.ProcessEnv; models?: any[] } = {}) {
  const handlers = new Map<string, Function>();
  const calls: Array<{ model: any; context: any }> = [];
  const setNames: string[] = [];
  let name = options.name;
  const entries: any[] = [];
  const available = options.models ?? [haiku, luna];
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getSessionName: () => name,
    setSessionName: (next: string) => {
      name = next;
      setNames.push(next);
      void handlers.get("session_info_changed")?.({ type: "session_info_changed", name: next }, ctx);
    },
    getSettings: () => options.settings ?? {},
  };
  const ctx: any = {
    mode: options.mode ?? "tui",
    hasUI: true,
    model: haiku,
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
    },
  };
  createSessionNamingExtension({
    env: options.env ?? {},
    debug: () => {},
    complete: async (model, context) => {
      calls.push({ model, context });
      return options.complete ? options.complete(model, context) : reply("Fix flaky login redirect test");
    },
  })(pi);
  return {
    calls,
    setNames,
    entries,
    getName: () => name,
    userRename: (next: string) => {
      name = next;
      return handlers.get("session_info_changed")!({ type: "session_info_changed", name: next }, ctx);
    },
    start: (reason = "startup") => handlers.get("session_start")!({ type: "session_start", reason }, ctx),
    agentEnd: async () => {
      await handlers.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
      await flush();
    },
  };
}

test("cleanTitle strips quotes, labels, markdown, and trailing punctuation", () => {
  expect(cleanTitle('"Fix flaky login test."')).toBe("Fix flaky login test");
  expect(cleanTitle("Title: **Add OAuth refresh**\nextra line")).toBe("Add OAuth refresh");
  expect(cleanTitle("  `debug   websocket   reconnects`!  ")).toBe("Debug websocket reconnects");
  expect(cleanTitle("“Session naming extension”")).toBe("Session naming extension");
  expect(cleanTitle("")).toBeUndefined();
  expect(cleanTitle('"..."')).toBeUndefined();
});

test("cleanTitle converts Title Case to sentence case but keeps proper nouns in sentence case", () => {
  expect(cleanTitle("Fix Login Redirect Bug")).toBe("Fix login redirect bug");
  expect(cleanTitle("Migrate API to React Query")).toBe("Migrate API to React Query");
  expect(cleanTitle("Add retry for GitHub webhooks")).toBe("Add retry for GitHub webhooks");
});

test("cleanTitle limits words and length", () => {
  expect(cleanTitle("one two three four five six seven eight nine ten")).toBe("One two three four five six seven eight");
  const long = cleanTitle("Investigate extraordinarily-long-hyphenated-identifier behaviour within configuration loader internals");
  expect(long!.length).toBeLessThanOrEqual(60);
});

test("sessionNamingConfig defaults and validation", () => {
  expect(sessionNamingConfig(undefined)).toEqual({ enabled: true, retitleAfterTurns: 8 });
  expect(sessionNamingConfig({ p3: { sessionNaming: { enabled: false, models: ["openai/gpt-6-luna", "bad"], retitleAfterTurns: 0 } } }))
    .toEqual({ enabled: false, models: [{ provider: "openai", id: "gpt-6-luna" }], retitleAfterTurns: 0 });
  expect(sessionNamingConfig({ p3: { sessionNaming: { retitleAfterTurns: -1 } } }).retitleAfterTurns).toBe(8);
});

test("prompt quotes the first request and reply", () => {
  const turns = conversationTurns([entry("user", "Please fix the login test"), { type: "session_info", name: "x" }, entry("assistant", "Fixed it")]);
  expect(turns).toHaveLength(2);
  expect(buildTitlePrompt(turns)).toContain("User: Please fix the login test");
  expect(buildTitlePrompt(turns, "Old title")).toContain("Current title: Old title");
  expect(buildTitlePrompt([])).toBeUndefined();
});

test("eligibility skips print mode, background subagents, and helpers", () => {
  expect(isEligibleSession({ mode: "tui", hasUI: true }, {})).toBe(true);
  expect(isEligibleSession({ mode: "print", hasUI: false }, {})).toBe(false);
  expect(isEligibleSession({ mode: "tui", hasUI: true }, { PI_SUBAGENT_MODE: "background" })).toBe(false);
  expect(isEligibleSession({ mode: "tui", hasUI: true }, { HERDR_ROLE: "helper", HERDR_PANE_ID: "p1" })).toBe(false);
});

test("names an unnamed session after the first exchange using the session's provider first", async () => {
  const h = setup();
  await h.start();
  h.entries.push(entry("user", "The login redirect test is flaky, please fix it"));
  await h.agentEnd();
  expect(h.calls).toHaveLength(0);
  h.entries.push(entry("assistant", "I fixed the race in the redirect test."));
  await h.agentEnd();
  expect(h.calls[0].model).toBe(haiku);
  expect(h.getName()).toBe("Fix flaky login redirect test");
  await h.agentEnd();
  expect(h.calls).toHaveLength(1);
});

test("skips a session that already has a name, such as a resumed one", async () => {
  const h = setup({ name: "My saved session" });
  await h.start("resume");
  h.entries.push(entry("user", "hi"), entry("assistant", "hello"));
  await h.agentEnd();
  expect(h.calls).toHaveLength(0);
  expect(h.setNames).toEqual([]);
});

test("never overwrites a name the user sets while the title request is running", async () => {
  let resolve!: (value: any) => void;
  const h = setup({ complete: () => new Promise((done) => { resolve = done; }) });
  await h.start();
  h.entries.push(entry("user", "hi"), entry("assistant", "hello"));
  await h.agentEnd();
  await h.userRename("Mine");
  resolve(reply("Generated title"));
  await flush();
  expect(h.getName()).toBe("Mine");
  expect(h.setNames).toEqual([]);
});

test("never re-titles after the user renames an auto-named session", async () => {
  const h = setup({ settings: { p3: { sessionNaming: { retitleAfterTurns: 1 } } } });
  await h.start();
  h.entries.push(entry("user", "hi"), entry("assistant", "hello"));
  await h.agentEnd();
  expect(h.getName()).toBe("Fix flaky login redirect test");
  await h.userRename("Mine");
  h.entries.push(entry("user", "new topic"), entry("assistant", "ok"));
  await h.agentEnd();
  expect(h.calls).toHaveLength(1);
  expect(h.getName()).toBe("Mine");
});

test("re-titles once after the configured turns, and KEEP leaves the title", async () => {
  const replies = ["Fix login test", "Refactor billing exports", "Another title"];
  const h = setup({ settings: { p3: { sessionNaming: { retitleAfterTurns: 2 } } }, complete: async () => reply(replies.shift()!) });
  await h.start();
  h.entries.push(entry("user", "fix login"), entry("assistant", "done"));
  await h.agentEnd();
  h.entries.push(entry("user", "now billing"), entry("assistant", "ok"));
  await h.agentEnd();
  expect(h.calls).toHaveLength(1);
  h.entries.push(entry("user", "billing exports"), entry("assistant", "ok"));
  await h.agentEnd();
  expect(h.calls[1].context.messages[0].content[0].text).toContain("Current title: Fix login test");
  expect(h.getName()).toBe("Refactor billing exports");
  h.entries.push(entry("user", "a"), entry("assistant", "b"), entry("user", "c"), entry("assistant", "d"));
  await h.agentEnd();
  expect(h.calls).toHaveLength(2);

  const keep = setup({ settings: { p3: { sessionNaming: { retitleAfterTurns: 1 } } }, complete: async () => reply(keep.calls.length === 1 ? "First title" : "KEEP") });
  await keep.start();
  keep.entries.push(entry("user", "x"), entry("assistant", "y"));
  await keep.agentEnd();
  keep.entries.push(entry("user", "z"), entry("assistant", "w"));
  await keep.agentEnd();
  expect(keep.calls).toHaveLength(2);
  expect(keep.setNames).toEqual(["First title"]);
});

test("a failed model call falls through to the next model, then fails silently", async () => {
  const fallback = setup({ complete: async (model) => {
    if (model === haiku) throw new Error("boom");
    return reply("Fallback title");
  } });
  await fallback.start();
  fallback.entries.push(entry("user", "hi"), entry("assistant", "hello"));
  await fallback.agentEnd();
  expect(fallback.calls.map((call) => call.model)).toEqual([haiku, luna]);
  expect(fallback.getName()).toBe("Fallback title");

  const failing = setup({ complete: async () => reply("", "error") });
  await failing.start();
  failing.entries.push(entry("user", "hi"), entry("assistant", "hello"));
  await failing.agentEnd();
  await failing.agentEnd();
  await failing.agentEnd();
  expect(failing.getName()).toBeUndefined();
  // Two attempts across both candidates, then it stops trying.
  expect(failing.calls).toHaveLength(4);
});

test("disabled setting, print mode, and missing models spend no tokens", async () => {
  for (const h of [
    setup({ settings: { p3: { sessionNaming: { enabled: false } } } }),
    setup({ mode: "print" }),
    setup({ models: [] }),
  ]) {
    await h.start();
    h.entries.push(entry("user", "hi"), entry("assistant", "hello"));
    await h.agentEnd();
    expect(h.calls).toHaveLength(0);
    expect(h.getName()).toBeUndefined();
  }
});
