import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkerEditor, isOwnedRestoredDraft, registerWorkerEditorGuard, saveRoutedInstruction } from "./editor-guard.ts";
import { ROUTING_MANIFEST_VERSION, taskManifestRecord, writeRoutingManifest } from "./manifest.ts";
import type { TaskHandle } from "./state.ts";

const first = randomUUID(); const second = randomUUID(); const foreign = randomUUID();
const request = (id: string, text: string) => `p3:routed-request ${id}\n${text}`;
const one = request(first, "Generated direction, including\n\nparagraphs.");
const two = request(second, "Another generated direction.");
const instructions = new Map([[first, one], [second, two]]);
for (const draft of [one, two, `${one}\n\n${two}`]) {
  test(`matches only exact serialized owned requests: ${draft.slice(0, 54)}`, () => expect(isOwnedRestoredDraft(draft, instructions)).toBe(true));
}
for (const [label, draft] of [
  ["human", "My unfinished human draft"], ["prefix", `Human text\n\n${one}`], ["suffix", `${one}\n\nHuman text`],
  ["mixed", `${one}\n\nHuman text\n\n${two}`], ["partial", one.slice(0, -1)], ["edited", one.replace("Generated", "Edited")],
  ["foreign", request(foreign, "Foreign direction")], ["single newline", `${one}\n${two}`],
  ["trailing separator", `${one}\n\n`], ["extra separator", `${one}\n\n\n\n${two}`],
] as const) {
  test(`preserves ${label} draft rather than clearing a prefix match`, () => expect(isOwnedRestoredDraft(draft, instructions)).toBe(false));
}

let temp: string;
let previous: Record<string, string | undefined>;
const envNames = ["PI_CODING_AGENT_DIR", "PI_ROUTING_MANIFEST", "HERDR_PANE_ID"] as const;
beforeEach(() => {
  previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  temp = mkdtempSync(join(tmpdir(), "p3-editor-guard-"));
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.PI_ROUTING_MANIFEST = join(temp, "manifest.json");
  process.env.HERDR_PANE_ID = "w1:p2";
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  for (const key of envNames) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
const taskFixture = (): TaskHandle => ({
  handle: "rt-editor", assignmentId: randomUUID(), messageToken: randomUUID(), parentSessionId: "parent-session",
  paneId: "w1:p2", terminalId: "terminal-2", sessionId: randomUUID(), route: "luna", routeExplicit: true,
  target: "herdr", model: "openai-codex/gpt-6-luna", thinking: "high", label: "Editor worker", state: "running",
  startedAt: 1, transitions: 0, notifiedStates: [], capabilities: [], instructionIds: [first, second],
});
const socketPath = (id: string) => join(tmpdir(), `p3-editor-${process.getuid?.() ?? "local"}-${createHash("sha256").update(id).digest("hex").slice(0, 20)}.sock`);
const workerFixture = async (draft: string, idle = true) => {
  const task = taskFixture(); const handlers = new Map<string, Function>(); const cleared: string[] = [];
  writeRoutingManifest(process.env.PI_ROUTING_MANIFEST!, { version: ROUTING_MANIFEST_VERSION, parentSessionId: task.parentSessionId!, parentPaneId: "w1:p1", updatedAt: 1, tasks: [taskManifestRecord(task)!] });
  saveRoutedInstruction(task.assignmentId!, first, one); saveRoutedInstruction(task.assignmentId!, second, two);
  const pi: any = { on: (name: string, handler: Function) => handlers.set(name, handler) };
  const ctx: any = { hasUI: true, isIdle: () => idle, sessionManager: { getSessionId: () => task.sessionId }, ui: {
    getEditorText: () => draft, setEditorText: (text: string) => { draft = text; cleared.push(text); },
  } };
  registerWorkerEditorGuard(pi, task.assignmentId!);
  await handlers.get("session_start")!({}, ctx);
  return { task, ctx, cleared, text: () => draft, shutdown: () => handlers.get("session_shutdown")!() };
};
test("owned joined instructions clear only after exact identity and native idle acknowledgement", async () => {
  const fixture = await workerFixture(`${one}\n\n${two}`);
  try { await ensureWorkerEditor(fixture.task, true, true); expect(fixture.cleared).toEqual([""]); expect(fixture.text()).toBe(""); }
  finally { fixture.shutdown(); }
});
for (const draft of ["Human draft", `${one}\n\nHuman addition`, one.slice(0, -1), request(foreign, "Foreign")]) {
  test(`worker preserves unowned text (${draft.slice(0, 20)}) and refuses acknowledgement`, async () => {
    const fixture = await workerFixture(draft);
    try { await expect(ensureWorkerEditor(fixture.task, true, true)).rejects.toThrow("unowned draft"); expect(fixture.cleared).toEqual([]); expect(fixture.text()).toBe(draft); }
    finally { fixture.shutdown(); }
  });
}
for (const field of ["handle", "messageToken", "parentSessionId", "paneId", "terminalId", "sessionId"] as const) {
  test(`foreign ${field} cannot clear even an owned draft`, async () => {
    const fixture = await workerFixture(one);
    try { await expect(ensureWorkerEditor({ ...fixture.task, [field]: "foreign" }, true, true)).rejects.toThrow("identity is unverified"); expect(fixture.cleared).toEqual([]); }
    finally { fixture.shutdown(); }
  });
}
test("working native context cannot clear owned corrections; clearOwned=false cannot erase a draft", async () => {
  const fixture = await workerFixture(one, false);
  try {
    await expect(ensureWorkerEditor(fixture.task, true, true)).rejects.toThrow("idle boundary");
    await expect(ensureWorkerEditor(fixture.task, false, false)).rejects.toThrow("draft was preserved");
    expect(fixture.text()).toBe(one); expect(fixture.cleared).toEqual([]);
  } finally { fixture.shutdown(); }
});
test("foreign instruction artifact cannot authorize clearing", async () => {
  const fixture = await workerFixture(one);
  saveRoutedInstruction(randomUUID(), first, one);
  try { await expect(ensureWorkerEditor(fixture.task, true, true)).rejects.toThrow("instruction identity is unverified"); expect(fixture.text()).toBe(one); }
  finally { fixture.shutdown(); }
});
test("client sends the exact task identity and idle/clear requirements to its private local socket", async () => {
  const task = taskFixture(); let received: any;
  const server = createServer((socket) => {
    let input = ""; socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; if (!input.includes("\n")) return; received = JSON.parse(input.split("\n")[0]); socket.end('{"empty":true}\n'); });
  });
  const path = socketPath(task.assignmentId!);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  try {
    await ensureWorkerEditor(task, true, true);
    expect(received).toEqual({ assignmentId: task.assignmentId, handle: task.handle, token: task.messageToken, parentSessionId: task.parentSessionId,
      paneId: task.paneId, terminalId: task.terminalId, sessionId: task.sessionId, instructions: [first, second], clearOwned: true, requireIdle: true });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(path, { force: true }); }
});
for (const field of ["assignmentId", "messageToken", "sessionId", "terminalId"] as const) {
  test(`client refuses missing ${field} before contacting any editor`, async () => {
    await expect(ensureWorkerEditor({ ...taskFixture(), [field]: undefined }, true, true)).rejects.toThrow("identity is incomplete");
  });
}
