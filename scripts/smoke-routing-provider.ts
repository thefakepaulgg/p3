import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  if (model === "worker") {
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
  const faux = fauxProvider({ provider: "smoke-routing", api: "smoke-routing-api", models: ["root", "worker", "error"].map((id) => ({ id, reasoning: false, input: ["text"] })) });
  const response = (context: any, _options: any, _state: any, model: any) => { faux.appendResponses([response]); return decide(model.id, context.messages); };
  faux.setResponses([response]);
  pi.registerProvider(faux.provider);
}
