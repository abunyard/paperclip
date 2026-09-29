// wabnet fork: `paperclipai ai-connections migrate-env-agents` — move env-routed claude_local
// agents (ANTHROPIC_BASE_URL + token in adapter env) onto shared anthropic_compatible
// connections. Dry-run by default; --apply needs the plan hash the dry-run printed.
import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface MigrateOptions extends BaseClientOptions {
  companyId?: string;
  apply?: boolean;
  planHash?: string;
}

type PlanResponse = {
  dryRun: boolean;
  planHash: string;
  groups?: Array<{
    key: string; baseUrl: string; tokenSha256: string; authHeader: string; preset: string; biller: string;
    connectionName: string; models: string[]; warnings: string[];
    agents: Array<{ name: string; status: string; removeKeys: string[]; keptModelKeys: string[] }>;
  }>;
  skipped?: Array<{ name: string; reason: string }>;
  results?: Array<{ group: string; connectionId: string; agents: string[] }>;
};

export function formatMigrationPlan(plan: PlanResponse): string {
  const lines: string[] = [];
  if (!plan.dryRun) {
    lines.push(`Applied plan ${plan.planHash}:`);
    for (const r of plan.results ?? []) lines.push(`  connection ${r.connectionId} <- ${r.agents.join(", ")}`);
    return lines.join("\n");
  }
  lines.push(`DRY RUN — plan ${plan.planHash} (nothing was changed)`);
  for (const g of plan.groups ?? []) {
    lines.push("");
    lines.push(`Connection "${g.connectionName}" [group ${g.key}]`);
    lines.push(`  endpoint ${g.baseUrl}  auth=${g.authHeader}  token sha256:${g.tokenSha256}…  preset=${g.preset}  biller=${g.biller}  billing=fixed`);
    lines.push(`  models: ${g.models.join(", ") || "(none)"}`);
    for (const a of g.agents)
      lines.push(`  - ${a.name} [${a.status}]  remove: ${a.removeKeys.join(", ")}  keep overrides: ${a.keptModelKeys.join(", ") || "none"}`);
    for (const w of g.warnings) lines.push(`  ! ${w}`);
  }
  if (plan.skipped?.length) {
    lines.push("");
    lines.push("Skipped:");
    for (const s of plan.skipped) lines.push(`  - ${s.name}: ${s.reason}`);
  }
  lines.push("");
  lines.push(`To apply exactly this plan (agents must be idle): --apply --plan-hash ${plan.planHash}`);
  return lines.join("\n");
}

export function registerAiConnectionCommands(program: Command): void {
  const ai = program.command("ai-connections").description("Manage AI connections");
  addCommonClientOptions(
    ai
      .command("migrate-env-agents")
      .description("Move env-routed claude_local agents onto Anthropic-compatible connections (dry-run by default)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--apply", "Apply the reviewed plan")
      .option("--plan-hash <hash>", "Plan hash printed by the dry-run (required with --apply)")
      .action(async (opts: MigrateOptions) => {
        try {
          if (opts.apply && !opts.planHash) throw new Error("--apply requires --plan-hash from a dry-run");
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<PlanResponse>(
            apiPath`/api/companies/${ctx.companyId}/ai-connections/anthropic-compatible/migrate-env-agents`,
            opts.apply ? { apply: true, planHash: opts.planHash } : { apply: false },
          );
          if (ctx.json) printOutput(result, { json: true });
          else console.log(formatMigrationPlan(result!));
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );
}
