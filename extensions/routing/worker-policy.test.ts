import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { READONLY_WORKER_TOOLS, workerPolicyArgs, registerReadonlyWorkerPolicy } from "./worker-policy.ts";

describe("READONLY_WORKER_TOOLS", () => {
  test("contains the expected read-only tools", () => {
    expect(READONLY_WORKER_TOOLS).toEqual(["read", "ls", "find", "grep", "message_parent"]);
  });

  test("is frozen / readonly at runtime", () => {
    expect(() => (READONLY_WORKER_TOOLS as string[]).push("bash")).toThrow();
  });
});

describe("workerPolicyArgs", () => {
  test("returns empty array when readonly is false", () => {
    expect(workerPolicyArgs(false)).toEqual([]);
  });

  test("returns empty array when readonly is undefined", () => {
    expect(workerPolicyArgs()).toEqual([]);
  });

  test("returns --tools allowlist and --exclude-tools mcp__* when readonly", () => {
    const args = workerPolicyArgs(true);
    expect(args).toContain("--tools");
    expect(args).toContain(READONLY_WORKER_TOOLS.join(","));
    expect(args).toContain("--exclude-tools");
    expect(args).toContain("mcp__*");
  });

  test("does not include --no-extensions", () => {
    const args = workerPolicyArgs(true);
    expect(args).not.toContain("--no-extensions");
  });

  test("disables native MCP", () => {
    const args = workerPolicyArgs(true);
    expect(args).toContain("--no-mcp");
  });
});

describe("registerReadonlyWorkerPolicy", () => {
  const savedEnv = process.env.PI_ROUTED_READONLY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PI_ROUTED_READONLY;
    else process.env.PI_ROUTED_READONLY = savedEnv;
  });

  test("is a no-op when PI_ROUTED_READONLY is not set", () => {
    delete process.env.PI_ROUTED_READONLY;
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on: (event: string, handler: Function) => {
        (handlers[event] ??= []).push(handler);
        return () => {};
      },
    };
    registerReadonlyWorkerPolicy(mockPi as any);
    expect(handlers["tool_call"]).toBeUndefined();
    expect(handlers["session_start"]).toBeUndefined();
  });

  test("registers handlers when PI_ROUTED_READONLY=1", () => {
    process.env.PI_ROUTED_READONLY = "1";
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on: (event: string, handler: Function) => {
        (handlers[event] ??= []).push(handler);
        return () => {};
      },
    };
    registerReadonlyWorkerPolicy(mockPi as any);
    expect(handlers["tool_call"]).toHaveLength(1);
    expect(handlers["session_start"]).toHaveLength(1);
  });

  test("tool_call handler blocks disallowed tools after activation", async () => {
    process.env.PI_ROUTED_READONLY = "1";
    let toolCallHandler: Function | undefined;
    let sessionStartHandler: Function | undefined;
    const mockPi = {
      on: (event: string, handler: Function) => {
        if (event === "tool_call") toolCallHandler = handler;
        if (event === "session_start") sessionStartHandler = handler;
        return () => {};
      },
    };
    registerReadonlyWorkerPolicy(mockPi as any);

    // Before session_start, should not block
    const preResult = await toolCallHandler!({ toolName: "bash", toolCallId: "1" });
    expect(preResult).toBeUndefined();

    // Activate
    sessionStartHandler!({}, {});

    // After activation, allowed tools pass through
    for (const tool of READONLY_WORKER_TOOLS) {
      const result = await toolCallHandler!({ toolName: tool, toolCallId: "2" });
      expect(result).toBeUndefined();
    }

    // Disallowed tools are blocked
    const blocked = await toolCallHandler!({ toolName: "bash", toolCallId: "3" });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("Read-only worker policy");
    expect(blocked.reason).toContain("bash");

    const blocked2 = await toolCallHandler!({ toolName: "write", toolCallId: "4" });
    expect(blocked2).toEqual(expect.objectContaining({ block: true }));

    const blocked3 = await toolCallHandler!({ toolName: "edit", toolCallId: "5" });
    expect(blocked3).toEqual(expect.objectContaining({ block: true }));
  });

  test("is a no-op when PI_ROUTED_READONLY=0", () => {
    process.env.PI_ROUTED_READONLY = "0";
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on: (event: string, handler: Function) => {
        (handlers[event] ??= []).push(handler);
        return () => {};
      },
    };
    registerReadonlyWorkerPolicy(mockPi as any);
    expect(handlers["tool_call"]).toBeUndefined();
  });
});
