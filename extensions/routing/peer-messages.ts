import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PeerMessage { senderPane: string; text: string }
const LIMIT = 8192;

export const peerInboxPath = (paneId: string) => join(tmpdir(), `pi-peer-${process.getuid?.() ?? "local"}-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}.sock`);

export async function startPeerInbox(path: string, receive: (message: PeerMessage) => Promise<void>): Promise<Server> {
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > LIMIT) { socket.end("error: message too long\n"); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      try {
        const message = JSON.parse(input.slice(0, end)) as PeerMessage;
        void receive(message).then(() => socket.end("ok\n"), (error) => socket.end(`error: ${String(error)}\n`));
      } catch { socket.end("error: invalid message\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export function sendPeerMessage(path: string, message: PeerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => socket.destroy(new Error("Peer message timed out")), 10000);
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      if (reply.trim() === "ok") resolve(); else reject(new Error(reply.trim() || "Peer message was not acknowledged"));
    });
  });
}
