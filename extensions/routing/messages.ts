import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ParentMessage { handle: string; paneId: string; token: string; text: string }
const LIMIT = 8192;

export const inboxPath = (sessionId: string) => join(tmpdir(), `pi-parent-${process.getuid?.() ?? "local"}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}.sock`);

export async function startParentInbox(path: string, receive: (message: ParentMessage) => boolean): Promise<Server> {
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > LIMIT) { socket.end("error: message too long\n"); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(input.slice(0, end)) as ParentMessage;
        socket.end(receive(message) ? "ok\n" : "error: unknown subagent\n");
      } catch { socket.end("error: invalid message\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export function sendParentMessage(path: string, message: ParentMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => socket.destroy(new Error("Parent message timed out")), 5000);
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      if (reply.trim() === "ok") resolve(); else reject(new Error(reply.trim() || "Parent message was not acknowledged"));
    });
  });
}
