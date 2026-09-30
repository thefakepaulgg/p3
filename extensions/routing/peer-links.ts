import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Herdr's terminal ID identifies the live terminal behind a pane without tying links to a Pi session restart.
export interface PeerIdentity { pane: string; terminal: string }
interface ChildLink { child: PeerIdentity; parent: PeerIdentity }
interface SiblingLink { kind?: "sibling"; children: [PeerIdentity, PeerIdentity]; parent: PeerIdentity; task: string }
interface UserLink { kind: "user-directed"; children: [PeerIdentity, PeerIdentity]; task: string }
type Edge = SiblingLink | UserLink;

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
  const path = edgePath(first.pane, second.pane);
  if (read<Edge>(path)?.kind === "user-directed") throw new Error("This connection is user-directed; an endpoint must disconnect it first");
  write(path, { kind: "sibling", parent, children: [first, second], task } satisfies SiblingLink);
}

export function disconnectSiblings(parent: PeerIdentity, first: PeerIdentity, second: PeerIdentity): void {
  if (!childOf(parent, first) || !childOf(parent, second)) throw new Error("Both peers must be live children launched by this primary");
  const path = edgePath(first.pane, second.pane);
  if (read<Edge>(path)?.kind === "user-directed") throw new Error("This connection is user-directed; an endpoint must disconnect it first");
  rmSync(path, { force: true });
}

export function connectUserDirected(caller: PeerIdentity, other: PeerIdentity, task: string): void {
  if (caller.pane === other.pane) throw new Error("Cannot connect an agent to itself");
  const path = edgePath(caller.pane, other.pane);
  const existing = read<Edge>(path);
  if (existing && existing.kind !== "user-directed") throw new Error("This connection is managed by the common launching primary");
  write(path, { kind: "user-directed", children: [caller, other], task } satisfies UserLink);
}

export function disconnectUserDirected(caller: PeerIdentity, other: PeerIdentity): void {
  const path = edgePath(caller.pane, other.pane);
  const edge = read<Edge>(path);
  if (edge?.kind !== "user-directed" || !edge.children.some((child) => same(child, caller)) ||
    !edge.children.some((child) => same(child, other))) throw new Error("No live user-directed connection for these agents");
  rmSync(path);
}

export function canMessage(sender: PeerIdentity, recipient: PeerIdentity): boolean {
  if (childOf(sender, recipient) || childOf(recipient, sender)) return true;
  const edge = read<Edge>(edgePath(sender.pane, recipient.pane));
  if (!edge || typeof edge.task !== "string" || !edge.task.trim() ||
    !edge.children?.some((child) => same(child, sender)) || !edge.children.some((child) => same(child, recipient))) return false;
  if (edge.kind === "user-directed") return true;
  return (edge.kind === undefined || edge.kind === "sibling") &&
    childOf(edge.parent, sender) && childOf(edge.parent, recipient);
}

export const peerIdentity = (agent: any, pane: string): PeerIdentity => {
  if (agent?.pane_id !== pane || agent?.agent !== "pi" || typeof agent?.terminal_id !== "string" || !agent.terminal_id) {
    throw new Error(`No live Pi agent identity for pane ${pane}`);
  }
  return { pane, terminal: agent.terminal_id };
};
