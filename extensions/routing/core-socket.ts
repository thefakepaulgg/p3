import { createConnection } from "node:net";

// Herdr Core transport: JSON-RPC 2.0 over the core socket, plain mode (one JSON message per line).
// The only module that speaks to core; callers go through mux-core.ts.

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
let requestSequence = 0;

type CoreTestTransport = (method: string, params: Record<string, unknown>, timeout: number) => Promise<any>;
let testTransport: CoreTestTransport | undefined;

/** Test seam only; production callers always use the socket. */
export function setCoreTestTransportForTests(transport?: CoreTestTransport): void {
  testTransport = transport;
}

export function resolveCoreSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HC_TERMINAL_SOCKET?.trim() || env.HC_SOCKET?.trim();
  if (configured) return configured;
  return `/run/user/${process.getuid?.() ?? 0}/herdr-core/default.sock`;
}

/** A JSON-RPC error from core; `kind` is its stable `data.kind`. */
export class CoreRpcError extends Error {
  constructor(readonly kind: string | undefined, message: string, readonly code?: number) {
    super(`${kind ?? "core_error"}: ${message}`);
  }
}

/** Resolves a JSON-RPC `result`; rejects with CoreRpcError for JSON-RPC errors. */
export function requestCore(method: string, params: Record<string, unknown>, timeout = 10_000): Promise<any> {
  if (testTransport) return testTransport(method, params, timeout);
  return new Promise((resolve, reject) => {
    const id = `p3:${process.pid}:${requestSequence++}`;
    let settled = false;
    let buffered = "";
    const socket = createConnection(resolveCoreSocketPath());
    socket.setEncoding("utf8");
    const finish = (error?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`core_socket_timeout: ${method} timed out after ${timeout}ms`)), timeout);
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_RESPONSE_BYTES) return finish(new Error(`core_response_too_large: ${method}`));
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response: any;
      try { response = JSON.parse(buffered.slice(0, newline)); }
      catch { return finish(new Error(`core_invalid_response: ${method} returned invalid JSON`)); }
      if (response?.id !== id) return finish(new Error(`core_response_mismatch: ${method} returned id ${JSON.stringify(response?.id)}`));
      if (response.error) return finish(new CoreRpcError(response.error.data?.kind, response.error.message ?? "Herdr Core request failed", response.error.code));
      finish(undefined, response.result);
    });
    socket.once("error", (error) => finish(new Error(`core_socket_error: ${method}: ${error.message}`)));
    socket.once("close", () => finish(new Error(`core_empty_response: ${method} closed without a response`)));
  });
}
