import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectMux, mux, selfIdentity } from "./mux.ts";

/** Routed panes identify themselves even without Herdr's optional account-level Pi integration. */
export function registerRoutedSessionIdentity(pi: ExtensionAPI): void {
  // Worker launches retain normal extension discovery. Do not compete with the
  // canonical integration's sequence counter when it is installed in this account.
  // That integration only speaks to the Herdr TUI, so on core nothing else publishes the session.
  if (detectMux() !== "core" && existsSync(join(getAgentDir(), "extensions", "herdr-agent-state.ts"))) return;
  let sequence = Date.now() * 1000;
  const publish = async (ctx: ExtensionContext, reason?: string) => {
    const { backend, id: pane } = selfIdentity();
    const path = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || !backend || !pane || !path) return;
    // Herdr selects Pi session identity from this canonical source. A custom source
    // is accepted but invisible to agent.get. Leave lifecycle state to Herdr/native hooks.
    await mux().reportSession(pi, pane, path, ++sequence, reason);
  };
  pi.on("session_start", (event, ctx) => publish(ctx, event.reason));
  // A new Pi session may not have a file until its first turn starts.
  pi.on("agent_start", (_event, ctx) => publish(ctx));
}
