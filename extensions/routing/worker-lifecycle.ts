import { registerRoutedSessionIdentity } from "./session-identity.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasCancellationIntent, readAssignmentReceipt, saveAssignmentResult, writeAssignmentReceipt, type AssignmentOutcome, type AssignmentReceipt } from "./artifacts.ts";
import { parseJson, runHerdr } from "./herdr.ts";
import { readRoutingManifest } from "./manifest.ts";
import { registerWorkerEditorGuard } from "./editor-guard.ts";
import { registerReadonlyWorkerPolicy } from "./worker-policy.ts";
import { cancelAssignmentAsk, readPendingAssignmentAsk, registerAssignmentQuestions } from "./questions.ts";

export default function routedWorkerLifecycle(pi: ExtensionAPI): void {
  const assignmentId = process.env.PI_ROUTED_ASSIGNMENT_ID;
  if (!assignmentId) return;
  registerRoutedSessionIdentity(pi);
  registerWorkerEditorGuard(pi, assignmentId);
  registerAssignmentQuestions(pi, assignmentId);
  registerReadonlyWorkerPolicy(pi);
  let receipt: AssignmentReceipt | undefined;
  let outcome: AssignmentOutcome | undefined;
  let responseEntryId: string | undefined;
  let responseText = "";
  let lastWrite = 0;
  let ownedRun = true;
  const resolved = () => {
    const previous = readAssignmentReceipt(assignmentId);
    const owner = readRoutingManifest(process.env.PI_ROUTING_MANIFEST)?.tasks.find((task) => task.assignmentId === assignmentId);
    return previous?.outcome === "completed" || previous?.outcome === "error" || owner && ["completed", "failed", "stopped", "abandoned"].includes(owner.state);
  };
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || !resolved()) return;
    ctx.ui.setEditorText(event.text);
    ctx.ui.notify("This worker assignment has finished. Its draft was preserved; use the parent's resume control for a new generation.", "warning");
    return { action: "handled" };
  });
  pi.on("tool_call", () => !ownedRun ? { block: true, terminate: true, reason: "This worker has no active assignment; continue its saved session through the parent." } : undefined);

  const publish = () => { if (receipt) { writeAssignmentReceipt(receipt); lastWrite = Date.now(); } };
  const touch = () => {
    if (!ownedRun || !receipt || receipt.outcome !== "running") return;
    receipt.lastActivityAt = Date.now();
    if (Date.now() - lastWrite >= 1000) publish();
  };
  pi.on("agent_start", async (_event, ctx) => {
    ownedRun = !resolved();
    if (!ownedRun) return;
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
      outcome: "running", workerPid: process.pid, lastActivityAt: Date.now(),
    };
    outcome = undefined; responseEntryId = undefined; responseText = "";
    publish();
  });
  pi.on("message_start", (event) => {
    if (!ownedRun || event.message.role !== "user" || !receipt) return;
    const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const request = /^p3:routed-request ([0-9a-f-]{36})\n/.exec(text)?.[1];
    if (request) { receipt.requestId = request; receipt.outcome = "running"; publish(); }
  });
  pi.on("turn_end", (event) => {
    if (!ownedRun) return;
    touch();
    outcome = event.outcome;
    if (event.message.role !== "assistant") return;
    responseEntryId = event.messageEntryId;
    responseText = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  });
  pi.on("agent_before_settle", (event) => { if (ownedRun) outcome = event.outcome; });
  pi.on("tool_execution_start", touch);
  pi.on("tool_execution_end", touch);
  pi.on("message_update", touch);
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!ownedRun || !receipt || receipt.sessionId !== ctx.sessionManager.getSessionId()) return;
    const entries = ctx.sessionManager.getEntries();
    const entry = responseEntryId ? entries.find((entry) => entry.id === responseEntryId) : undefined;
    const lastAssistant = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    // Pi 1.0 reports an awaited-tool cancellation as error; correlate its native sentinel to our Esc intent.
    if (outcome === "error" && entry === lastAssistant && entry?.type === "message" && entry.message.role === "assistant" &&
      entry.message.stopReason === "error" && entry.message.errorMessage === "This operation was aborted" && hasCancellationIntent(receipt)) outcome = "aborted";
    if (outcome === "aborted") cancelAssignmentAsk(assignmentId);
    if (readPendingAssignmentAsk(assignmentId)) { touch(); return; }
    if (process.env.PI_SUBAGENT_MODE === "background") { touch(); return; }
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
