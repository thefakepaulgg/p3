import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Herdr's terminal ID identifies the live terminal behind a pane without tying links to a Pi session restart.
export interface PeerIdentity { pane: string; terminal: string }
interface ChildLink { child: PeerIdentity; parent: PeerIdentity }
interface SiblingLink { children: [PeerIdentity, PeerIdentity]; parent: PeerIdentity; task: string }

const root = join(tmpdir(), `pi-peer-links-${process.getuid?.() ?? "local"}`);
const key = (pane: string) => createHash("sha256").update(pane).digest("hex");
const childPath = (pane: string) => join(root, `child-${key(pane)}.json`);
const edgePath = (a: string, b: string) => join(root, `edge-${[key(a), key(b)].sort().join("-")}.json`);
const same = (a: PeerIdentity, b: PeerIdentity) => a.pane === b.pane && a.terminal === b.terminal;
const read = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};
const write = (path: string, value: unknown) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
};

export function recordChild(parent: PeerIdentity, child: PeerIdentity): void {
  write(childPath(child.pane), { parent, child } satisfies ChildLink);
}

export function childOf(parent: PeerIdentity, child: PeerIdentity): boolean {
  const link = read<ChildLink>(childPath(child.pane));
  return !!link && same(link.parent, parent) && same(link.child, child);
}

export function connectSiblings(parent: PeerIdentity, first: PeerIdentity, second: PeerIdentity, task: string): void {
  if (first.pane === second.pane || !childOf(parent, first) || !childOf(parent, second)) {
    throw new Error("Both peers must be live children launched by this primary");
  }
  write(edgePath(first.pane, second.pane), { parent, children: [first, second], task } satisfies SiblingLink);
}

export function disconnectSiblings(parent: PeerIdentity, first: PeerIdentity, second: PeerIdentity): void {
  if (!childOf(parent, first) || !childOf(parent, second)) throw new Error("Both peers must be live children launched by this primary");
  rmSync(edgePath(first.pane, second.pane), { force: true });
}

export function canMessage(sender: PeerIdentity, recipient: PeerIdentity): boolean {
  if (childOf(sender, recipient) || childOf(recipient, sender)) return true;
  const edge = read<SiblingLink>(edgePath(sender.pane, recipient.pane));
  return !!edge && edge.task.trim().length > 0 &&
    edge.children.some((child) => same(child, sender)) && edge.children.some((child) => same(child, recipient)) &&
    childOf(edge.parent, sender) && childOf(edge.parent, recipient);
}

export const peerIdentity = (agent: any, pane: string): PeerIdentity => {
  if (agent?.pane_id !== pane || agent?.agent !== "pi" || typeof agent?.terminal_id !== "string" || !agent.terminal_id) {
    throw new Error(`No live Pi agent identity for pane ${pane}`);
  }
  return { pane, terminal: agent.terminal_id };
};
