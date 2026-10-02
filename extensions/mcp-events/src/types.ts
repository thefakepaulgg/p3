export type Cursor = string | null;

export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: Cursor;
}

export interface SubscriptionIdentity {
  endpoint: string;
  name: string;
  arguments: Record<string, unknown>;
  sessionId: string;
}

export type StreamNotice =
  | { kind: "active"; cursor: Cursor; truncated: boolean }
  | { kind: "heartbeat"; cursor: Cursor }
  | { kind: "event"; event: EventOccurrence }
  | { kind: "error" | "terminated"; error: { code: number; message: string; data?: Record<string, unknown> } };
