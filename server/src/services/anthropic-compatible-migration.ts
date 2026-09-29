// wabnet fork: one-shot migration of env-configured claude_local agents (ANTHROPIC_BASE_URL +
// a token in adapterConfig.env, no AI connection) onto shared `anthropic_compatible` connections.
// Dry-run by default. Apply requires the plan hash the dry-run printed and idle agents.
// Output never contains a credential; tokens appear only as sha256 prefixes.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  ANTHROPIC_COMPATIBLE_PRESETS,
  ANTHROPIC_COMPATIBLE_PRESET_IDS,
  anthropicCompatibleEndpointSchema,
  isAllowedAnthropicCompatibleBaseUrl,
  type AnthropicCompatibleEndpoint,
  type AnthropicCompatiblePreset,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { agentService } from "./agents.js";

/** Keys moved into the connection (and removed from the agent). */
const ROUTING_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
/** Keys kept on the agent as per-agent overrides of the connection's model map. */
const MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export type MigrationAgentRow = {
  id: string;
  name: string;
  companyId: string;
  adapterType: string;
  status: string;
  adapterConfig: Record<string, unknown> | null;
  runtimeConfig: Record<string, unknown> | null;
};

type PlanAgent = { id: string; name: string; status: string; removeKeys: string[]; keptModelKeys: string[]; model: string | null };
export type MigrationGroup = {
  key: string;
  baseUrl: string;
  tokenSha256: string;
  authHeader: "bearer" | "x-api-key";
  preset: AnthropicCompatiblePreset;
  biller: string;
  connectionName: string;
  models: string[];
  agents: PlanAgent[];
  warnings: string[];
};
export type MigrationSkip = { id: string; name: string; reason: string };
export type MigrationPlan = { companyId: string; groups: MigrationGroup[]; skipped: MigrationSkip[]; planHash: string };

function plainValue(binding: unknown): string | null | undefined {
  if (binding === undefined) return undefined;
  if (typeof binding === "string") return binding;
  if (binding && typeof binding === "object" && (binding as { type?: unknown }).type === "plain") {
    const value = (binding as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  return null; // secret_ref / user_secret_ref: not migrated automatically
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function presetFor(baseUrl: string): { preset: AnthropicCompatiblePreset; biller: string; label: string } {
  for (const id of ANTHROPIC_COMPATIBLE_PRESET_IDS) {
    const preset = ANTHROPIC_COMPATIBLE_PRESETS[id];
    if (preset.baseUrl && preset.baseUrl.replace(/\/+$/, "") === baseUrl) return { preset: id, biller: preset.biller, label: preset.label };
  }
  let host = "custom_gateway";
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64) || host; } catch { /* keep default */ }
  return { preset: "custom", biller: host, label: host };
}

/** Pure planner. Deterministic order, so the plan hash is stable for the same rows. */
export function planEnvAgentMigration(companyId: string, rows: MigrationAgentRow[]): MigrationPlan {
  const groups = new Map<string, MigrationGroup>();
  const skipped: MigrationSkip[] = [];
  for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    if (row.companyId !== companyId || row.adapterType !== "claude_local") continue;
    const env = (row.adapterConfig?.env && typeof row.adapterConfig.env === "object" ? row.adapterConfig.env : {}) as Record<string, unknown>;
    const rawBase = plainValue(env.ANTHROPIC_BASE_URL);
    if (rawBase === undefined) continue; // not an env-routed agent
    if (row.status === "terminated") { skipped.push({ id: row.id, name: row.name, reason: "terminated" }); continue; }
    if (row.runtimeConfig?.aiConnection) { skipped.push({ id: row.id, name: row.name, reason: "already has an AI connection" }); continue; }
    const authToken = plainValue(env.ANTHROPIC_AUTH_TOKEN);
    const apiKey = plainValue(env.ANTHROPIC_API_KEY);
    if (rawBase === null || authToken === null || apiKey === null) {
      skipped.push({ id: row.id, name: row.name, reason: "routing or credential value is a secret reference; migrate it by hand" });
      continue;
    }
    const baseUrl = (rawBase ?? "").trim().replace(/\/+$/, "");
    if (!isAllowedAnthropicCompatibleBaseUrl(baseUrl)) {
      skipped.push({ id: row.id, name: row.name, reason: "base URL is not https (or loopback http)" });
      continue;
    }
    const credential = authToken?.trim() || apiKey?.trim();
    if (!credential) { skipped.push({ id: row.id, name: row.name, reason: "no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY" }); continue; }
    const authHeader = authToken?.trim() ? "bearer" as const : "x-api-key" as const;
    const tokenSha256 = sha(credential);
    const key = `${baseUrl}|${tokenSha256}|${authHeader}`;
    const { preset, biller, label } = presetFor(baseUrl);
    let group = groups.get(key);
    if (!group) {
      group = {
        key: sha(key).slice(0, 16),
        baseUrl,
        tokenSha256: tokenSha256.slice(0, 12),
        authHeader,
        preset,
        biller,
        connectionName: `${label} (migrated ${tokenSha256.slice(0, 6)})`,
        models: [],
        agents: [],
        warnings: [],
      };
      groups.set(key, group);
    }
    if (authToken?.trim() && apiKey?.trim())
      group.warnings.push(
        apiKey.trim() === authToken.trim()
          ? `${row.name}: ANTHROPIC_API_KEY duplicates the bearer token; both are removed, the connection sends bearer only`
          : `${row.name}: ANTHROPIC_API_KEY differs from ANTHROPIC_AUTH_TOKEN; only the bearer token is kept`,
      );
    const keptModelKeys = MODEL_KEYS.filter((k) => typeof plainValue(env[k]) === "string" && plainValue(env[k])!.trim());
    for (const k of keptModelKeys) group.models.push(plainValue(env[k])!.trim());
    if (typeof row.adapterConfig?.model === "string" && row.adapterConfig.model.trim()) group.models.push(row.adapterConfig.model.trim());
    group.agents.push({
      id: row.id,
      name: row.name,
      status: row.status,
      removeKeys: ROUTING_KEYS.filter((k) => env[k] !== undefined),
      keptModelKeys,
      model: typeof row.adapterConfig?.model === "string" ? row.adapterConfig.model : null,
    });
  }
  const list = [...groups.values()].map((group) => ({ ...group, models: [...new Set(group.models)].sort() }));
  const planHash = sha(JSON.stringify({ companyId, list, skipped })).slice(0, 16);
  return { companyId, groups: list, skipped, planHash };
}

export async function loadMigrationRows(db: Db, companyId: string): Promise<MigrationAgentRow[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, companyId: agents.companyId, adapterType: agents.adapterType, status: agents.status, adapterConfig: agents.adapterConfig, runtimeConfig: agents.runtimeConfig })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "claude_local")));
  return rows as MigrationAgentRow[];
}

/**
 * Apply a reviewed plan. Re-plans from current rows and refuses if the hash changed
 * or any planned agent is running/queued. Per group: create one shared connection
 * (credential stored as a secret), then bind each agent and remove its routing keys
 * in the same update, recording an agent config revision.
 */
export async function applyEnvAgentMigration(db: Db, companyId: string, userId: string, expectedPlanHash: string) {
  const rows = await loadMigrationRows(db, companyId);
  const plan = planEnvAgentMigration(companyId, rows);
  if (plan.planHash !== expectedPlanHash)
    throw unprocessable(`The plan changed since the dry-run (now ${plan.planHash}). Run the dry-run again and review it.`);
  const busy = plan.groups.flatMap((g) => g.agents).filter((a) => a.status === "running" || a.status === "queued");
  if (busy.length) throw unprocessable(`Pause these agents first: ${busy.map((a) => a.name).join(", ")}`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const connections = aiConnectionService(db);
  const agentsSvc = agentService(db);
  const results: { group: string; connectionId: string; agents: string[] }[] = [];
  for (const group of plan.groups) {
    const first = byId.get(group.agents[0]!.id)!;
    const env = first.adapterConfig!.env as Record<string, unknown>;
    const credential = (group.authHeader === "bearer" ? plainValue(env.ANTHROPIC_AUTH_TOKEN) : plainValue(env.ANTHROPIC_API_KEY))!.trim();
    const endpoint: AnthropicCompatibleEndpoint = anthropicCompatibleEndpointSchema.parse({
      baseUrl: group.baseUrl,
      authHeader: group.authHeader,
      preset: group.preset,
      models: group.models,
      modelMap: {},
      billing: { type: "fixed", biller: group.biller },
    });
    const saved = await connections.save(
      companyId,
      userId,
      {
        provider: "anthropic_compatible",
        method: "api_key",
        name: group.connectionName,
        ownership: "shared",
        apiKey: credential,
        agentIds: group.agents.map((a) => a.id),
        allAgents: false,
        endpoint,
      },
      credential,
    );
    for (const planned of group.agents) {
      const row = byId.get(planned.id)!;
      const nextEnv = { ...(row.adapterConfig!.env as Record<string, unknown>) };
      for (const k of planned.removeKeys) delete nextEnv[k];
      await agentsSvc.update(
        planned.id,
        {
          adapterConfig: { ...row.adapterConfig, env: nextEnv },
          runtimeConfig: {
            ...(row.runtimeConfig ?? {}),
            aiConnection: { provider: "anthropic_compatible", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId },
          },
        },
        { recordRevision: { createdByUserId: userId, source: "anthropic_compatible_migration" } },
      );
    }
    results.push({ group: group.key, connectionId: saved.connectionId, agents: group.agents.map((a) => a.name) });
  }
  return { planHash: plan.planHash, results };
}
