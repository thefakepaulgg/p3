import { afterEach, expect, mock, test } from "bun:test";
import { createClaudeConnectorsExtension, createMcpRuntimeLoader } from "./claude-connectors.ts";

const credentials = {
  accessToken: "test-token",
  expiresAt: Date.now() + 60_000,
  scopes: ["user:mcp_servers"],
};

class FakeClient {
  constructor(_info: unknown) {}
  async connect(_transport: unknown, _options?: unknown) {}
  async listTools() {
    return { tools: [{ name: "test_tool", description: "A test tool", annotations: { readOnlyHint: true } }] };
  }
  async close() {}
}

class FakeTransport {
  constructor(_endpoint: unknown, _options: unknown) {}
}

const runtime = {
  Client: FakeClient as any,
  StreamableHTTPClientTransport: FakeTransport as any,
};

const setup = (runtimeLoader: () => Promise<any>) => {
  const tools: any[] = [];
  createClaudeConnectorsExtension({
    readCredentials: async () => credentials,
    loadMcpRuntime: runtimeLoader,
  })({ registerTool: (tool: any) => tools.push(tool) } as any);
  return tools[0];
};

const catalogResponse = () => new Response(JSON.stringify({
  data: [{ id: "connector-id", display_name: "Test connector", url: "https://example.test/mcp", tools: [{ name: "test_tool" }] }],
}));

let previousFetch: typeof fetch;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  previousFetch = undefined as unknown as typeof fetch;
});

test("list_connectors does not load the MCP runtime", async () => {
  let runtimeLoads = 0;
  previousFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => catalogResponse()) as unknown as typeof fetch;
  const tool = setup(async () => {
    runtimeLoads++;
    return runtime;
  });

  const result = await tool.execute("1", { action: "list_connectors" });

  expect(result.isError).toBeUndefined();
  expect(runtimeLoads).toBe(0);
});

test("concurrent MCP calls share one runtime load", async () => {
  let runtimeLoads = 0;
  previousFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => catalogResponse()) as unknown as typeof fetch;
  const loadRuntime = createMcpRuntimeLoader(async () => {
    runtimeLoads++;
    await Promise.resolve();
    return runtime;
  });
  const tool = setup(loadRuntime);

  const results = await Promise.all([
    tool.execute("1", { action: "list_tools", connector: "Test connector" }),
    tool.execute("2", { action: "list_tools", connector: "Test connector" }),
  ]);

  expect(results.every((result: any) => !result.isError)).toBe(true);
  expect(runtimeLoads).toBe(1);
});

test("a failed runtime load can be retried", async () => {
  let runtimeLoads = 0;
  previousFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => catalogResponse()) as unknown as typeof fetch;
  const loadRuntime = createMcpRuntimeLoader(async () => {
    runtimeLoads++;
    if (runtimeLoads === 1) throw new Error("temporary import failure");
    return runtime;
  });
  const tool = setup(loadRuntime);

  const failed = await tool.execute("1", { action: "list_tools", connector: "Test connector" });
  const retried = await tool.execute("2", { action: "list_tools", connector: "Test connector" });

  expect(failed.isError).toBe(true);
  expect(retried.isError).toBeUndefined();
  expect(runtimeLoads).toBe(2);
});
