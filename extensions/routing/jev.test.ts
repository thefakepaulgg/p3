import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyWithJev } from "./jev.ts";
import { classifyDelegation } from "./policy.ts";

describe("Jev routing", () => {
  test("without native TypeSafe credentials, keeps the local decision", async () => {
    const local = classifyDelegation("List callers of UserService", "other");
    const ctx = { modelRegistry: { getAvailableOfType: async () => [] } } as unknown as ExtensionContext;
    expect(await classifyWithJev("List callers of UserService", "other", local, ctx)).toBe(local);
  });

});
