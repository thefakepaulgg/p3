import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectorAuthMode,
  createClaudeConnectorsAuth,
  parsePastedCode,
  readClaudeCodeCredentials,
  setConnectorAuthMode,
} from "./claude-connectors-auth.ts";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "p3-connectors-auth-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "credentials.json");
}

async function seedExpiredStore(storePath: string): Promise<string> {
  const raw = `${JSON.stringify({
    accessToken: "expired-access",
    refreshToken: "valid-refresh",
    expiresAt: Date.now() - 1,
    refreshTokenExpiresAt: Date.now() + 60_000,
    scopes: ["user:profile", "user:mcp_servers"],
  }, null, 2)}\n`;
  await writeFile(storePath, raw, { mode: 0o600 });
  return raw;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("parsePastedCode accepts only CODE#STATE", () => {
  expect(parsePastedCode("code#state")).toEqual({ code: "code", state: "state" });
  expect(parsePastedCode("code-only")).toBeNull();
  expect(parsePastedCode("a#b#c")).toBeNull();
});

test("auth mode defaults to direct and can select Claude Code credentials", async () => {
  const modePath = await temporaryStore();
  expect(await connectorAuthMode(modePath)).toBe("direct");

  await setConnectorAuthMode("claude-code", modePath);

  expect(await connectorAuthMode(modePath)).toBe("claude-code");
  expect((await stat(modePath)).mode & 0o777).toBe(0o600);
});

test("Claude Code credential mode reads the existing connector-scoped login", async () => {
  const storePath = await temporaryStore();
  await writeFile(storePath, JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-code-access",
      refreshToken: "claude-code-refresh",
      expiresAt: Date.now() + 60_000,
      refreshTokenExpiresAt: Date.now() + 120_000,
      scopes: ["user:profile", "user:mcp_servers"],
    },
  }), { mode: 0o600 });

  const credentials = await readClaudeCodeCredentials(storePath);

  expect(credentials.accessToken).toBe("claude-code-access");
  expect(credentials.scopes).toContain("user:mcp_servers");
});

test("login uses the connector scope and stores credentials privately", async () => {
  const storePath = await temporaryStore();
  let requestBody: Record<string, string> | undefined;
  const auth = createClaudeConnectorsAuth({
    storePath,
    fetchFn: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: "user:profile user:mcp_servers",
      }), { status: 200 });
    },
  });

  const login = auth.startLogin();
  const authorizationUrl = new URL(login.url);
  expect(authorizationUrl.origin).toBe("https://claude.com");
  expect(authorizationUrl.searchParams.get("scope")).toBe("user:profile user:mcp_servers");
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

  await auth.completeLogin(login, `authorization-code#${login.state}`);

  expect(requestBody?.grant_type).toBe("authorization_code");
  expect(requestBody?.code_verifier).toBe(login.verifier);
  expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  expect(await auth.freshCredentials()).toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    scopes: ["user:profile", "user:mcp_servers"],
  });
  expect(await auth.statusText()).not.toContain("new-access");
  expect(await auth.statusText()).not.toContain("new-refresh");
});

test("concurrent auth instances perform one refresh", async () => {
  const storePath = await temporaryStore();
  await seedExpiredStore(storePath);
  let refreshes = 0;
  const fetchFn: typeof fetch = async () => {
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(JSON.stringify({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "user:profile user:mcp_servers",
    }), { status: 200 });
  };
  const first = createClaudeConnectorsAuth({ storePath, fetchFn });
  const second = createClaudeConnectorsAuth({ storePath, fetchFn });

  const results = await Promise.all([first.freshCredentials(), second.freshCredentials()]);

  expect(refreshes).toBe(1);
  expect(results.map((result) => result.accessToken)).toEqual(["rotated-access", "rotated-access"]);
});

test("a failed refresh never clears or rewrites the stored credential", async () => {
  const storePath = await temporaryStore();
  const original = await seedExpiredStore(storePath);
  const auth = createClaudeConnectorsAuth({
    storePath,
    fetchFn: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });

  await expect(auth.freshCredentials()).rejects.toThrow("HTTP 400");

  expect(await readFile(storePath, "utf8")).toBe(original);
});
