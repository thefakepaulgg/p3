import { z } from "zod";
import { Ajv } from "ajv";
import type { StreamNotice } from "./types.ts";

export const BASE_REVISION = "2026-07-28";
export const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const object = z.record(z.string(), z.unknown());
const cursor = z.string().max(4096).nullable();
export const definitionSchema = z.object({
  name: z.string().min(1).max(256), description: z.string().max(8192).optional(),
  delivery: z.array(z.enum(["push", "poll", "webhook"])).min(1),
  inputSchema: object, payloadSchema: object,
});
export type EventDefinition = z.infer<typeof definitionSchema>;
export const discoverySchema = z.object({
  supportedVersions: z.array(z.string()),
  capabilities: z.object({ events: z.object({ listChanged: z.boolean().optional() }) }).passthrough(),
}).passthrough();
export const catalogSchema = z.object({ events: z.array(definitionSchema).max(128), nextCursor: z.string().max(4096).optional() });
export const occurrenceSchema = z.object({
  eventId: z.string().min(1).max(512), name: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }), data: object, cursor: cursor.optional(),
});
const errorSchema = z.object({ code: z.number().int(), message: z.string().max(8192), data: object.optional() });
const noticeSchemas = {
  active: z.object({ cursor, truncated: z.boolean().optional().default(false) }),
  heartbeat: z.object({ cursor }), event: occurrenceSchema,
  error: z.object({ error: errorSchema }), terminated: z.object({ error: errorSchema }),
};

export class ContractError extends Error {}
export function parseNotice(method: string, params: unknown): StreamNotice {
  const kind = method.slice("notifications/events/".length) as keyof typeof noticeSchemas;
  const schema = noticeSchemas[kind];
  if (!schema) throw new ContractError("Unknown Events stream notification");
  const result = schema.safeParse(params);
  if (!result.success) throw new ContractError(`Invalid ${kind} notification`);
  return kind === "event" ? { kind, event: result.data as z.infer<typeof occurrenceSchema> } : { kind, ...result.data } as StreamNotice;
}

const referenceKeywords = new Set(["type", "properties", "required", "additionalProperties", "enum", "minLength", "maxLength", "minimum", "maximum", "title", "description"]);

// Bound both compilation and validation work; endpoint-authored regexes and refs must never run on Pi's event loop.
function admitReferenceSchema(schema: Record<string, unknown>) {
  let nodes = 0;
  const reject = (reason: string): never => { throw new ContractError(`Unsupported reference schema: ${reason}`); };
  const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
  function visit(value: unknown, depth: number): void {
    if (++nodes > 64 || depth > 8) reject("limit of 64 nodes / 8 levels exceeded");
    if (typeof value === "boolean") return;
    if (!plainObject(value)) reject("expected a plain schema object or boolean");
    const node = value as Record<string, unknown>;
    for (const keyword of Object.keys(node)) if (!referenceKeywords.has(keyword)) reject("keyword outside the reference profile");
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length > 32 || node.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item)))) reject("enum must contain at most 32 scalars");
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 64 || node.required.some(item => typeof item !== "string" || item.length > 512))) reject("required must contain at most 64 bounded names");
    if (node.properties !== undefined) {
      if (!plainObject(node.properties)) reject("properties must be a plain object");
      for (const child of Object.values(node.properties as Record<string, unknown>)) visit(child, depth + 1);
    }
    if (node.additionalProperties !== undefined) visit(node.additionalProperties, depth + 1);
  }
  visit(schema, 1);
}

export function schemaValidator(schema: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 32 * 1024) throw new ContractError("Schema too large");
  admitReferenceSchema(schema);
  try {
    const ajv = new Ajv({ strict: true, allErrors: false });
    return ajv.compile(schema);
  } catch { throw new ContractError("Unsupported or invalid JSON schema"); }
}
