import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = ["user:profile", "user:mcp_servers"];
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const REFRESH_SKEW_MS = 60_000;
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;

export const DEFAULT_STORE_PATH =
  process.env.PI_CLAUDE_CONNECTORS_CREDENTIALS
  ?? join(homedir(), ".config", "pi-claude-connectors", "credentials.json");
export const DEFAULT_MODE_PATH = join(dirname(DEFAULT_STORE_PATH), "config.json");
export const DEFAULT_CLAUDE_CODE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

export type ConnectorAuthMode = "direct" | "claude-code";

export interface ConnectorCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string | string[];
}

export interface LoginStart {
  url: string;
  state: string;
  verifier: string;
}

interface AuthDependencies {
  storePath: string;
  fetchFn: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function parseScopes(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value?.split(/\s+/).filter(Boolean) ?? [...SCOPES];
}

function requireConnectorScope(scopes: string[]): void {
  if (!scopes.includes("user:mcp_servers")) {
    throw new Error("Anthropic did not grant the user:mcp_servers scope");
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function connectorAuthMode(path = DEFAULT_MODE_PATH): Promise<ConnectorAuthMode> {
  try {
    const config = JSON.parse(await readFile(path, "utf8")) as { mode?: unknown };
    return config.mode === "claude-code" ? "claude-code" : "direct";
  } catch {
    return "direct";
  }
}

export async function setConnectorAuthMode(mode: ConnectorAuthMode, path = DEFAULT_MODE_PATH): Promise<void> {
  await writePrivateJson(path, { mode });
}

export async function readClaudeCodeCredentials(
  path = DEFAULT_CLAUDE_CODE_CREDENTIALS_PATH,
): Promise<ConnectorCredentials> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      refreshTokenExpiresAt?: number;
      scopes?: string[];
    };
  };
  const oauth = raw.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.expiresAt || !Array.isArray(oauth.scopes)) {
    throw new Error("Claude Code does not have a usable claude.ai credential");
  }
  requireConnectorScope(oauth.scopes);
  if (oauth.expiresAt <= Date.now()) {
    throw new Error("Claude Code's access token is expired; refresh it in Claude Code or switch to direct mode");
  }
  return {
    accessToken: oauth.accessToken,
    ...(oauth.refreshToken !== undefined ? { refreshToken: oauth.refreshToken } : {}),
    expiresAt: oauth.expiresAt,
    ...(oauth.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt } : {}),
    scopes: oauth.scopes,
  };
}

export function parsePastedCode(raw: string): { code: string; state: string } | null {
  const parts = raw.trim().replace(/^["']|["']$/g, "").split("#");
  const [code, state] = parts;
  if (parts.length !== 2 || !code || !state) return null;
  return { code, state };
}

export function createClaudeConnectorsAuth(overrides: Partial<AuthDependencies> = {}) {
  const dependencies: AuthDependencies = {
    storePath: DEFAULT_STORE_PATH,
    fetchFn: fetch,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
  const storePath = dependencies.storePath;
  const lockPath = `${storePath}.refresh.lock`;

  async function loadStore(): Promise<ConnectorCredentials | null> {
    try {
      const store = JSON.parse(await readFile(storePath, "utf8")) as ConnectorCredentials;
      if (!store.accessToken || !store.refreshToken || !Array.isArray(store.scopes)) return null;
      return store;
    } catch {
      return null;
    }
  }

  async function saveStore(store: ConnectorCredentials): Promise<void> {
    await writePrivateJson(storePath, store);
  }

  async function acquireLock(): Promise<() => Promise<void>> {
    const deadline = dependencies.now() + LOCK_TIMEOUT_MS;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        return async () => rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = await stat(lockPath);
          if (dependencies.now() - lock.mtimeMs > STALE_LOCK_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (dependencies.now() >= deadline) throw new Error("Timed out waiting for the connector OAuth refresh lock");
        await dependencies.sleep(LOCK_WAIT_MS);
      }
    }
  }

  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async function postToken(body: Record<string, string>): Promise<TokenResponse> {
    const response = await dependencies.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Anthropic token request failed (HTTP ${response.status})`);
    const data = await response.json() as TokenResponse;
    if (!data.access_token) throw new Error("Anthropic token response did not include an access token");
    return data;
  }

  function toStore(data: TokenResponse, previous?: ConnectorCredentials): ConnectorCredentials {
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new Error("Anthropic token response did not include a refresh token");
    const scopes = parseScopes(data.scope ?? previous?.scopes);
    requireConnectorScope(scopes);
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: dependencies.now() + Number(data.expires_in ?? 3600) * 1000,
      ...(data.refresh_token_expires_in !== undefined
        ? { refreshTokenExpiresAt: dependencies.now() + Number(data.refresh_token_expires_in) * 1000 }
        : previous?.refreshTokenExpiresAt !== undefined
          ? { refreshTokenExpiresAt: previous.refreshTokenExpiresAt }
          : {}),
      scopes,
    };
  }

  function startLogin(): LoginStart {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const url = new URL(AUTHORIZE_URL);
    url.search = String(new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }));
    return { url: String(url), state, verifier };
  }

  async function completeLogin(start: LoginStart, rawPaste: string): Promise<void> {
    const pasted = parsePastedCode(rawPaste);
    if (!pasted) throw new Error("Expected a value like CODE#STATE");
    if (pasted.state !== start.state) throw new Error("State mismatch — paste the code from this login attempt");

    const data = await postToken({
      grant_type: "authorization_code",
      code: pasted.code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: start.verifier,
      state: pasted.state,
    });
    await withLock(() => saveStore(toStore(data)));
  }

  async function freshCredentials(): Promise<ConnectorCredentials> {
    const current = await loadStore();
    if (!current) throw new Error("Claude connectors are not authorized. Run /connectors-login in Pi");
    requireConnectorScope(current.scopes);
    if (dependencies.now() < current.expiresAt - REFRESH_SKEW_MS) return current;

    return withLock(async () => {
      const latest = await loadStore();
      if (!latest) throw new Error("Claude connector credentials disappeared while refreshing");
      requireConnectorScope(latest.scopes);
      if (dependencies.now() < latest.expiresAt - REFRESH_SKEW_MS) return latest;
      if (latest.refreshTokenExpiresAt !== undefined && dependencies.now() >= latest.refreshTokenExpiresAt) {
        throw new Error("Claude connector authorization expired. Run /connectors-login in Pi");
      }

      try {
        const data = await postToken({
          grant_type: "refresh_token",
          refresh_token: latest.refreshToken!,
          client_id: CLIENT_ID,
          scope: latest.scopes.join(" "),
        });
        const refreshed = toStore(data, latest);
        await saveStore(refreshed);
        return refreshed;
      } catch (error) {
        const sibling = await loadStore();
        if (
          sibling
          && (sibling.accessToken !== latest.accessToken || sibling.refreshToken !== latest.refreshToken)
          && dependencies.now() < sibling.expiresAt - REFRESH_SKEW_MS
        ) {
          requireConnectorScope(sibling.scopes);
          return sibling;
        }
        throw error;
      }
    });
  }

  async function statusText(): Promise<string> {
    const store = await loadStore();
    if (!store) return `logged_out (${storePath})`;
    const accessState = dependencies.now() >= store.expiresAt ? "expired (will refresh on next use)" : "logged_in";
    const refreshExpiry = store.refreshTokenExpiresAt
      ? `, authorization expires ${new Date(store.refreshTokenExpiresAt).toISOString()}`
      : "";
    return `${accessState}, access expires ${new Date(store.expiresAt).toISOString()}${refreshExpiry} (${storePath})`;
  }

  async function logout(): Promise<void> {
    await withLock(() => rm(storePath, { force: true }));
  }

  return { storePath, startLogin, completeLogin, freshCredentials, statusText, logout };
}

const defaultAuth = createClaudeConnectorsAuth();

export const startConnectorLogin = defaultAuth.startLogin;
export const completeConnectorLogin = defaultAuth.completeLogin;
export const freshConnectorCredentials = defaultAuth.freshCredentials;
export const connectorStatusText = defaultAuth.statusText;
export const logoutConnectors = defaultAuth.logout;

export async function selectedConnectorCredentials(): Promise<ConnectorCredentials> {
  return await connectorAuthMode() === "claude-code"
    ? readClaudeCodeCredentials()
    : freshConnectorCredentials();
}

async function claudeCodeStatusText(): Promise<string> {
  try {
    const credentials = await readClaudeCodeCredentials();
    return `logged_in, access expires ${new Date(credentials.expiresAt).toISOString()} (${DEFAULT_CLAUDE_CODE_CREDENTIALS_PATH})`;
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function connectorAuthStatusText(): Promise<string> {
  const [mode, direct, claudeCode] = await Promise.all([
    connectorAuthMode(),
    connectorStatusText(),
    claudeCodeStatusText(),
  ]);
  return `mode=${mode}\ndirect: ${direct}\nclaude-code: ${claudeCode}`;
}
