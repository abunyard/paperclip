// wabnet L0013b: end-to-end proof that a managed AI (anthropic_compatible) claude_local agent
// resumes its saved task session on the next run, and that a real credential change still
// starts fresh with a logged reason. Before L0013b the identity check read the codec-decoded
// params, which never carry the identity, so run 2 always received sessionId null silently.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";
import { anthropicCompatibleEndpointSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const adapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", async () => {
  const { sessionCodec } = await import("@paperclipai/adapter-claude-local/server");
  const adapter = { type: "claude_local", execute: adapterExecute, supportsLocalAgentJwt: false, sessionCodec };
  return {
    getServerAdapter: () => adapter,
    findActiveServerAdapter: () => adapter,
    runningProcesses: new Map(),
  };
});

const { heartbeatService } = await import("../services/heartbeat.js");
const { aiConnectionService } = await import("../services/ai-connections.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const KEY = "fixture-gateway-key-0123456789";
const endpoint = anthropicCompatibleEndpointSchema.parse({
  baseUrl: "https://api.minimax.io/anthropic/",
  preset: "minimax",
  models: ["MiniMax-M3"],
  modelMap: { main: "MiniMax-M3" },
  billing: { biller: "minimax" },
});

describeEmbeddedPostgres("managed AI session resume (wabnet L0013b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const owner = "owner-user";

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-resume-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "managed-resume");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-managed-resume-db-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function setup() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Managed resume",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: owner,
    });
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Inquisitor", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M3" }, runtimeConfig: {}, permissions: {} });
    const service = aiConnectionService(db);
    const saved = await service.save(companyId, owner, { provider: "anthropic_compatible", method: "api_key", name: "MiniMax", ownership: "shared", apiKey: KEY, agentIds: [agentId], allAgents: false, endpoint }, KEY);
    const binding = { provider: "anthropic_compatible", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId };
    await db.update(agents).set({ runtimeConfig: { aiConnection: binding } }).where(eq(agents.id, agentId));
    await db.insert(issues).values({ id: issueId, companyId, title: "Remember the word", status: "in_progress", priority: "medium", responsibleUserId: owner, assigneeAgentId: agentId });
    return { companyId, agentId, issueId, saved, service };
  }

  async function runOnce(agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(latest?.status);
    }, { timeout: 20_000 });
    const latest = await heartbeat.getRun(run!.id);
    expect(latest?.status, JSON.stringify({ error: latest?.error, code: latest?.errorCode })).toBe("succeeded");
    return run!.id;
  }

  async function runLog(runId: string) {
    const log = await heartbeatService(db).readLog(runId);
    return JSON.stringify(log);
  }

  async function storedSession(agentId: string) {
    let row: typeof agentTaskSessions.$inferSelect | undefined;
    await vi.waitFor(async () => {
      [row] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
      expect(row).toBeDefined();
    }, { timeout: 10_000 });
    return row!;
  }

  function nextResult(sessionId: string) {
    adapterExecute.mockImplementationOnce(async (ctx: { config: Record<string, unknown>; context: Record<string, unknown> }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionParams: { sessionId, cwd: (ctx.context.paperclipWorkspace as { cwd?: string } | undefined)?.cwd ?? process.cwd() },
      sessionDisplayId: sessionId,
      summary: "ok",
      provider: "anthropic",
      model: "MiniMax-M3",
    }));
  }

  it("resumes run 1's session on run 2 of a managed agent", async () => {
    const { agentId, issueId } = await setup();
    const first = randomUUID();
    nextResult(first);
    await runOnce(agentId, issueId);
    const stored = await storedSession(agentId);
    expect(stored.sessionParamsJson).toMatchObject({ sessionId: first, paperclipAiCredentialIdentity: expect.any(String) });
    // The codec the adapter uses really does drop the identity (the root cause).
    expect(claudeSessionCodec.deserialize(stored!.sessionParamsJson)).not.toHaveProperty("paperclipAiCredentialIdentity");

    adapterExecute.mockClear();
    nextResult(first);
    const run2 = await runOnce(agentId, issueId);
    const input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null } };
    expect(input.runtime.sessionId).toBe(first);
    expect(await runLog(run2)).not.toContain("Skipping saved session resume");
  }, 90_000);

  it("still starts fresh after a real credential change, and logs why", async () => {
    const { agentId, issueId, companyId } = await setup();
    const first = randomUUID();
    nextResult(first);
    await runOnce(agentId, issueId);
    // Simulate a rotated secret: same grant and user, different credential generation.
    const stored = await storedSession(agentId);
    const params = stored!.sessionParamsJson as Record<string, unknown>;
    const [grant, user] = String(params.paperclipAiCredentialIdentity).split(":");
    await db.update(agentTaskSessions)
      .set({ sessionParamsJson: { ...params, paperclipAiCredentialIdentity: `${grant}:${user}:0000000000000000` } })
      .where(eq(agentTaskSessions.id, stored!.id));

    adapterExecute.mockClear();
    nextResult(randomUUID());
    const run2 = await runOnce(agentId, issueId);
    const input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null } };
    expect(input.runtime.sessionId).toBeNull();
    const log = await runLog(run2);
    expect(log).toContain("Skipping saved session resume");
    expect(log).toContain("credential generation");
    expect(log).not.toContain(KEY);
    expect(companyId).toBeTruthy();
  }, 90_000);
});
