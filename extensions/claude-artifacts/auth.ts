import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'user:profile user:mcp_servers user:inference';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const STORE_PATH = join(homedir(), '.config', 'pi-claude-artifacts', 'credentials.json');

interface Credentials { accessToken: string; refreshToken: string; expiresAt: number; scope: string }

class SafeError extends Error {}
export function safeError(error: unknown) {
  return error instanceof SafeError ? error.message : 'Operation failed; no sensitive details displayed.';
}
export function fail(message: string): never { throw new SafeError(message); }
function parseJSON(text: string) {
  try { return JSON.parse(text); } catch { fail('Invalid JSON response or credential store.'); }
}
async function request(url: string, options: RequestInit = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password ||
      !['platform.claude.com'].includes(target.host)) {
    fail('Untrusted request endpoint.');
  }
  try {
    return await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { fail('Request failed or timed out.'); }
}
async function loadStore(): Promise<Credentials | null> {
  let text;
  try { text = await readFile(STORE_PATH, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; fail('Could not read credentials.'); }
  const store = parseJSON(text);
  if (!store || typeof store.accessToken !== 'string' || !store.accessToken ||
      typeof store.refreshToken !== 'string' || !store.refreshToken ||
      !Number.isFinite(store.expiresAt) || typeof store.scope !== 'string' || !store.scope.trim()) {
    fail('Invalid credential store.');
  }
  return store;
}
async function saveStore(store: Credentials) {
  const directory = dirname(STORE_PATH);
  const temporary = join(directory, `.credentials-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, STORE_PATH);
    await chmod(STORE_PATH, 0o600);
  } catch { fail('Could not save credentials.'); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function postToken(body: Record<string, string>, previous?: Credentials) {
  const response = await request(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); fail(`Token request failed (HTTP ${response.status}).`); }
  const data = parseJSON(await response.text());
  const scope = data?.scope ?? previous?.scope;
  const refreshToken = data?.refresh_token ?? previous?.refreshToken;
  if (typeof data?.access_token !== 'string' || !data.access_token ||
      typeof refreshToken !== 'string' || !refreshToken ||
      typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      typeof scope !== 'string' || !SCOPES.split(' ').every((s) => scope.split(/\s+/).includes(s))) {
    fail('Token response missing required tokens, expiry or granted scopes.');
  }
  if (previous && scope.split(/\s+/).some((s: string) => !previous.scope.split(/\s+/).includes(s))) {
    fail('Refresh response changed the granted scope set.');
  }
  return { accessToken: data.access_token, refreshToken, scope, expiresAt: Date.now() + data.expires_in * 1000 };
}
export function openBrowser(url: string) {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
export function startLogin() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://claude.com/cai/oauth/authorize');
  url.search = new URLSearchParams({
    code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
    scope: SCOPES, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state,
  }).toString();
  return { url: url.href, state, verifier };
}
export async function completeLogin(start: ReturnType<typeof startLogin>, raw: string) {
  const parts = raw.trim().split('#');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail('Expected CODE#STATE.');
  if (parts[1] !== start.state) fail('State mismatch; use the value from this login attempt.');
  await saveStore(await postToken({
    grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    code: parts[0], state: parts[1], code_verifier: start.verifier,
  }));
}
export async function freshAccessToken() {
  let store = await loadStore();
  if (!store) fail('Not logged in. Run /artifacts-login in Pi.');
  if (Date.now() >= store.expiresAt - 60_000) {
    store = await postToken({ grant_type: 'refresh_token', client_id: CLIENT_ID,
      refresh_token: store.refreshToken, scope: store.scope }, store);
    await saveStore(store);
  }
  return store.accessToken;
}
export async function statusText() {
  const store = await loadStore();
  if (!store) return `logged_out (${STORE_PATH})`;
  const scope = store.scope.split(/\s+/).filter((s) => /^[a-z_]+:[a-z_:/]+$/.test(s)).join(' ');
  return `${Date.now() >= store.expiresAt ? 'expired (auto-refresh on use)' : 'logged_in'}, expires ${new Date(store.expiresAt).toISOString()}, granted scope: ${scope} (${STORE_PATH})`;
}
export async function logout() {
  try { await rm(STORE_PATH, { force: true }); } catch { fail('Could not remove credentials.'); }
}

