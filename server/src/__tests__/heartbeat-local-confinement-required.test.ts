// wabnet L0009: with requireLocalConfinement on, an unconfined local agent's run fails closed
// BEFORE the adapter runs; exempt or confined agents run normally.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { localConfinementViolation, resolveLocalConfinementPolicy } from "../services/local-confinement-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describe("localConfinementViolation", () => {
  const required = { required: true, exemptAgentIds: new Set(["exempt"]) };
  it("fails unconfined local agents and passes confined, exempt, non-local, or not-required ones", () => {
    expect(localConfinementViolation(required, { id: "a", adapterType: "claude_local" }, {})).toMatch(/Local confinement is required/);
    expect(localConfinementViolation(required, { id: "a", adapterType: "codex_local" }, { filesystemScope: "workspace" })).toMatch(/required/);
    expect(localConfinementViolation(required, { id: "a", adapterType: "claude_local" }, { filesystemScope: "workspace", networkScope: "allowlist" })).toBeNull();
    expect(localConfinementViolation(required, { id: "exempt", adapterType: "claude_local" }, {})).toBeNull();
    expect(localConfinementViolation(required, { id: "a", adapterType: "http" }, {})).toBeNull();
    expect(localConfinementViolation({ required: false, exemptAgentIds: new Set() }, { id: "a", adapterType: "claude_local" }, {})).toBeNull();
  });
});

async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbedded("requireLocalConfinement (heartbeat)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-confinement-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: "claude_local",
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await instanceSettingsService(db).updateGeneral({ requireLocalConfinement: false, localConfinementExemptAgentIds: [] });
    await db.execute(sql.raw(`TRUNCATE TABLE "activity_log", "heartbeat_run_events", "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Confinement", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig, runtimeConfig: {}, permissions: {} });
    return agentId;
  }
  const ok = { exitCode: 0, signal: null, timedOut: false, provider: "anthropic", model: "test", summary: "ok" } as const;

  it("fails an unconfined agent's run before the adapter runs", async () => {
    execute.mockResolvedValue(ok);
    await instanceSettingsService(db).updateGeneral({ requireLocalConfinement: true });
    expect((await resolveLocalConfinementPolicy(db)).required).toBe(true);
    const agentId = await seedAgent({});
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRun(heartbeat, queued!.id);
    expect(execute).not.toHaveBeenCalled();
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("configuration_incomplete");
    expect(JSON.stringify(finished?.resultJson)).toContain("local_confinement_required");
    const [row] = await db.select().from(heartbeatRuns);
    expect(row?.error).toMatch(/Local confinement is required/);
  });

  it("runs an exempt agent, a confined agent, and everyone when the policy is off", async () => {
    execute.mockResolvedValue(ok);
    const exempt = await seedAgent({});
    await instanceSettingsService(db).updateGeneral({ requireLocalConfinement: true, localConfinementExemptAgentIds: [exempt] });
    const confined = await seedAgent({ filesystemScope: "workspace", networkScope: "deny" });
    for (const id of [exempt, confined]) {
      const queued = await heartbeat.invoke(id, "on_demand", {}, "manual");
      expect((await waitForRun(heartbeat, queued!.id))?.status).toBe("succeeded");
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("honours the PAPERCLIP_REQUIRE_LOCAL_CONFINEMENT env override", async () => {
    expect((await resolveLocalConfinementPolicy(db, { PAPERCLIP_REQUIRE_LOCAL_CONFINEMENT: "1" })).required).toBe(true);
    expect((await resolveLocalConfinementPolicy(db, {})).required).toBe(false);
  });
});
