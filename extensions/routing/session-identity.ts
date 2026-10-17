import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runHerdr } from "./herdr.ts";

/** Routed panes identify themselves even without Herdr's optional account-level Pi integration. */
export function registerRoutedSessionIdentity(pi: ExtensionAPI): void {
  let sequence = Date.now() * 1000;
  const publish = async (ctx: ExtensionContext, reason?: string) => {
    const pane = process.env.HERDR_PANE_ID;
    const path = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1" || !pane || !path) return;
    // Herdr selects Pi session identity from this canonical source. A custom source
    // is accepted but invisible to agent.get. Leave lifecycle state to Herdr/native hooks.
    await runHerdr(pi, ["pane", "report-agent-session", pane, "--source", "herdr:pi", "--agent", "pi", "--seq", String(++sequence), "--agent-session-path", path,
      ...(reason ? ["--session-start-source", reason] : [])], 5000);
  };
  pi.on("session_start", (event, ctx) => publish(ctx, event.reason));
  // A new Pi session may not have a file until its first turn starts.
  pi.on("agent_start", (_event, ctx) => publish(ctx));
}
