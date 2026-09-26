import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestHerdrSocket } from "./routing/herdr.ts";

const directory = join(homedir(), ".pi", "agent", "agent-grants");
const storePath = join(directory, "grants.json");

interface Grant {
  id: string;
  issuerPane: string;
  recipientPane: string;
  recipientName: string;
  recipientSession: string;
  scope: { action: "merge"; repository: string; prNumbers: number[]; condition?: string };
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

const GrantParams = Type.Object({
  action: StringEnum(["propose", "revoke", "list"] as const),
  target: Type.Optional(Type.String({ minLength: 1, description: "Herdr agent name or pane ID (propose)" })),
  repository: Type.Optional(Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$", description: "Repository owner/name (propose)" })),
  prNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: "PR numbers (propose)" })),
  condition: Type.Optional(Type.String({ minLength: 1, description: "Optional grant condition (propose)" })),
  id: Type.Optional(Type.String({ minLength: 1, description: "Grant ID (revoke)" })),
});

function paneId(): string {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Agent grants require a Herdr-managed pane");
  return process.env.HERDR_PANE_ID;
}

async function readGrants(): Promise<Grant[]> {
  try {
    const grants: unknown = JSON.parse(await fs.readFile(storePath, "utf8"));
    if (!Array.isArray(grants)) throw new Error("Invalid agent grants store");
    return grants as Grant[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeGrants(grants: Grant[]): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = join(directory, `.grants-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(grants, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, storePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

export default function registerAgentGrants(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grant_agent",
    label: "Grant Agent",
    description: "Propose, revoke, or list user-confirmed, scoped merge authorization grants for Herdr agents. Grants are informational; this tool does not intercept commands or merge PRs.",
    parameters: GrantParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const issuerPane = paneId();
      if (params.action === "list") return result((await readGrants()).filter((grant) => grant.issuerPane === issuerPane && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now()));
      if (!ctx.hasUI) throw new Error("Agent grant changes require interactive user confirmation");

      if (params.action === "revoke") {
        if (!params.id) throw new Error("id is required to revoke a grant");
        const grants = await readGrants();
        const grant = grants.find((item) => item.id === params.id && item.issuerPane === issuerPane && !item.revokedAt);
        if (!grant) throw new Error("Active grant not found for this pane");
        const approved = await ctx.ui.confirm("Revoke agent grant?", `Grant ${grant.id}\nRecipient: ${grant.recipientName} (pane ${grant.recipientPane})\nAction: merge\nRepository: ${grant.scope.repository}\nPR numbers: ${grant.scope.prNumbers.join(", ")}${grant.scope.condition ? `\nCondition: ${grant.scope.condition}` : ""}`);
        if (!approved) return result({ confirmed: false });
        grant.revokedAt = new Date().toISOString();
        await writeGrants(grants);
        return result(grant);
      }

      if (!params.target || !params.repository || !params.prNumbers?.length) throw new Error("target, repository, and prNumbers are required to propose a grant");
      if (!/^[^/\s]+\/[^/\s]+$/.test(params.repository) || params.prNumbers.some((number) => !Number.isSafeInteger(number) || number < 1)) throw new Error("Invalid repository or PR numbers");
      const response = await requestHerdrSocket("agent.get", { target: params.target }, 5000);
      const recipient = response.result.agent as { pane_id?: string; name?: string; agent_session?: { value?: string } } | undefined;
      if (!recipient?.pane_id || !recipient.name || !recipient.agent_session?.value) throw new Error("Herdr did not return the recipient pane, name, and Pi session");
      if (recipient.pane_id === issuerPane) throw new Error("Cannot grant yourself agent authorization");
      const scope: Grant["scope"] = { action: "merge", repository: params.repository, prNumbers: [...new Set(params.prNumbers)], ...(params.condition ? { condition: params.condition } : {}) };
      const approved = await ctx.ui.confirm("Authorize agent merge grant?", `Recipient: ${recipient.name} (pane ${recipient.pane_id})\nAction: merge\nRepository: ${scope.repository}\nPR numbers: ${scope.prNumbers.join(", ")}${scope.condition ? `\nCondition: ${scope.condition}` : ""}\nExpires in 24 hours or when the recipient changes Pi sessions.`);
      if (!approved) return result({ confirmed: false });
      const grant: Grant = { id: randomUUID(), issuerPane, recipientPane: recipient.pane_id, recipientName: recipient.name,
        recipientSession: recipient.agent_session.value, scope, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
      const grants = await readGrants();
      grants.push(grant);
      await writeGrants(grants);
      return result(grant);
    },
  });

  pi.registerTool({
    name: "agent_grants",
    label: "Agent Grants",
    description: "List only active, user-confirmed merge grants addressed to this Herdr pane, directly from the local grants store. Grants do not intercept commands.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const recipientPane = paneId();
      const session = ctx.sessionManager.getSessionFile();
      return result((await readGrants()).filter((grant) => grant.recipientPane === recipientPane &&
        grant.recipientSession === session && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now()));
    },
  });
}
