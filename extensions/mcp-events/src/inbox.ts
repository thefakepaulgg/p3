import { randomUUID } from "node:crypto";
import { open, rename, rm, mkdir } from "node:fs/promises";
import { z } from "zod";
import { occurrenceSchema } from "./protocol.ts";
import { join } from "node:path";
import type { Cursor, EventOccurrence, SubscriptionIdentity } from "./types.ts";

export class InboxFullError extends Error {
  constructor() { super("Durable inbox capacity exceeded; intake must pause without checkpointing"); this.name = "InboxFullError"; }
}

export interface InboxLimits { maxEvents?: number; maxBytes?: number; maxDedup?: number }
export interface PendingEvent { event: EventOccurrence; receipt?: string }
export interface InboxSnapshot {
  identity: SubscriptionIdentity;
  cursor: Cursor;
  pending: PendingEvent[];
  dedup: string[];
  duplicates: number;
  gaps: number;
}
export interface InboxBatch { id: string; events: EventOccurrence[] }

const defaults = { maxEvents: 256, maxBytes: 1_048_576, maxDedup: 1024 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** One inbox directory per subscription identity. A leftover lock requires explicit operator cleanup
 * after verifying the owning process has died; automatic PID recovery risks PID reuse. */
export class DurableInbox {
  private state: InboxSnapshot;
  private readonly limits: Required<InboxLimits>;
  private readonly directory: string;
  private readonly lockPath: string;
  private closed = false;
  private failed = false;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(directory: string, state: InboxSnapshot, limits: Required<InboxLimits>) {
    this.directory = directory;
    this.lockPath = join(directory, "owner.lock");
    this.state = state;
    this.limits = limits;
  }

  static async open(directory: string, identity: SubscriptionIdentity, limits: InboxLimits = {}): Promise<DurableInbox> {
    const bounds = { ...defaults, ...limits };
    if (Object.values(bounds).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("Inbox limits must be positive integers");
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, "owner.lock");
    const lock = await open(lockPath, "wx", 0o600);
    try {
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      await lock.close();
      const source = await open(join(directory, "snapshot.json"), "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      let disk: string | undefined;
      if (source) {
        try {
          const info = await source.stat();
          if (!info.isFile() || info.size > bounds.maxBytes) throw new InboxFullError();
          // One extra byte detects growth past the bound, without trusting a stale stat size.
          const buffer = Buffer.alloc(bounds.maxBytes + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await source.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length > bounds.maxBytes) throw new InboxFullError();
          disk = buffer.subarray(0, length).toString("utf8");
        } finally { await source.close(); }
      }
      let state: InboxSnapshot;
      if (disk !== undefined) {
        const schema = z.object({
          identity: z.object({ endpoint: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()), sessionId: z.string() }).strict(),
          cursor: z.string().max(4096).nullable(),
          pending: z.array(z.object({ event: occurrenceSchema, receipt: z.uuid().optional() }).strict()).max(bounds.maxEvents),
          dedup: z.array(z.string().min(1).max(512)).max(bounds.maxDedup),
          duplicates: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          gaps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }).strict();
        try {
          state = schema.parse(JSON.parse(disk));
          if (new Set(state.pending.map(p => p.event.eventId)).size !== state.pending.length ||
              new Set(state.pending.flatMap(p => p.receipt ? [p.receipt] : [])).size > 1) throw new Error("Invalid reservation");
        } catch { throw new Error("Invalid durable inbox snapshot"); }
      } else state = { identity: clone(identity), cursor: null, pending: [], dedup: [], duplicates: 0, gaps: 0 };
      if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error("Inbox subscription identity mismatch");
      if (state.pending.length > bounds.maxEvents || state.dedup.length > bounds.maxDedup || bytes(state) > bounds.maxBytes) throw new InboxFullError();
      const inbox = new DurableInbox(directory, state, bounds);
      if (!disk) await inbox.commit(state);
      return inbox;
    } catch (error) {
      await lock.close().catch(() => {});
      await rm(lockPath, { force: true });
      throw error;
    }
  }

  get snapshot(): InboxSnapshot { return clone(this.state); }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => {
      if (this.closed || this.failed) throw new Error("Inbox closed or storage durability uncertain");
      return operation();
    });
    this.chain = result.catch(() => {});
    return result;
  }

  private async commit(next: InboxSnapshot): Promise<void> {
    if (next.pending.length > this.limits.maxEvents || next.dedup.length > this.limits.maxDedup || bytes(next) > this.limits.maxBytes) throw new InboxFullError();
    const temp = join(this.directory, `.snapshot-${randomUUID()}`);
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, join(this.directory, "snapshot.json"));
      this.state = next;
      const dir = await open(this.directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally { await rm(temp, { force: true }); }
  }

  accept(event: EventOccurrence): Promise<boolean> {
    return this.serialized(async () => {
      const next = clone(this.state);
      if (next.dedup.includes(event.eventId) || next.pending.some(p => p.event.eventId === event.eventId)) {
        next.duplicates++;
        await this.commit(next);
        return false;
      }
      next.pending.push({ event: clone(event) });
      next.dedup.push(event.eventId);
      if (next.dedup.length > this.limits.maxDedup) {
        const removable = next.dedup.findIndex(id => !next.pending.some(p => p.event.eventId === id));
        if (removable < 0) throw new InboxFullError();
        next.dedup.splice(removable, 1);
      }
      if (event.cursor !== undefined) next.cursor = event.cursor;
      await this.commit(next);
      return true;
    });
  }

  checkpoint(cursor: Cursor, options: { truncated?: boolean } = {}): Promise<void> {
    return this.serialized(async () => {
      const next = clone(this.state);
      next.cursor = cursor;
      if (options.truncated) next.gaps++;
      await this.commit(next);
    });
  }

  /** Reserves one bounded batch durably. Repeated calls return its same correlation ID until recorded. */
  takeBatch(maxEvents: number, maxBytes: number): Promise<InboxBatch | undefined> {
    return this.serialized(async () => {
      if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Batch limits must be positive integers");
      const next = clone(this.state);
      const receipt = next.pending.find(p => p.receipt)?.receipt;
      if (receipt) {
        const events = next.pending.filter(p => p.receipt === receipt).map(p => p.event);
        if (events.length > maxEvents || events.reduce((size, event) => size + bytes(event), 0) > maxBytes) throw new InboxFullError();
        return { id: receipt, events };
      }
      const chosen: PendingEvent[] = [];
      let size = 0;
      for (const pending of next.pending) {
        const eventBytes = bytes(pending.event);
        if (chosen.length >= maxEvents || size + eventBytes > maxBytes) break;
        chosen.push(pending);
        size += eventBytes;
      }
      if (!chosen.length) {
        if (next.pending.length) throw new InboxFullError();
        return undefined;
      }
      const id = randomUUID();
      for (const pending of chosen) pending.receipt = id;
      await this.commit(next);
      return { id, events: chosen.map(p => p.event) };
    });
  }

  /** Only a verified transcript receipt should call record. Event IDs must match the reserved batch. */
  record(batchId: string, eventIds: string[]): Promise<void> {
    return this.serialized(async () => {
      const next = clone(this.state);
      const matching = next.pending.filter(p => p.receipt === batchId);
      if (!matching.length || JSON.stringify(matching.map(p => p.event.eventId)) !== JSON.stringify(eventIds)) throw new Error("Receipt does not match pending batch");
      next.pending = next.pending.filter(p => p.receipt !== batchId);
      await this.commit(next);
    });
  }

  async close(): Promise<void> {
    await this.chain;
    if (this.closed) return;
    this.closed = true;
    await rm(this.lockPath);
  }
}
