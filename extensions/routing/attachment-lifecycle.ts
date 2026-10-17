import { registerRoutedSessionIdentity } from "./session-identity.ts";
import { chmodSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerReadonlyWorkerPolicy } from "./worker-policy.ts";
import { attachmentSocketPath, readAttachmentControlToken, readAttachmentPresence, readAttachmentRecord, writeAttachmentPresence, type AttachmentPresence } from "./attachment-store.ts";

export * from "./attachment-store.ts";

const canonical = (path?: string) => { try { return path ? realpathSync(path) : undefined; } catch { return undefined; } };

/**
 * Native lifecycle for a human-attached saved session. Unlike worker-lifecycle it never
 * resolves assignments, records results or blocks manual turns: the human owns this pane.
 */
export default function attachmentLifecycle(pi: ExtensionAPI): void {
  const attachmentId = process.env.PI_ROUTED_ATTACHMENT_ID;
  if (!attachmentId) return;
  registerRoutedSessionIdentity(pi);
  registerReadonlyWorkerPolicy(pi);
  let context: ExtensionContext | undefined;
  let server: Server | undefined;
  let onClaimedSession = false;
  let uiPromptActive = false;
  pi.on("ui_prompt_start", () => { uiPromptActive = true; });
  pi.on("ui_prompt_end", () => { uiPromptActive = false; });

  const stopServer = () => { server?.close(); server = undefined; rmSync(attachmentSocketPath(attachmentId), { force: true }); };

  const handle = (raw: string): { reply: object; shutdown?: boolean } => {
    const request = JSON.parse(raw);
    const record = readAttachmentRecord(attachmentId);
    const token = readAttachmentControlToken(attachmentId);
    const ctx = context;
    if (!ctx || !onClaimedSession || !record || !token || request.token !== token || request.attachmentId !== attachmentId ||
      request.parentSessionId !== record.parentSessionId || request.paneId !== record.paneId || request.paneId !== process.env.HERDR_PANE_ID ||
      request.terminalId !== record.terminalId || request.sessionId !== record.sessionId || ctx.sessionManager.getSessionId() !== record.sessionId) {
      throw new Error("Attachment control identity is unverified");
    }
    if (request.op === "status") return { reply: { ok: true, pid: process.pid, idle: ctx.isIdle() } };
    if (request.op !== "close") throw new Error("Unsupported attachment control operation");
    // Closing is intentional user control, but never erase in-flight work or an unsent draft.
    if (!ctx.hasUI) throw new Error("Attached pane has no interactive editor to verify; close it from its own pane");
    if (uiPromptActive) throw new Error("Attached session is waiting on a UI prompt; answer it in its pane first");
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Attached session is busy; it was not closed");
    if (ctx.ui.getEditorText()) throw new Error("Attached session has an unsent draft; it was preserved and the session was not closed");
    return { reply: { ok: true, pid: process.pid }, shutdown: true };
  };

  pi.on("session_start", async (event, ctx) => {
    context = ctx; uiPromptActive = false;
    const record = readAttachmentRecord(attachmentId);
    const previous = readAttachmentPresence(attachmentId);
    const sessionPath = canonical(ctx.sessionManager.getSessionFile());
    const paneId = process.env.HERDR_PANE_ID;
    const sameProcess = !previous || previous.pid === process.pid;
    onClaimedSession = !!record && !!paneId && sameProcess && !previous?.drift && ["starting", "open"].includes(record.status) &&
      sessionPath === record.sessionPath && ctx.sessionManager.getSessionId() === record.sessionId && paneId === record.paneId;
    if (!onClaimedSession) {
      // Report drift instead of guessing which session the parent should control.
      const presence: AttachmentPresence = previous && !sameProcess ? previous : {
        ...(previous ?? { attachmentId, pid: process.pid, sessionId: record?.sessionId ?? "", sessionPath: record?.sessionPath ?? "", paneId: paneId ?? "", startedAt: Date.now() }),
        drift: previous?.drift ?? { reason: event.reason, sessionId: ctx.sessionManager.getSessionId(), sessionPath, at: Date.now() },
      };
      if (sameProcess) writeAttachmentPresence(presence);
      if (ctx.hasUI) ctx.ui.notify("This pane left its parent-attached session; parent control is refused. Close it here when finished.", "warning");
      return;
    }
    // Published before any model turn so the parent can verify the exact process.
    writeAttachmentPresence({ attachmentId, pid: process.pid, sessionId: record!.sessionId, sessionPath: record!.sessionPath, paneId: paneId!, startedAt: previous?.startedAt ?? Date.now() });
    const path = attachmentSocketPath(attachmentId);
    rmSync(path, { force: true });
    server = createServer((socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input) > 16384) { socket.end("{}\n"); return; }
        const end = input.indexOf("\n");
        if (end < 0) return;
        socket.removeAllListeners("data");
        let result: { reply: object; shutdown?: boolean };
        try { result = handle(input.slice(0, end)); }
        catch (error) { result = { reply: { error: error instanceof Error ? error.message : String(error) } }; }
        // Native graceful shutdown in the same tick as the idle/empty-editor proof.
        socket.end(`${JSON.stringify(result.reply)}\n`, () => { if (result.shutdown) context?.shutdown(); });
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, () => { server!.off("error", reject); resolve(); }); });
    chmodSync(path, 0o600);
  });

  pi.on("session_shutdown", (event, ctx) => {
    stopServer();
    const presence = readAttachmentPresence(attachmentId);
    if (onClaimedSession && presence?.pid === process.pid && !presence.drift) {
      let bytes: number | undefined;
      try { bytes = statSync(ctx.sessionManager.getSessionFile()!).size; } catch { /* unverifiable end */ }
      if (bytes !== undefined) writeAttachmentPresence({ ...presence, shutdown: { reason: event.reason, at: Date.now(), bytes } });
    }
    onClaimedSession = false;
    context = undefined;
  });
}
