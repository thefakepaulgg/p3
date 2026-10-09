import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { completeLogin, logout, openBrowser, safeError, startLogin, statusText } from './claude-artifacts/auth.ts';

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
