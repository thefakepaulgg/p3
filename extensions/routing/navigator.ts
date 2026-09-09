import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatElapsed, formatModelLabel } from "./state.ts";
import { formatEstimatedCost } from "./usage.ts";
import type { RoutingManifest } from "./manifest.ts";
import { parseJson, runHerdr } from "./herdr.ts";

interface NavigationTarget { label: string; paneId: string; detail: string }

const targets = (manifest: RoutingManifest): NavigationTarget[] => {
  const now = Date.now();
  const rows: NavigationTarget[] = [{ label: "main", paneId: manifest.parentPaneId, detail: "parent" }];
  for (const task of manifest.tasks) {
    if (task.clearedAt || task.paneClosedAt) continue;
    const until = task.endedAt ?? now;
    const cost = formatEstimatedCost(task.estimatedCost, task.costKnown);
    rows.push({
      label: task.label,
      paneId: task.paneId,
      detail: [task.state, formatModelLabel(task.model), formatElapsed(until - task.startedAt), cost].filter(Boolean).join(" · "),
    });
  }
  return rows;
};

export async function focusManifestPane(pi: ExtensionAPI, paneId: string): Promise<void> {
  const workspaceId = process.env.PI_ROUTED_ROOT_WORKSPACE_ID ?? process.env.HERDR_WORKSPACE_ID;
  const raw = await runHerdr(pi, ["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])], 5000);
  const panes = parseJson(raw, "herdr pane list")?.result?.panes ?? [];
  if (!panes.some((pane: any) => pane.pane_id === paneId)) throw new Error(`Routed pane ${paneId} no longer exists`);
  await runHerdr(pi, ["agent", "focus", paneId], 5000);
}

class RoutedNavigator implements Component {
  private selected = 0;
  private signature = "";
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly getManifest: () => RoutingManifest,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (paneId?: string) => void,
  ) {
    this.signature = JSON.stringify(getManifest());
    this.timer = setInterval(() => {
      const next = JSON.stringify(this.getManifest());
      if (next === this.signature) return;
      this.signature = next;
      this.tui.requestRender();
    }, 500);
  }
  handleInput(data: string): void {
    const rows = targets(this.getManifest());
    if (matchesKey(data, "escape")) { this.done(); return; }
    if (matchesKey(data, "up")) {
      if (this.selected === 0) this.done(); else this.selected -= 1;
      return;
    }
    if (matchesKey(data, "down")) { this.selected = Math.min(rows.length - 1, this.selected + 1); return; }
    if (matchesKey(data, "enter")) this.done(rows[this.selected]?.paneId);
  }
  render(width: number): string[] {
    const manifest = this.getManifest();
    const rows = targets(manifest);
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    const total = formatEstimatedCost(manifest.sessionTotal, manifest.sessionTotalKnown);
    const output = [this.theme.fg("accent", this.theme.bold(`Routed agents${total ? ` · session total ${total}` : ""}`))];
    rows.forEach((row, index) => {
      const marker = index === this.selected ? "›" : " ";
      const line = `${marker} ${row.label} · ${row.detail}`;
      output.push(index === this.selected ? this.theme.fg("accent", line) : this.theme.fg("text", line));
    });
    output.push(this.theme.fg("dim", "↑/↓ navigate · Enter focus · Escape close"));
    return output.map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line);
  }
  invalidate(): void {}
  dispose(): void { clearInterval(this.timer); }
}

export function installRoutedNavigator(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  getManifest: () => RoutingManifest | undefined;
}): () => void {
  const { pi, ctx, getManifest } = options;
  let open = false;
  return ctx.ui.onTerminalInput((data) => {
    if (open || !matchesKey(data, "down") || ctx.ui.getEditorText().length > 0) return;
    const manifest = getManifest();
    if (!manifest || targets(manifest).length <= 1) return;
    open = true;
    void ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new RoutedNavigator(() => getManifest() ?? manifest, tui, theme, done), { overlay: true })
      .then(async (paneId) => {
        if (!paneId) return;
        try { await focusManifestPane(pi, paneId); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
      })
      .finally(() => { open = false; });
    return { consume: true };
  });
}
