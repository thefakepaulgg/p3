import { describe, expect, test } from "bun:test";
import { classifyWithJev } from "./jev.ts";
import { classifyDelegation } from "./policy.ts";

describe("Jev routing", () => {
  test("without a TypeSafe key, keeps the local decision", async () => {
    const local = classifyDelegation("List callers of UserService", "other");
    expect(await classifyWithJev("List callers of UserService", "other", local, undefined)).toBe(local);
  });

  test("never asks Jev about implementation", async () => {
    const local = classifyDelegation("Fix the parser", "implement");
    expect(await classifyWithJev("Fix the parser", "implement", local, "unused-key")).toBe(local);
  });
});
