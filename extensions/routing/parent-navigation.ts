import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { focusManifestPane, RoutedTaskWidget, type RoutedWidgetTarget } from "./navigator.ts";
import { readRoutingManifest } from "./manifest.ts";
import { WIDGET_KEY } from "./state.ts";

export default function routedParentNavigation(pi: ExtensionAPI): void {
  let widget: RoutedTaskWidget | undefined;
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const manifest = readRoutingManifest(process.env.PI_ROUTING_MANIFEST?.trim());
    const parentPaneId = manifest?.parentPaneId;
    if (ctx.mode !== "tui" || !parentPaneId || parentPaneId === process.env.HERDR_PANE_ID) return;

    const target: RoutedWidgetTarget = { handle: "parent", paneId: parentPaneId };
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      widget = new RoutedTaskWidget(
        tui,
        () => [target],
        (selected) => [
          ctx.ui.theme.fg("accent", `╭─ ${ctx.ui.theme.bold("Routed agent")}`),
          `${ctx.ui.theme.fg(selected === "parent" ? "accent" : "dim", selected === "parent" ? "›" : "│")} ${ctx.ui.theme.fg("accent", "↩")} ${ctx.ui.theme.fg("text", "Parent")}${ctx.ui.theme.fg("dim", " · main")}`,
          ctx.ui.theme.fg("dim", "╰─"),
        ],
        (paneId) => focusManifestPane(pi, paneId),
        (message) => ctx.ui.notify(message, "warning"),
      );
      return widget;
    }, { placement: "belowEditor" });
    unsubscribe = ctx.ui.onTerminalInput((data) => widget?.handleTerminalInput(data, ctx.ui.getEditorText()));
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    widget = undefined;
  });
}
