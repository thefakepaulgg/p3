import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { ArtifactRow } from "./api.ts";

export type Tab = "all" | "mine" | "shared";
export interface BrowserState { tab: Tab; query: string; selected?: string }
export type BrowserAction = { type: "delete"; row: ArtifactRow; state: BrowserState } | { type: "close" };
export interface BrowserDeps {
  load(): Promise<{ all: ArtifactRow[]; shared: ArtifactRow[] }>;
  copy(row: ArtifactRow): Promise<string>;
  inSession(row: ArtifactRow): boolean;
}

const TABS: Tab[] = ["all", "mine", "shared"];
const AUDIENCE: Record<string, string> = { owner: "private", users: "specific people", org: "org-wide", public: "public" };
const TITLE_COLUMN = 44;

function ago(iso?: string) {
  const time = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)}d ago`;
  return `${Math.round(minutes / 10080)}w ago`;
}

const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
const URL_PATTERN = /https:\/\/claude\.ai\/\S+/;
const link = (text: string) => text.replace(URL_PATTERN, (url) => `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);

export class ArtifactBrowser {
  private all: ArtifactRow[] = [];
  private shared: ArtifactRow[] = [];
  private loading = true;
  private status = "";
  private searching = false;
  private readonly search = new Input({ prompt: "", placeholder: "Search artifacts…" });

  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly deps: BrowserDeps,
    private state: BrowserState, private readonly done: (action: BrowserAction) => void) {
    this.search.setValue(state.query);
    void this.refresh();
  }

  private async refresh() {
    this.loading = true;
    this.status = "";
    this.tui.requestRender();
    try { ({ all: this.all, shared: this.shared } = await this.deps.load()); }
    catch (error) { this.status = error instanceof Error ? error.message : String(error); }
    this.loading = false;
    this.tui.requestRender();
  }

  private rows() {
    const query = this.search.getValue().trim().toLowerCase();
    const seen = new Set<string>();
    const source = this.state.tab === "shared" ? this.shared : this.state.tab === "mine" ? this.all.filter((row) => row.rel === "mine") : [...this.all, ...this.shared];
    const rows = source.filter((row) => !seen.has(row.slug) && seen.add(row.slug) &&
      (!query || `${row.title ?? ""} ${row.label ?? ""}`.toLowerCase().includes(query)));
    const session = rows.filter((row) => this.deps.inSession(row));
    return { session, other: rows.filter((row) => !session.includes(row)) };
  }

  private ordered() { const { session, other } = this.rows(); return [...session, ...other]; }

  private current() {
    const rows = this.ordered();
    return rows.find((row) => row.slug === this.state.selected) ?? rows[0];
  }

  private move(delta: number) {
    const rows = this.ordered();
    if (!rows.length) return;
    const index = Math.max(0, rows.findIndex((row) => row.slug === this.current()?.slug));
    this.state.selected = rows[Math.min(rows.length - 1, Math.max(0, index + delta))].slug;
  }

  private act(label: string, run: () => Promise<string>) {
    this.status = `${label}…`;
    this.tui.requestRender();
    run().then((text) => { this.status = text; }, (error) => { this.status = error instanceof Error ? error.message : String(error); })
      .finally(() => this.tui.requestRender());
  }

  handleInput(data: string) {
    if (this.searching) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "down")) this.searching = this.search.focused = false;
      else this.search.handleInput(data);
      this.state.query = this.search.getValue();
      this.tui.requestRender();
      return;
    }
    const row = this.current();
    if (matchesKey(data, "escape") || data === "x" || data === "q") this.done({ type: "close" });
    else if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.state.tab = TABS[(TABS.indexOf(this.state.tab) + 1) % TABS.length];
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.state.tab = TABS[(TABS.indexOf(this.state.tab) + TABS.length - 1) % TABS.length];
    else if (data === "/") this.searching = this.search.focused = true;
    else if (data === "r") void this.refresh();
    else if ((matchesKey(data, "enter") || data === "c") && row) this.act("Copying URL", () => this.deps.copy(row));
    else if (data === "d" && row && row.rel === "mine") this.done({ type: "delete", row, state: { ...this.state, selected: row.slug } });
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const fg = this.theme.fg.bind(this.theme), bold = this.theme.bold.bind(this.theme);
    const tabs = TABS.map((tab) => tab === this.state.tab ? this.theme.inverse(` ${tab[0].toUpperCase()}${tab.slice(1)} `) : fg("muted", ` ${tab[0].toUpperCase()}${tab.slice(1)} `)).join(" ");
    const inner = Math.max(10, width - 4);
    const text = this.search.getValue() || fg("dim", "Search artifacts…");
    const field = this.searching ? this.search.render(inner - 3)[0] ?? "" : `${truncateToWidth(text, inner - 3)}${" ".repeat(Math.max(0, inner - 3 - visibleWidth(text)))}`;
    const lines = [
      `${fg("accent", bold("Artifacts"))} ${tabs}`, "",
      fg(this.searching ? "accent" : "dim", `╭${"─".repeat(inner)}╮`),
      `${fg(this.searching ? "accent" : "dim", "│")} ${fg("dim", "⌕")} ${field}${fg(this.searching ? "accent" : "dim", "│")}`,
      fg(this.searching ? "accent" : "dim", `╰${"─".repeat(inner)}╯`), "",
    ];
    const { session, other } = this.rows();
    const selected = this.current()?.slug;
    const visible = Math.max(3, this.tui.terminal.rows - 16);
    const ordered = [...session, ...other];
    const index = Math.max(0, ordered.findIndex((row) => row.slug === selected));
    const start = Math.min(Math.max(0, index - visible + 1), Math.max(0, ordered.length - visible));
    const window = new Set(ordered.slice(start, start + visible).map((row) => row.slug));
    const rowLine = (row: ArtifactRow) => {
      const icon = row.rel === "mine" ? fg("warning", "⧉") : fg("muted", "↳");
      const title = truncateToWidth(clean(row.title ?? "Untitled"), TITLE_COLUMN);
      const meta = [row.label && clean(row.label), row.audience && AUDIENCE[row.audience], ago(row.updatedAt), row.views ? `${row.views} views` : undefined].filter(Boolean).join(" · ");
      const pointer = row.slug === selected ? fg("accent", "❯") : " ";
      const name = row.slug === selected ? fg("accent", title) : title;
      return `${pointer} ${icon} ${name}${" ".repeat(Math.max(1, TITLE_COLUMN + 2 - visibleWidth(title)))}${fg("muted", meta)}`;
    };
    if (this.loading && !ordered.length) lines.push(fg("muted", "  Loading artifacts…"));
    else if (!ordered.length) lines.push(fg("muted", this.status ? "" : "  No artifacts"));
    for (const [heading, rows] of [["This session", session], ["Other artifacts", other]] as const) {
      const shown = rows.filter((row) => window.has(row.slug));
      if (!shown.length) continue;
      lines.push(`  ${bold(heading)}`, ...shown.map(rowLine), "");
    }
    const below = ordered.length - start - visible;
    if (below > 0) lines.splice(lines.length - 1, 0, fg("muted", `  ↓ ${below} more`));
    if (this.status) lines.push(fg("warning", `  ${link(clean(this.status))}`), "");
    lines.push(fg("dim", this.searching ? "Type to filter · Enter/Esc to leave search"
      : "Enter/c to copy link · d to delete · / to search · Tab to switch · r to refresh · x to dismiss"));
    return lines.map((line, index) => index === 3 ? line : truncateToWidth(line, width));
  }

  invalidate() { this.search.invalidate(); }
}
