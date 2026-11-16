import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import { completeLogin, logout, openBrowser, safeError, startLogin, statusText } from './claude-artifacts/auth.ts';
import { deleteArtifact, listArtifactRows } from './claude-artifacts/api.ts';
import { ArtifactBrowser, type BrowserAction, type BrowserState } from './claude-artifacts/browser.ts';

export default function claudeArtifactsExtension(pi: ExtensionAPI) {
  pi.registerCommand('artifacts-login', {
    description: 'Unofficial Artifacts OAuth login (browser approval, paste CODE#STATE)',
    handler: async (_args, ctx) => {
      try {
        const start = startLogin();
        ctx.ui.notify(`Approve access in your browser: ${start.url}`, 'info');
        openBrowser(start.url);
        const pasted = await ctx.ui.input('Paste CODE#STATE after browser approval:', 'CODE#STATE');
        if (!pasted?.trim()) { ctx.ui.notify('Login cancelled', 'warning'); return; }
        await completeLogin(start, pasted);
        ctx.ui.notify('Artifacts credentials saved', 'info');
      } catch (error) { ctx.ui.notify(safeError(error), 'error'); }
    },
  });
  pi.registerCommand('artifacts', {
    description: 'Browse Claude artifacts: copy link or delete',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('/artifacts needs the interactive TUI', 'warning'); return; }
      const transcript = JSON.stringify(ctx.sessionManager.getEntries());
      const deps = {
        load: async () => {
          try { const [all, shared] = await Promise.all([listArtifactRows('all'), listArtifactRows('shared')]); return { all, shared }; }
          catch (error) { throw new Error(safeError(error)); }
        },
        copy: async (row: { slug: string }) => {
          const url = `https://claude.ai/code/artifact/${row.slug}`;
          try { await copyToClipboard(url); } catch { return `Copy failed; open ${url}`; }
          return `Copied ${url}`;
        },
        inSession: (row: { slug: string }) => transcript.includes(row.slug),
      };
      let state: BrowserState = { tab: 'all', query: '' };
      for (;;) {
        const action = await ctx.ui.custom<BrowserAction>((tui, theme, _keys, done) => new ArtifactBrowser(tui, theme, deps, state, done));
        if (action.type === 'close') return;
        state = action.state;
        const title = action.row.title ?? '';
        if (!await ctx.ui.confirm('Delete artifact?', `Permanently delete "${title}"? There is no restore.`)) continue;
        try { await deleteArtifact(action.row.slug, title); ctx.ui.notify(`Deleted "${title}"`, 'info'); }
        catch (error) { ctx.ui.notify(safeError(error), 'error'); }
      }
    },
  });
  pi.registerCommand('artifacts-status', {
    description: 'Show isolated Artifacts credential status and granted scopes',
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(await statusText(), 'info'); }
      catch (error) { ctx.ui.notify(safeError(error), 'error'); }
    },
  });
  pi.registerCommand('artifacts-logout', {
    description: 'Delete isolated Artifacts credentials',
    handler: async (_args, ctx) => {
      try { await logout(); ctx.ui.notify('Artifacts credentials removed', 'info'); }
      catch (error) { ctx.ui.notify(safeError(error), 'error'); }
    },
  });
}
