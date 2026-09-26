import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PeerMessage { id: string; senderPane: string; text: string; supersedes?: string }
export type PeerMessageState = "queued" | "delivered" | "acknowledged" | "superseded";
export type PeerRequest = { type: "message"; message: PeerMessage } | { type: "status"; id: string; senderPane: string };
const LIMIT = 8192;

export const peerInboxPath = (paneId: string) => join(tmpdir(), `pi-peer-${process.getuid?.() ?? "local"}-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}.sock`);

export async function startPeerInbox(
  path: string,
  receive: (message: PeerMessage) => Promise<void>,
  status: (id: string, senderPane: string) => PeerMessageState | undefined,
): Promise<Server> {
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
        const request = JSON.parse(input.slice(0, end)) as PeerRequest;
        if (request.type === "status") {
          socket.end(`${JSON.stringify({ state: status(request.id, request.senderPane) ?? "unknown" })}\n`);
        } else if (request.type === "message") {
          void receive(request.message).then(() => socket.end("ok\n"), (error) => socket.end(`error: ${String(error)}\n`));
        } else socket.end("error: invalid request\n");
      } catch { socket.end("error: invalid request\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  return server;
}

function requestPeer(path: string, request: PeerRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => socket.destroy(new Error("Peer message timed out")), 10000);
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      const text = reply.trim();
      if (text.startsWith("error:") || !text) reject(new Error(text || "Peer inbox did not respond"));
      else resolve(text);
    });
  });
}

export async function sendPeerMessage(path: string, message: PeerMessage): Promise<void> {
  const reply = await requestPeer(path, { type: "message", message });
  if (reply !== "ok") throw new Error(`Unexpected peer inbox reply: ${reply}`);
}

export async function peerMessageStatus(path: string, id: string, senderPane: string): Promise<PeerMessageState | "unknown"> {
  const reply = JSON.parse(await requestPeer(path, { type: "status", id, senderPane })) as { state: PeerMessageState | "unknown" };
  return reply.state;
}
