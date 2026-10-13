import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAssignmentReceipt, saveAssignmentResult, writeAssignmentReceipt, type AssignmentOutcome, type AssignmentReceipt } from "./artifacts.ts";
import { parseJson, runHerdr } from "./herdr.ts";
import { registerReadonlyWorkerPolicy } from "./worker-policy.ts";

export default function routedWorkerLifecycle(pi: ExtensionAPI): void {
  const assignmentId = process.env.PI_ROUTED_ASSIGNMENT_ID;
  if (!assignmentId) return;
  registerReadonlyWorkerPolicy(pi);
  let receipt: AssignmentReceipt | undefined;
  let outcome: AssignmentOutcome | undefined;
  let responseEntryId: string | undefined;
  let responseText = "";
  let lastWrite = 0;

  const publish = () => { if (receipt) { writeAssignmentReceipt(receipt); lastWrite = Date.now(); } };
  const touch = () => {
    if (!receipt || receipt.outcome !== "running") return;
    receipt.lastActivityAt = Date.now();
    if (Date.now() - lastWrite >= 1000) publish();
  };
  pi.on("agent_start", async (_event, ctx) => {
    const paneId = process.env.HERDR_PANE_ID;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!paneId || !sessionPath) throw new Error("Routed worker requires a persisted Pi session and exact pane identity");
    const agent = parseJson(await runHerdr(pi, ["agent", "get", paneId], 5000), "routed worker identity")?.result?.agent;
    if (agent?.pane_id !== paneId || !agent.terminal_id) throw new Error("Routed worker terminal identity is unverified");
    const previous = readAssignmentReceipt(assignmentId);
    if (previous && previous.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Routed assignment belongs to another Pi session");
    receipt = {
      version: 1, assignmentId, requestId: previous?.requestId ?? assignmentId, generation: (previous?.generation ?? 0) + 1,
      sessionId: ctx.sessionManager.getSessionId(), sessionPath, paneId, terminalId: agent.terminal_id,
      outcome: "running", lastActivityAt: Date.now(),
    };
    outcome = undefined; responseEntryId = undefined; responseText = "";
    publish();
  });
  pi.on("message_start", (event) => {
    if (event.message.role !== "user" || !receipt) return;
    const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const request = /^p3:routed-request ([0-9a-f-]{36})\n/.exec(text)?.[1];
    if (request) { receipt.requestId = request; receipt.outcome = "running"; publish(); }
  });
  pi.on("turn_end", (event) => {
    touch();
    outcome = event.outcome;
    if (event.message.role !== "assistant") return;
    responseEntryId = event.messageEntryId;
    responseText = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  });
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });
  pi.on("tool_execution_start", touch);
  pi.on("tool_execution_end", touch);
  pi.on("message_update", touch);
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!receipt || receipt.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (process.env.PI_SUBAGENT_MODE === "background") { touch(); return; }
    const entry = responseEntryId ? ctx.sessionManager.getEntries().find((entry) => entry.id === responseEntryId) : undefined;
    const verifiedResponse = entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop";
    const completed = outcome === "completed" && verifiedResponse && !!responseText;
    const next: AssignmentReceipt = { ...receipt, outcome: outcome === "aborted" ? "aborted" : completed ? "completed" : "error", lastActivityAt: Date.now(), responseEntryId };
    if (completed) {
      try { next.resultHash = saveAssignmentResult(next.requestId, next.generation, next.sessionId, responseEntryId!, responseText); }
      catch (error) { next.outcome = "error"; next.error = `Result persistence failed: ${error instanceof Error ? error.message : String(error)}`; }
    } else if (outcome !== "aborted") {
      next.error = outcome === "error" ? "Pi model execution failed; partial assistant text is not a result" : "Pi execution settled without a verified nonempty final response";
    }
    receipt = next;
    publish();
  });
}
