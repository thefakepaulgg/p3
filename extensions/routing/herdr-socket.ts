import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Herdr TUI transport: the only module that speaks to the TUI socket. Callers go through mux.ts.

export function parseJson(text: string, command: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error(`${command} returned invalid JSON: ${text.slice(0, 300)}`); }
}

interface HerdrSocketRequest {
  method: string;
  params: Record<string, unknown>;
  textResult?: (response: any) => string;
}

type HerdrTestTransport = (pi: ExtensionAPI, args: string[], timeout: number) => Promise<string>;
const MAX_SOCKET_RESPONSE_BYTES = 16 * 1024 * 1024;
let requestSequence = 0;
let testTransport: HerdrTestTransport | undefined;

/** Test seam only; production callers always use the socket transport. */
export function setHerdrTestTransportForTests(transport?: HerdrTestTransport): void {
  testTransport = transport;
}

export function resolveHerdrSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH?.trim()) return process.env.HERDR_SOCKET_PATH.trim();
  const configRoot = process.env.XDG_CONFIG_HOME?.trim()
    ? join(process.env.XDG_CONFIG_HOME.trim(), "herdr")
    : join(homedir(), ".config", "herdr");
  const session = process.env.HERDR_SESSION?.trim();
  return session ? join(configRoot, "sessions", session, "herdr.sock") : join(configRoot, "herdr.sock");
}

export function requestHerdrSocket(
  method: string,
  params: Record<string, unknown>,
  timeout: number,
  socketPath = resolveHerdrSocketPath(),
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `pi-routing:${process.pid}:${Date.now()}:${requestSequence++}`;
    const request = `${JSON.stringify({ id, method, params })}\n`;
    let settled = false;
    let buffered = "";
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");

    const finish = (error?: Error, response?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error(`herdr_socket_timeout: ${method} timed out after ${timeout}ms`)), timeout);

    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_SOCKET_RESPONSE_BYTES) {
        finish(new Error(`herdr_response_too_large: ${method} exceeded ${MAX_SOCKET_RESPONSE_BYTES} bytes`));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline).trim();
      let response: any;
      try { response = JSON.parse(line); }
      catch { finish(new Error(`herdr_invalid_response: ${method} returned invalid JSON: ${line.slice(0, 300)}`)); return; }
      if (response?.id !== id) {
        finish(new Error(`herdr_response_mismatch: ${method} returned response id ${JSON.stringify(response?.id)}`));
        return;
      }
      if (response?.error) {
        finish(new Error(`${response.error.code ?? "herdr_error"}: ${response.error.message ?? "Herdr request failed"}`));
        return;
      }
      if (!response?.result) {
        finish(new Error(`herdr_invalid_response: ${method} returned no result`));
        return;
      }
      finish(undefined, response);
    });
    socket.once("error", (error) => finish(new Error(`herdr_socket_error: ${method}: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finish(new Error(`herdr_empty_response: ${method} closed without a response`));
    });
  });
}

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const repeatedOptions = (args: string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!);
  return values;
};

const envOptions = (args: string[]) => Object.fromEntries(repeatedOptions(args, "--env").map((entry) => {
  const separator = entry.indexOf("=");
  return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
}));

const metadataTokens = (args: string[]) => ({
  ...Object.fromEntries(repeatedOptions(args, "--token").map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  })),
  ...Object.fromEntries(repeatedOptions(args, "--clear-token").map((key) => [key, null])),
});

export function herdrSocketRequestForArgs(args: string[]): HerdrSocketRequest {
  const command = args.slice(0, 2).join(" ");
  const target = args[2];
  switch (command) {
    case "tab list": return { method: "tab.list", params: { workspace_id: option(args, "--workspace") } };
    case "tab create": return { method: "tab.create", params: { workspace_id: option(args, "--workspace"), cwd: option(args, "--cwd"), focus: !args.includes("--no-focus"), label: option(args, "--label"), env: envOptions(args) } };
    case "tab close": return { method: "tab.close", params: { tab_id: target } };
    case "pane list": return { method: "pane.list", params: { workspace_id: option(args, "--workspace") } };
    case "pane layout": return { method: "pane.layout", params: { pane_id: option(args, "--pane") ?? target } };
    case "pane focus": return { method: "pane.focus", params: { pane_id: target } };
    case "pane split": return { method: "pane.split", params: { target_pane_id: option(args, "--pane"), direction: option(args, "--direction"), cwd: option(args, "--cwd"), focus: !args.includes("--no-focus"), env: envOptions(args) } };
    case "pane close": return { method: "pane.close", params: { pane_id: target } };
    case "pane report-agent-session": return { method: "pane.report_agent_session", params: {
      pane_id: target, source: option(args, "--source"), agent: option(args, "--agent"), seq: Number(option(args, "--seq")),
      agent_session_path: option(args, "--agent-session-path"), session_start_source: option(args, "--session-start-source"),
    } };
    case "pane report-metadata": return {
      method: "pane.report_metadata",
      params: {
        pane_id: target,
        source: option(args, "--source"),
        agent: option(args, "--agent"),
        applies_to_source: option(args, "--applies-to-source"),
        display_agent: option(args, "--display-agent"),
        clear_display_agent: args.includes("--clear-display-agent"),
        tokens: metadataTokens(args),
      },
    };
    case "agent list": return { method: "agent.list", params: {} };
    case "agent get": return { method: "agent.get", params: { target } };
    case "agent focus": return { method: "agent.focus", params: { target } };
    case "agent read": return { method: "agent.read", params: { target, source: (option(args, "--source") ?? "recent-unwrapped").replaceAll("-", "_"), lines: Number(option(args, "--lines") ?? 80), format: "text", strip_ansi: true }, textResult: (response) => String(response?.result?.read?.text ?? "") };
    case "agent send-keys": return { method: "agent.send_keys", params: { target, keys: args.slice(3) } };
    case "agent wait": return { method: "agent.wait", params: { target, until: repeatedOptions(args, "--until"), timeout_ms: Number(option(args, "--timeout") ?? 0) || undefined } };
    case "agent prompt": {
      const wait = args.includes("--wait") ? { until: repeatedOptions(args, "--until"), timeout_ms: Number(option(args, "--timeout") ?? 0) || undefined } : undefined;
      return { method: "agent.prompt", params: { target, text: args[3] ?? "", wait } };
    }
    case "agent start": {
      const separator = args.indexOf("--");
      return { method: "agent.start", params: { name: target, kind: option(args, "--kind"), pane_id: option(args, "--pane"), timeout_ms: Number(option(args, "--timeout") ?? 30_000), args: separator >= 0 ? args.slice(separator + 1) : [] } };
    }
    default: throw new Error(`Unsupported Herdr socket command: ${command}`);
  }
}

/**
 * Raw socket transport for the routing extension. The CLI-shaped argument list is retained
 * internally to keep call sites compact; production requests never spawn the Herdr CLI.
 */
export async function runHerdr(pi: ExtensionAPI, args: string[], timeout: number): Promise<string> {
  if (testTransport) return testTransport(pi, args, timeout);
  const request = herdrSocketRequestForArgs(args);
  const response = await requestHerdrSocket(request.method, request.params, timeout);
  return request.textResult ? request.textResult(response) : JSON.stringify(response);
}

