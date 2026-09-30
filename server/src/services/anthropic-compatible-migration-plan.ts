// wabnet fork: pure planner for migrating env-routed claude_local agents onto shared
// `anthropic_compatible` connections. No DB or network access, so it can also run standalone
// (read-only dry-run). Output never contains a credential; tokens appear as sha256 prefixes only.
import { createHash } from "node:crypto";
import {
  ANTHROPIC_COMPATIBLE_PRESETS,
  ANTHROPIC_COMPATIBLE_PRESET_IDS,
  isAllowedAnthropicCompatibleBaseUrl,
  type AnthropicCompatiblePreset,
} from "@paperclipai/shared";

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

export function plainValue(binding: unknown): string | null | undefined {
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

