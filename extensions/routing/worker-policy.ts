import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tools permitted in a read-only worker. Kept minimal: read the codebase, report back.
 * message_parent lets the worker escalate to its orchestrating primary.
 */
export const READONLY_WORKER_TOOLS: readonly string[] = Object.freeze(["read", "ls", "find", "grep", "message_parent"]);

/**
 * Build CLI arguments that restrict a Pi worker to the given tool policy.
 *
 * - `readonly: true` emits `--tools <allowlist> --exclude-tools mcp__*`
 *   which restricts to the read-only set and strips all MCP tools.
 *   Native MCP is disabled and extension-provided MCP tools are also excluded.
 *   Provider registration stays enabled so routed/failover models remain usable.
 * - `readonly: false | undefined` returns an empty array (no policy override).
 *
 * Never emits `--no-extensions`: failover models and other extension functionality
 * must remain available to workers.
 */
export function workerPolicyArgs(readonly?: boolean): string[] {
  if (!readonly) return [];
  return [
    "--tools", READONLY_WORKER_TOOLS.join(","),
    "--exclude-tools", "mcp__*",
    "--no-mcp",
  ];
}

/**
 * Register an extension-level read-only worker policy that blocks tool calls
 * outside the allowlist. This is the enforcement layer: even if CLI flags are
 * bypassed via codemode or extension tool calls, the `tool_call` handler rejects
 * disallowed tools.
 *
 * Activation is gated on `PI_ROUTED_READONLY=1` in the environment. When the env
 * var is absent or not `"1"`, this function is a no-op — no handlers are registered.
 *
 * Uses `session_start` to activate the projection without interfering with
 * provider registration that happens during extension load. The tool_call handler
 * itself is registered immediately so it is in place before the first turn.
 */
export function registerReadonlyWorkerPolicy(pi: ExtensionAPI): void {
  if (process.env.PI_ROUTED_READONLY !== "1") return;

  const allowedSet = new Set(READONLY_WORKER_TOOLS);
  let active = false;

  // Register the blocking handler immediately so it is in the handler chain
  // from the very first tool call. It only enforces once `active` is set.
  pi.on("tool_call", async (event) => {
    if (!active) return;
    if (allowedSet.has(event.toolName)) return;
    return {
      block: true,
      reason: `Read-only worker policy: ${event.toolName} is not in the allowed set [${READONLY_WORKER_TOOLS.join(", ")}]. Only read and reporting tools are permitted.`,
    };
  });

  // Activate after session_start so we don't interfere with provider registration
  // or extension initialization that may invoke tools internally.
  const projectTools = () => {
    if (typeof pi.getAllTools === "function" && typeof pi.setActiveTools === "function") {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      pi.setActiveTools(READONLY_WORKER_TOOLS.filter((tool) => available.has(tool)));
    }
  };
  pi.on("session_start", () => { active = true; projectTools(); });
  pi.on("before_agent_start", projectTools);
}
