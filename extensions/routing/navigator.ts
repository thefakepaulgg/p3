import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { parseJson, runHerdr } from "./herdr.ts";

export interface RoutedWidgetTarget { handle: string; paneId?: string; paneClosedAt?: number }

const isEditorComponent = (component: Component | null): component is EditorComponent =>
  !!component && typeof (component as EditorComponent).getText === "function" && typeof (component as EditorComponent).setText === "function";

export class RoutedTaskWidget implements Component {
  private selectedHandle: string | undefined;
  private editor: Component | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly getTargets: () => RoutedWidgetTarget[],
    private readonly renderLines: (selectedHandle?: string) => string[],
    private readonly focusPane: (paneId: string) => Promise<void>,
    private readonly warn: (message: string) => void,
  ) {}

  handleTerminalInput(data: string, editorText: string): { consume: true } | undefined {
    const focused = this.focusedComponent();
    if (!matchesKey(data, "down") || editorText.length > 0 || !isEditorComponent(focused)) return;
    const first = this.availableTargets()[0];
    if (!first) return;
    this.editor = focused;
    this.selectedHandle = first.handle;
    this.tui.setFocus(this);
    this.tui.requestRender();
    return { consume: true };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.leave(); return; }
    const targets = this.availableTargets();
    const selected = targets.findIndex((target) => target.handle === this.selectedHandle);
    if (matchesKey(data, "up")) {
      if (selected <= 0) this.leave();
      else { this.selectedHandle = targets[selected - 1].handle; this.tui.requestRender(); }
      return;
    }
    if (matchesKey(data, "down")) {
      if (selected >= 0 && selected < targets.length - 1) {
        this.selectedHandle = targets[selected + 1].handle;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "enter")) {
      const target = targets[selected];
      if (target?.paneId) void this.focusPane(target.paneId).catch((error) => this.warn(error instanceof Error ? error.message : String(error)));
    }
  }

  render(_width: number): string[] { return this.renderLines(this.selectedHandle); }
  invalidate(): void {}
  requestRender(): void { this.tui.requestRender(); }

  private availableTargets(): RoutedWidgetTarget[] {
    return this.getTargets().filter((target) => target.paneId && !target.paneClosedAt);
  }

  private focusedComponent(): Component | null {
    return (this.tui as TUI & { getFocusedComponent(): Component | null }).getFocusedComponent();
  }

  private leave(): void {
    this.selectedHandle = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }
}

export async function focusManifestPane(pi: ExtensionAPI, paneId: string): Promise<void> {
  const workspaceId = process.env.PI_ROUTED_ROOT_WORKSPACE_ID ?? process.env.HERDR_WORKSPACE_ID;
  const raw = await runHerdr(pi, ["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])], 5000);
  const panes = parseJson(raw, "herdr pane list")?.result?.panes ?? [];
  if (!panes.some((pane: any) => pane.pane_id === paneId)) throw new Error(`Routed pane ${paneId} no longer exists`);
  await runHerdr(pi, ["agent", "focus", paneId], 5000);
}
