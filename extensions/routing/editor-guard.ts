import { createHash } from "node:crypto";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assignmentDirectory, atomicWriteArtifact } from "./artifacts.ts";
import { readRoutingManifest } from "./manifest.ts";
import type { TaskHandle } from "./state.ts";

const socketPath = (id: string) => join(tmpdir(), `p3-editor-${process.getuid?.() ?? "local"}-${createHash("sha256").update(id).digest("hex").slice(0, 20)}.sock`);
export function saveRoutedInstruction(assignmentId: string, requestId: string, text: string): void {
  atomicWriteArtifact(join(assignmentDirectory(requestId), "instruction.json"), JSON.stringify({ assignmentId, requestId, text }));
}

/** Never discard a human draft; only exact queued p3 instructions can be superseded. */
export function isOwnedRestoredDraft(text: string, instructions: Map<string, string>): boolean {
  let rest = text;
  while (rest) {
    const id = /^p3:routed-request ([0-9a-f-]{36})\n/.exec(rest)?.[1];
    const instruction = id ? instructions.get(id) : undefined;
    if (!instruction || !rest.startsWith(instruction)) return false;
    rest = rest.slice(instruction.length);
    if (rest.startsWith("\n\n")) { rest = rest.slice(2); if (!rest) return false; }
    else if (rest) return false;
  }
  return true;
}

export function registerWorkerEditorGuard(pi: ExtensionAPI, assignmentId: string): void {
  let server: Server | undefined;
  let context: ExtensionContext | undefined;
  let uiPromptActive = false;
  pi.on("ui_prompt_start", () => { uiPromptActive = true; });
  pi.on("ui_prompt_end", () => { uiPromptActive = false; });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx; uiPromptActive = false;
    const path = socketPath(assignmentId);
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
        try {
          const request = JSON.parse(input.slice(0, end));
          const manifest = readRoutingManifest(process.env.PI_ROUTING_MANIFEST);
          const task = manifest?.tasks.find((task) => task.assignmentId === assignmentId && task.handle === request.handle);
          if (!context?.hasUI || !task || task.messageToken !== request.token || task.paneId !== request.paneId || task.paneId !== process.env.HERDR_PANE_ID ||
            task.terminalId !== request.terminalId || task.sessionId !== context.sessionManager.getSessionId() || task.sessionId !== request.sessionId ||
            task.parentSessionId !== request.parentSessionId || manifest?.parentSessionId !== request.parentSessionId || request.assignmentId !== assignmentId ||
            !Array.isArray(request.instructions) || request.instructions.length > 32) throw new Error("Worker editor identity is unverified");
          if (uiPromptActive) throw new Error("Worker is waiting on a UI prompt; interact with its pane instead of pasting a direction");
          if (request.requireIdle && !context.isIdle()) throw new Error("Worker has not reached its idle boundary");
          const editor = context.ui.getEditorText();
          if (editor && request.clearOwned === true) {
            const instructions = new Map<string, string>();
            for (const id of request.instructions) {
              const saved = JSON.parse(readFileSync(join(assignmentDirectory(id), "instruction.json"), "utf8"));
              if (saved.assignmentId !== assignmentId || saved.requestId !== id || typeof saved.text !== "string") throw new Error("Queued instruction identity is unverified");
              instructions.set(id, saved.text);
            }
            if (!isOwnedRestoredDraft(editor, instructions)) throw new Error("Worker editor contains an unowned draft; it was preserved");
            context.ui.setEditorText("");
          } else if (editor) throw new Error("Worker editor is not empty; its draft was preserved");
          socket.end(`${JSON.stringify({ empty: true })}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); }
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, () => { server!.off("error", reject); resolve(); }); });
    chmodSync(path, 0o600);
  });
  pi.on("session_shutdown", () => { context = undefined; server?.close(); rmSync(socketPath(assignmentId), { force: true }); });
}

export function ensureWorkerEditor(task: TaskHandle, clearOwned = false, requireIdle = false): Promise<void> {
  if (!task.assignmentId || !task.messageToken || !task.sessionId || !task.terminalId) return Promise.reject(new Error("Worker editor control identity is incomplete"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(task.assignmentId!));
    let reply = "";
    const timer = setTimeout(() => socket.destroy(new Error("Worker editor acknowledgement timed out")), 5000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ assignmentId: task.assignmentId, handle: task.handle, token: task.messageToken,
      parentSessionId: task.parentSessionId, paneId: task.paneId, terminalId: task.terminalId, sessionId: task.sessionId,
      instructions: task.instructionIds ?? [], clearOwned, requireIdle })}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; if (reply.length > 16384) socket.destroy(new Error("Invalid worker editor response")); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      try { const result = JSON.parse(reply); if (result.empty !== true) throw new Error(result.error ?? "Worker editor state is unverified"); resolve(); }
      catch (error) { reject(error); }
    });
  });
}
