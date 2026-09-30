import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StringEnum, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { formatSize, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  completeConnectorLogin,
  connectorAuthMode,
  connectorAuthStatusText,
  logoutConnectors,
  selectedConnectorCredentials,
  setConnectorAuthMode,
  startConnectorLogin,
  type ConnectorAuthMode,
  type ConnectorCredentials,
} from "./claude-connectors-auth.ts";

const CATALOG_URL = "https://api.anthropic.com/v1/mcp_servers?limit=1000";
const MCP_PROXY_ORIGIN = "https://mcp-proxy.anthropic.com";
const MCP_SERVERS_BETA = "mcp-servers-2025-12-04";
const MAX_INLINE_RESULT_TOKENS = 25_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const RESULT_PREVIEW_BYTES = 2 * 1024;

interface CatalogTool {
  name: string;
  effective_max_permission?: "allow" | "ask" | "blocked";
}

interface CatalogConnector {
  id: string;
  display_name: string;
  url: string;
  tools?: CatalogTool[];
}

interface CatalogResponse {
  data: CatalogConnector[];
}

type McpRuntime = {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
};

export function createMcpRuntimeLoader(
  importRuntime: () => Promise<McpRuntime> = async () => {
    const [clientModule, transportModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    return {
      Client: clientModule.Client,
      StreamableHTTPClientTransport: transportModule.StreamableHTTPClientTransport,
    };
  },
): () => Promise<McpRuntime> {
  let runtimePromise: Promise<McpRuntime> | undefined;
  return () => {
    if (!runtimePromise) {
      runtimePromise = importRuntime().catch((error) => {
        runtimePromise = undefined;
        throw error;
      });
    }
    return runtimePromise;
  };
}

const loadMcpRuntime = createMcpRuntimeLoader();

const Params = Type.Object({
  action: StringEnum(["list_connectors", "list_tools", "describe_tool", "call"] as const),
  connector: Type.Optional(Type.String({ description: "Exact connector display name from list_connectors" })),
  tool: Type.Optional(Type.String({ description: "Exact upstream tool name from list_tools" })),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments matching describe_tool's inputSchema" })),
});

function safeError(error: unknown, credentials?: ConnectorCredentials): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [credentials?.accessToken, credentials?.refreshToken]) {
    if (secret) message = message.replaceAll(secret, "<redacted>");
  }
  return message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 2_000);
}

function requireString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for this action`);
  return trimmed;
}

function connectorSummary(connector: CatalogConnector) {
  return {
    name: connector.display_name,
    toolCount: connector.tools?.length ?? 0,
  };
}

function toolSummary(tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number]) {
  return {
    name: tool.name,
    title: tool.annotations?.title,
    description: tool.description,
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resultContent(result: Awaited<ReturnType<Client["callTool"]>>): Array<TextContent | ImageContent> {
  if (!("content" in result) || !Array.isArray(result.content)) {
    return [{ type: "text" as const, text: asText("toolResult" in result ? result.toolResult : result) }];
  }

  const items = result.content as Array<{
    type: "text" | "image" | "audio" | "resource" | "resource_link";
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
  }>;
  const content: Array<TextContent | ImageContent> = [];
  for (const item of items) {
    if (item.type === "text") content.push({ type: "text", text: item.text ?? "" });
    else if (item.type === "image") content.push({ type: "image", data: item.data ?? "", mimeType: item.mimeType ?? "application/octet-stream" });
    else if (item.type === "resource" && item.resource) {
      if (item.resource.text !== undefined) content.push({ type: "text", text: `[Resource ${item.resource.uri}]\n${item.resource.text}` });
      else if (item.resource.mimeType?.startsWith("image/") && item.resource.blob) {
        content.push({ type: "image", data: item.resource.blob, mimeType: item.resource.mimeType });
      } else content.push({ type: "text", text: `[Binary resource ${item.resource.uri} (${item.resource.mimeType ?? "unknown type"}) omitted]` });
    } else if (item.type === "resource_link") {
      content.push({ type: "text", text: `[Resource link] ${item.name ?? "resource"}: ${item.uri ?? "unknown URI"}` });
    } else content.push({ type: "text", text: `[Audio result (${item.mimeType ?? "unknown type"}) omitted]` });
  }

  const structuredContent = "structuredContent" in result && typeof result.structuredContent === "object" ? result.structuredContent : undefined;
  if (content.length === 0 && structuredContent) {
    content.push({ type: "text" as const, text: asText(structuredContent) });
  }
  return content.length > 0 ? content : [{ type: "text" as const, text: "Connector returned no content." }];
}

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

async function persistLargeTextResult(content: Array<TextContent | ImageContent>) {
  if (!content.every((item): item is TextContent => item.type === "text")) return { content };

  const fullText = content.map((item) => item.text).join("\n\n");
  // Always save the exact response so callers can archive it byte-for-byte instead of
  // reproducing inline text (the work-vault Zoom pipeline depends on this).
  const tempDir = await mkdtemp(join(tmpdir(), "pi-claude-connectors-"));
  const fullOutputPath = join(tempDir, "output.txt");
  await withFileMutationQueue(fullOutputPath, async () => {
    await writeFile(fullOutputPath, fullText, { encoding: "utf8", mode: 0o600 });
  });

  const totalBytes = Buffer.byteLength(fullText, "utf8");
  if (Math.ceil(fullText.length / ESTIMATED_CHARS_PER_TOKEN) <= MAX_INLINE_RESULT_TOKENS) {
    return {
      content: [...content, { type: "text" as const, text: `[Full output saved to: ${fullOutputPath}]` }],
      fullOutputPath,
      totalBytes,
    };
  }

  const preview = utf8Prefix(fullText, RESULT_PREVIEW_BYTES);
  return {
    content: [{
      type: "text" as const,
      text: `<persisted-output>\nOutput too large (${formatSize(totalBytes)}). Full output saved to: ${fullOutputPath}\n\nPreview (first 2KB):\n${preview}\n</persisted-output>`,
    }],
    fullOutputPath,
    totalBytes,
  };
}

interface ClaudeConnectorsDependencies {
  readCredentials: () => Promise<ConnectorCredentials>;
  loadMcpRuntime: () => Promise<McpRuntime>;
}

export function createClaudeConnectorsExtension(
  overrides: Partial<ClaudeConnectorsDependencies> = {},
): (pi: ExtensionAPI) => void {
  const credentialReader = overrides.readCredentials ?? selectedConnectorCredentials;
  const runtimeLoader = overrides.loadMcpRuntime ?? loadMcpRuntime;

  return function claudeConnectorsExtension(pi: ExtensionAPI) {
  const clientSessionId = randomUUID();

  pi.registerCommand("connectors-login", {
    description: "Authorize direct access to connectors attached to your Claude account",
    handler: async (_args, ctx) => {
      const login = startConnectorLogin();
      const pasted = await ctx.ui.input(
        `Open this URL in your browser:\n\n${login.url}\n\nThen paste the CODE#STATE value:`,
        "CODE#STATE",
      );
      if (!pasted?.trim()) {
        ctx.ui.notify("Connector login cancelled", "warning");
        return;
      }
      try {
        await completeConnectorLogin(login, pasted);
        ctx.ui.notify("Claude connectors authorized directly for Pi", "info");
      } catch (error) {
        ctx.ui.notify(`Connector login failed: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("connectors-mode", {
    description: "Select direct or Claude Code credential-file auth for connector proxy calls",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        ctx.ui.notify(`Connector auth mode: ${await connectorAuthMode()}`, "info");
        return;
      }
      if (requested !== "direct" && requested !== "claude-code") {
        ctx.ui.notify("Usage: /connectors-mode direct|claude-code", "error");
        return;
      }
      await setConnectorAuthMode(requested as ConnectorAuthMode);
      ctx.ui.notify(`Connector auth mode set to ${requested}`, "info");
    },
  });

  pi.registerCommand("connectors-status", {
    description: "Show connector auth mode and credential status",
    handler: async (_args, ctx) => ctx.ui.notify(await connectorAuthStatusText(), "info"),
  });

  pi.registerCommand("connectors-logout", {
    description: "Delete Pi's direct Claude connector credentials",
    handler: async (_args, ctx) => {
      await logoutConnectors();
      ctx.ui.notify("Direct Claude connector credentials removed", "info");
    },
  });
  let cachedCatalog: CatalogConnector[] | undefined;
  let cachedCatalogExpiry = 0;

  const getCatalog = async (credentials: ConnectorCredentials, refresh = false) => {
    if (!refresh && cachedCatalog && cachedCatalogExpiry > Date.now()) return cachedCatalog;
    const response = await fetch(CATALOG_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": MCP_SERVERS_BETA,
      },
    });
    if (!response.ok) throw new Error(`Claude connector catalog request failed (HTTP ${response.status})`);
    const body = await response.json() as CatalogResponse;
    cachedCatalog = body.data.filter((connector) => (connector.tools?.length ?? 0) > 0);
    cachedCatalogExpiry = Math.min(credentials.expiresAt, Date.now() + 5 * 60_000);
    return cachedCatalog;
  };

  const findConnector = async (name: string, credentials: ConnectorCredentials) => {
    const catalog = await getCatalog(credentials);
    const connector = catalog.find((candidate) => candidate.display_name === name);
    if (!connector) throw new Error(`Connected Claude connector not found: ${name}`);
    return connector;
  };

  const withClient = async <T>(connector: CatalogConnector, credentials: ConnectorCredentials, signal: AbortSignal | undefined, run: (client: Client) => Promise<T>) => {
    const { Client, StreamableHTTPClientTransport } = await runtimeLoader();
    const endpoint = new URL(`/v1/mcp/${encodeURIComponent(connector.id)}`, MCP_PROXY_ORIGIN);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Accept-Encoding": "identity",
          "X-Mcp-Client-Session-Id": clientSessionId,
        },
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin !== MCP_PROXY_ORIGIN) throw new Error("Refusing to send Claude credentials outside Anthropic's MCP proxy");
        return fetch(input, init);
      },
    });
    const client = new Client({ name: "pi-claude-connectors", version: "0.1.0" });
    try {
      await client.connect(transport, signal ? { signal } : undefined);
      return await run(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  pi.registerTool({
    name: "claude_connectors",
    label: "Claude Connectors",
    description: "List and call MCP connectors attached to the user's claude.ai account. Use list_connectors, list_tools, and describe_tool before call. Non-read-only calls require interactive confirmation.",
    promptSnippet: "Access MCP connectors attached to the user's Claude account",
    promptGuidelines: ["Use claude_connectors for services available only through the user's claude.ai connectors; list and describe tools before calling them."],
    parameters: Params,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let credentials: ConnectorCredentials | undefined;
      try {
        credentials = await credentialReader();

        if (params.action === "list_connectors") {
          const connectors = await getCatalog(credentials, true);
          return {
            content: [{ type: "text", text: asText(connectors.map(connectorSummary)) }],
            details: { connectorCount: connectors.length },
          };
        }

        const connectorName = requireString(params.connector, "connector");
        const connector = await findConnector(connectorName, credentials);

        if (params.action === "list_tools") {
          const tools = await withClient(connector, credentials, signal, async (client) => (await client.listTools(undefined, signal ? { signal } : undefined)).tools);
          return {
            content: [{ type: "text", text: asText(tools.map(toolSummary)) }],
            details: { connector: connectorName, toolCount: tools.length },
          };
        }

        const toolName = requireString(params.tool, "tool");
        return await withClient(connector, credentials, signal, async (client) => {
          const tools = (await client.listTools(undefined, signal ? { signal } : undefined)).tools;
          const tool = tools.find((candidate) => candidate.name === toolName);
          if (!tool) throw new Error(`Tool ${toolName} was not found on connector ${connectorName}`);

          if (params.action === "describe_tool") {
            return {
              content: [{ type: "text" as const, text: asText({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                annotations: tool.annotations,
              }) }],
              details: { connector: connectorName, tool: toolName },
            };
          }

          if (tool.annotations?.readOnlyHint !== true) {
            if (!ctx.hasUI) throw new Error(`Connector tool ${connectorName}/${toolName} is not marked read-only and requires interactive confirmation`);
            const confirmed = await ctx.ui.confirm("Run connector action?", `${connectorName} / ${toolName}\n\nThis tool may modify external data.`);
            if (!confirmed) {
              return {
                content: [{ type: "text" as const, text: "Connector action cancelled by the user." }],
                details: { connector: connectorName, tool: toolName, cancelled: true },
              };
            }
          }

          const result = await client.callTool(
            { name: toolName, arguments: params.arguments ?? {} },
            undefined,
            signal ? { signal } : undefined,
          );
          const persisted = await persistLargeTextResult(resultContent(result));
          return {
            content: persisted.content,
            details: {
              connector: connectorName,
              tool: toolName,
              ...(persisted.fullOutputPath ? { fullOutputPath: persisted.fullOutputPath, totalBytes: persisted.totalBytes } : {}),
            },
            isError: "isError" in result && result.isError === true,
          };
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: safeError(error, credentials) }],
          details: {},
          isError: true,
        };
      }
    },
  });
  };
}

export default createClaudeConnectorsExtension();
