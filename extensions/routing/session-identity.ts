import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runHerdr } from "./herdr.ts";

/** Routed panes must identify their saved session even without Herdr's optional Pi integration. */
export function registerRoutedSessionIdentity(pi: ExtensionAPI): void {
  let sequence = Date.now() * 1000;
  const publish = async (ctx: ExtensionContext, state: "idle" | "working", reason?: string) => {
    const pane = process.env.HERDR_PANE_ID;
    const path = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1" || !pane || !path) return;
    const identity = [pane, "--source", "herdr:pi", "--agent", "pi", "--agent-session-path", path];
    await runHerdr(pi, ["pane", "report-agent-session", ...identity, "--seq", String(++sequence),
      ...(reason ? ["--session-start-source", reason] : [])], 5000);
    // Herdr exposes the session belonging to the current lifecycle authority. A
    // session-only report is accepted but invisible until this source reports state.
    await runHerdr(pi, ["pane", "report-agent", ...identity, "--seq", String(++sequence), "--state", state], 5000);
  };
  pi.on("session_start", (event, ctx) => publish(ctx, ctx.isIdle() ? "idle" : "working", event.reason));
  // A new Pi session may not have a file until its first turn starts.
  pi.on("agent_start", (_event, ctx) => publish(ctx, "working"));
  pi.on("agent_settled", (_event, ctx) => publish(ctx, "idle"));
}
