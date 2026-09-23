import { describe, expect, test } from "bun:test";
import { classifyDelegation, classifyModelRoute, planFallback, routes } from "./policy.ts";

describe("Sol/Luna routing policy", () => {
  const cases: Array<[string, "sol" | "luna"]> = [
    ["Design an architecture and implementation plan", "sol"],
    ["Implement a difficult cross-cutting migration", "sol"],
    ["Execute this accepted plan through parallel agents", "sol"],
    ["Make an ambiguous high-risk production decision", "sol"],
    ["Find where UserService is defined and list callers", "luna"],
    ["Rename the field and verify via the build", "luna"],
    ["Add tests mirroring the existing EvaluationServiceTests", "sol"],
    ["Animate graph layout transitions; record evidence under docs/evidence and verify with the build", "sol"],
    ["Re-run the checks and list any failing callers", "luna"],
    ["Do this ordinary routed task", "sol"],
  ];

  for (const [task, route] of cases) test(task, () => {
    const decision = classifyDelegation(task);
    expect(decision.target).toBe(route);
    expect(classifyModelRoute(task, decision)).toBe(route);
  });

  test("keeps consequential work primary but delegates accepted parallel plan steps to Sol", () => {
    expect(classifyDelegation("Make an ambiguous high-risk production decision").delegate).toBe(false);
    expect(classifyDelegation("Execute this accepted plan through parallel agents").delegate).toBe(true);
  });

  test("explicit implement phase never routes to Luna", () => expect(classifyDelegation("Find and list callers", "implement").target).toBe("sol"));

  test("exposes only routed Sol and Luna models", () => expect(Object.keys(routes)).toEqual(["sol", "luna"]));
});

describe("fallback policy", () => {
  test("implicit Luna falls back visibly to Sol", () => {
    expect(planFallback("luna", false, route => route === "sol")).toEqual({ route: "sol", fallbackFrom: "luna" });
  });

  test("explicit route never falls back", () => {
    expect(planFallback("luna", true, route => route === "sol")).toEqual({ error: "Explicit route luna is unavailable; no fallback was applied" });
  });

  test("exhaustion reports tried routes", () => {
    const result = planFallback("sol", false, () => false);
    expect("error" in result && result.error).toContain("Tried: sol");
  });
});
