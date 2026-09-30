// wabnet fork: one-shot migration of env-configured claude_local agents (ANTHROPIC_BASE_URL +
// a token in adapterConfig.env, no AI connection) onto shared `anthropic_compatible` connections.
// Dry-run by default. Apply requires the plan hash the dry-run printed and idle agents.
// Output never contains a credential; tokens appear only as sha256 prefixes.
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { anthropicCompatibleEndpointSchema, type AnthropicCompatibleEndpoint } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { agentService } from "./agents.js";
import { planEnvAgentMigration, plainValue, type MigrationAgentRow } from "./anthropic-compatible-migration-plan.js";

export { planEnvAgentMigration, type MigrationAgentRow, type MigrationGroup, type MigrationPlan, type MigrationSkip } from "./anthropic-compatible-migration-plan.js";

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
