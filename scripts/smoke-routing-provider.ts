import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const text = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
function callResult(messages: any[], name: string, after = -1) {
  for (let index = messages.length - 1; index > after; index--) {
    const call = messages[index].role === "assistant" && messages[index].content?.find((part: any) => part.type === "toolCall" && part.name === name);
    if (!call) continue;
    const result = messages.slice(index + 1).find((message: any) => message.role === "toolResult" && message.toolCallId === call.id && message.toolName === name);
    if (result) return result;
  }
}
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function decide(model: string, messages: any[]) {
  if (model === "error") return fauxAssistantMessage("PARTIAL: not a successful result", { stopReason: "error", errorMessage: "Controlled terminal smoke error" });
  if (model === "ask") {
    const answer = callResult(messages, "ask_parent");
    if (!answer) return call("ask_parent", { question: "Which exact fixture answer should I use?" });
    if (answer.isError) throw new Error(`Awaited ask failed: ${text(answer)}`);
    return fauxAssistantMessage(`P3_SMOKE_ASK_DONE ${text(answer)}`);
  }
  if (model === "hold") {
    const latest = messages.findLast((m: any) => m.role === "user");
    if (text(latest).includes("P3_SMOKE_REPLACEMENT")) return fauxAssistantMessage("P3_SMOKE_REPLACEMENT_DONE");
    if (callResult(messages, "smoke_hold")) return fauxAssistantMessage("P3_SMOKE_RACE_RESULT");
    return call("smoke_hold", {});
  }
  if (model === "worker") {
    if (messages.some((m: any) => m.role === "user" && text(m).includes("P3_SMOKE_FOLLOWUP"))) return fauxAssistantMessage("P3_SMOKE_FOLLOWUP_DONE (saved history retained, no tools replayed)");
    const denied = callResult(messages, "write");
    const read = callResult(messages, "read");
    if (read?.isError) throw new Error("Actual package read failed");
    if (denied) {
      if (!denied.isError || !read) throw new Error("Read-only write was not rejected or package evidence is absent");
      return fauxAssistantMessage(`${text(read)}\nREADONLY_WRITE_DENIED`);
    }
    if (read) return call("write", { path: "readonly-canary.txt", content: "This write must never execute" });
    return call("read", { path: "package.json" });
  }
  const latestUser = messages.findLastIndex((m: any) => m.role === "user" && text(m).startsWith("P3_SMOKE_CONTROL "));
  const latestStart = messages.findLastIndex((m: any) => m.role === "user" && /^P3_SMOKE_(START|CASE|RESTART) /.test(text(m)));
  if (latestUser > latestStart) {
    const { args, marker } = JSON.parse(text(messages[latestUser]).slice("P3_SMOKE_CONTROL ".length));
    const result = callResult(messages, "subagent_control", latestUser);
    if (!result) return call("subagent_control", args);
    return fauxAssistantMessage(`P3_SMOKE_CONTROL_OK ${marker}\n${text(result)}`);
  }
  const boundary = messages.find((m: any) => m.role === "user" && text(m).startsWith("P3_SMOKE_CASE "));
  if (boundary) {
    if (!callResult(messages, "subagent")) {
      const kind = text(boundary).split(" ")[1];
      return call("subagent", { task: `P3_SMOKE_OBJECTIVE ${kind}: execute only this fixture objective.`, description: `smoke ${kind}`, route: kind.includes("STREAM") ? "smoke-stream/stream" : `smoke-routing/${kind === "ASK" ? "ask" : kind === "RESUME" ? "worker" : "hold"}`, readonly: kind === "ASK" || kind === "RESUME" || kind === "AUTO", pane_retention: kind === "RESUME" ? "close" : "keep" });
    }
    return fauxAssistantMessage("P3_SMOKE_CASE_READY");
  }
  const restartIndex = messages.findLastIndex((message: any) => message.role === "user" && text(message).startsWith("P3_SMOKE_RESTART "));
  const launch = callResult(messages, "subagent");
  if (launch?.isError) throw new Error(`Actual delegation failed: ${text(launch)}`);
  const handle = launch && /task (rt-[\w-]+):/.exec(text(launch))?.[1];
  if (restartIndex >= 0) {
    const result = callResult(messages, "subagent_control", restartIndex);
    if (result?.isError) throw new Error(`Durable result recovery failed: ${text(result)}`);
    if (result) return fauxAssistantMessage(`P3_SMOKE_RESTART_OK\n${text(result)}`);
    if (!handle) throw new Error("Saved transcript has no correlated delegated handle");
    return call("subagent_control", { action: "result", handle });
  }
  const prompt = messages.find((message: any) => message.role === "user" && text(message).startsWith("P3_SMOKE_START "));
  if (!prompt) throw new Error("Unexpected smoke root transcript");
  const failed = text(prompt).includes("ERROR");
  if (!launch) return call("subagent", { task: "Read package.json, demonstrate that a forbidden write is rejected, and report only observed evidence.", description: "routing smoke worker", route: `smoke-routing/${failed ? "error" : "worker"}`, readonly: true, files: ["package.json"], pane_retention: "close" });
  if (!handle) throw new Error("Delegation result omitted the actual task handle");
  const event = messages.find((message: any) => message.role === "user" && text(message).startsWith(`Subagent ${handle} ${failed ? "failed:" : "completed"}`));
  if (!event) return fauxAssistantMessage("Waiting for the real worker event.");
  const result = callResult(messages, "subagent_control");
  if (!result) return call("subagent_control", { action: failed ? "status" : "result", handle });
  if (result.isError) throw new Error(`Actual control failed: ${text(result)}`);
  if (failed && !text(result).includes("[failed]")) throw new Error("Partial error was not classified as failed");
  return fauxAssistantMessage(`${failed ? "P3_SMOKE_ERROR_OK" : "P3_SMOKE_SUCCESS_OK"}\n${text(result)}`);
}

export default function smokeProvider(pi: ExtensionAPI) {
  const root = process.env.P3_SMOKE_ROOT!;
  const assignment = process.env.PI_ROUTED_ASSIGNMENT_ID;
  if (!assignment) process.env.HERDR_SOCKET_PATH = join(root, "herdr-proxy.sock");
  const trace = (event: string, details: any = {}) => appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ event, at: Date.now(), assignment, pid: process.pid, ...details }) + "\n");
  let editorProbe: ReturnType<typeof setInterval> | undefined;
  pi.on("session_shutdown", () => { if (editorProbe) clearInterval(editorProbe); });
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.P3_SMOKE_SANDBOX !== "1") throw new Error("Smoke root/worker requires OS network denial");
    await new Promise<void>((yes, no) => {
      const socket = createConnection({ host: "127.0.0.1", port: 9 });
      socket.once("connect", () => { socket.destroy(); no(new Error("Worker TCP escaped network sandbox")); });
      socket.once("error", (error: any) => { if (["EPERM", "EACCES"].includes(error.code)) { trace("network_denied", { code: error.code }); yes(); } else no(error); });
    });
    if (assignment) editorProbe = setInterval(() => {
      const request = join(root, `probe-${assignment}`);
      if (existsSync(request)) writeFileSync(join(root, `probe-result-${assignment}.json`), JSON.stringify({ nonce: readFileSync(request, "utf8"), editor: ctx.ui.getEditorText(), idle: ctx.isIdle() }));
    }, 100);
  });
  let streamed = false;
  pi.on("message_update", (event: any) => {
    if (!streamed && event.message?.model === "stream" && text(event.message)) { streamed = true; trace("stream_delta"); }
  });
  pi.on("message_end", (event: any) => {
    // Nonzero synthetic fake-provider costs make duplicate historical billing observable.
    if (event.message.role === "assistant" && ["smoke-routing", "smoke-stream", "openai-codex"].includes(event.message.provider)) event.message.usage.cost.total = 1;
  });
  pi.on("agent_start", (_e, ctx) => trace("agent_start", { session: ctx.sessionManager.getSessionId() }));
  pi.on("agent_settled", (_e, ctx) => trace("agent_settled", { session: ctx.sessionManager.getSessionId(), editor: ctx.ui.getEditorText() }));
  pi.registerTool({ name: "smoke_hold", label: "Smoke hold", description: "Disposable local smoke boundary gate", parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      if (!assignment) throw new Error("Hold requires fixture assignment");
      trace("hold_enter");
      let applied = false;
      while (!signal?.aborted && !existsSync(join(root, `release-${assignment}`))) {
        const draft = join(root, `draft-${assignment}.json`);
        if (!applied && existsSync(draft)) { ctx.ui.setEditorText(JSON.parse(readFileSync(draft, "utf8"))); applied = true; trace("draft_applied", { editor: ctx.ui.getEditorText() }); }
        await sleep(20);
      }
      if (signal?.aborted) {
        trace("hold_abort_observed");
        await sleep(400); // An Esc acknowledgment is not the tool's settled boundary.
        trace("hold_abort_return");
        throw new Error("Controlled held tool cancelled");
      }
      trace("hold_release");
      return { content: [{ type: "text", text: "Released owned fixture gate" }], details: {} };
    }
  });
  const faux = fauxProvider({ provider: "smoke-routing", api: "smoke-routing-api", models: ["root", "worker", "error", "ask", "hold"].map((id) => ({ id, reasoning: false, input: ["text"] })) });
  const response = (context: any, _options: any, _state: any, model: any) => { faux.appendResponses([response]); trace("provider", { model: model.id, users: context.messages.filter((m: any) => m.role === "user").map(text) }); return decide(model.id, context.messages); };
  faux.setResponses([response]);
  pi.registerProvider(faux.provider);
  const automatic = fauxProvider({ provider: "openai-codex", api: "smoke-auto-api", models: [{ id: "gpt-6.1-sol", reasoning: false, input: ["text"] }] });
  const autoResponse = (context: any) => {
    automatic.appendResponses([autoResponse]);
    trace("auto_provider", { users: context.messages.filter((m: any) => m.role === "user").map(text) });
    return decide("worker", context.messages);
  };
  automatic.setResponses([autoResponse]); pi.registerProvider(automatic.provider);
  const streaming = fauxProvider({ provider: "smoke-stream", api: "smoke-stream-api", models: [{ id: "stream", reasoning: false, input: ["text"] }], tokensPerSecond: 80 });
  const streamResponse = (context: any) => {
    streaming.appendResponses([streamResponse]);
    trace("stream_provider", { users: context.messages.filter((m: any) => m.role === "user").map(text) });
    const replacement = context.messages.some((m: any) => m.role === "user" && text(m).includes("P3_SMOKE_REPLACEMENT"));
    return fauxAssistantMessage(replacement ? "P3_SMOKE_REPLACEMENT_DONE" : `P3_SMOKE_STREAMING ${"fixture partial text ".repeat(600)}`);
  };
  streaming.setResponses([streamResponse]); pi.registerProvider(streaming.provider);
}
