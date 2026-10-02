import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaValidator } from "../src/protocol.ts";

test("server-authored regex, reference and combinator schemas are rejected before main-loop validation", () => {
  for (const keyword of ["pattern", "patternProperties", "format", "$ref", "allOf", "uniqueItems"]) {
    assert.throws(() => schemaValidator({ type: "string", [keyword]: keyword === "pattern" ? "^(a+)+$" : "unsupported" }), /Unsupported reference schema/);
  }
  assert.throws(() => schemaValidator({ type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } }), /Unsupported reference schema/);
  assert.throws(() => schemaValidator(Object.assign(Object.create({ pattern: "^(a+)+$" }), { type: "string" })), /plain schema object/);
});

test("bounded reference profile validates data without executing schema property names", () => {
  const valid = schemaValidator({ type: "object", properties: { pattern: { type: "string", minLength: 1 }, state: { type: "string", enum: ["complete"] } }, required: ["pattern", "state"], additionalProperties: false });
  assert.equal(valid({ pattern: "this field name is data", state: "complete" }), true);
  assert.equal(valid({ pattern: "", state: "complete" }), false);
  assert.equal(valid({ pattern: "safe", state: "unknown" }), false);
  assert.throws(() => schemaValidator({ type: "string", enum: Array.from({ length: 33 }, (_, i) => String(i)) }), /Unsupported reference schema/);
  assert.throws(() => schemaValidator({ type: "object", properties: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), { type: "string" }])) }), /64 nodes/);
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 8; i++) deep = { type: "object", properties: { value: deep } };
  assert.throws(() => schemaValidator(deep), /8 levels/);
});
