// wabnet L0013b: end-to-end proof that a managed AI (anthropic_compatible) claude_local agent
// resumes its saved task session on the next run, and that a real credential change still
// starts fresh with a logged reason. Before L0013b the identity check read the codec-decoded
// params, which never carry the identity, so run 2 always received sessionId null silently.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
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
  projects,
  projectWorkspaces,
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
const { instanceSettingsService } = await import("../services/instance-settings.js");
const execFileAsync = promisify(execFile);

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

  async function runOnce(
    agentId: string,
    issueId: string,
    wake: { reason?: string; source?: "on_demand" | "automation" | "assignment"; context?: Record<string, unknown> } = {},
  ) {
    const heartbeat = heartbeatService(db);
    const reason = wake.reason ?? "issue_commented";
    const run = await heartbeat.wakeup(agentId, {
      source: wake.source ?? "on_demand",
      triggerDetail: wake.source === "automation" ? "system" : "manual",
      reason,
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, ...(wake.context ?? {}) },
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

  const MCP_IDENTITY = JSON.stringify([{ name: "paperclip", url: "http://127.0.0.1:3100/mcp", connectionId: null }]);
  function nextResult(sessionId: string) {
    adapterExecute.mockImplementationOnce(async (ctx: { config: Record<string, unknown>; context: Record<string, unknown> }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      // Shaped like the real claude_local result (cwd, prompt bundle and MCP server identity).
      sessionParams: {
        sessionId,
        cwd: (ctx.context.paperclipWorkspace as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
        promptBundleKey: "bundle-1",
        mcpServerIdentity: MCP_IDENTITY,
      },
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

  it("L0013d: hop 1 after an issue_assigned first run in a fresh worktree resumes with the full saved params", async () => {
    const { agentId, issueId, companyId } = await setup();
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-resume-repo-"));
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repoRoot });
    await git(["init"]);
    await git(["checkout", "-B", "master"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(path.join(repoRoot, "README.md"), "x\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "init"]);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, companyId, name: "Isolated", status: "active",
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
    });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Primary", cwd: repoRoot, isPrimary: true });
    // As issueService.create persists it for a project with an isolated policy.
    await db.update(issues).set({ projectId, identifier: "MR-1", executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issueId));

    const sid = randomUUID();
    adapterExecute.mockClear();
    nextResult(sid);
    await runOnce(agentId, issueId, { reason: "issue_assigned", source: "assignment" });
    const run1Input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null }; context: Record<string, unknown> };
    expect(run1Input.runtime.sessionId).toBeNull();
    const run1Cwd = (run1Input.context.paperclipWorkspace as { cwd: string }).cwd;
    expect(path.resolve(run1Cwd)).not.toBe(path.resolve(repoRoot)); // a fresh worktree, not the checkout
    await storedSession(agentId);

    // The handoff wake was resolved at ENQUEUE time, before run 1's task session existed:
    // it carries only the session id (the live WAB-191 hop-1 shape).
    adapterExecute.mockClear();
    nextResult(sid);
    await runOnce(agentId, issueId, {
      reason: "finish_successful_run_handoff",
      source: "automation",
      context: { resumeSessionDisplayId: sid, resumeSessionParams: { sessionId: sid } },
    });
    const run2Input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null } };
    expect(run2Input.runtime.sessionId).toBe(sid);
    expect(run2Input.runtime.sessionParams).toMatchObject({
      sessionId: sid,
      cwd: run1Cwd,
      promptBundleKey: "bundle-1",
      mcpServerIdentity: MCP_IDENTITY,
    });
    await rm(repoRoot, { recursive: true, force: true });
  }, 120_000);

  async function isolatedProjectIssue(issueSettings: Record<string, unknown> | null) {
    const f = await setup();
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-resume-repo-"));
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repoRoot });
    await git(["init"]);
    await git(["checkout", "-B", "master"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(path.join(repoRoot, "README.md"), "x\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "init"]);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, companyId: f.companyId, name: "Isolated", status: "active",
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
    });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId: f.companyId, projectId, name: "Primary", cwd: repoRoot, isPrimary: true });
    await db.update(issues).set({ projectId, identifier: `MR-${Math.floor(Math.random() * 1e6)}`, executionWorkspaceSettings: issueSettings }).where(eq(issues.id, f.issueId));
    return { ...f, repoRoot };
  }

  it("L0013e: a pre-policy issue (no persisted workspace settings) resumes after run 1 binds its first workspace", async () => {
    const f = await isolatedProjectIssue(null);
    try {
      const sid = randomUUID();
      adapterExecute.mockClear();
      nextResult(sid);
      await runOnce(f.agentId, f.issueId, { reason: "issue_assigned", source: "assignment" });
      await storedSession(f.agentId);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound?.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" }); // materialized by run 1

      adapterExecute.mockClear();
      nextResult(sid);
      const run2 = await runOnce(f.agentId, f.issueId);
      const input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null } };
      expect(input.runtime.sessionId).toBe(sid);
      expect(await runLog(run2)).not.toContain("Skipping saved session resume");
    } finally {
      await rm(f.repoRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("L0013e: a real change to existing workspace settings still resets the session", async () => {
    const f = await isolatedProjectIssue({ mode: "isolated_workspace" });
    try {
      const sid = randomUUID();
      adapterExecute.mockClear();
      nextResult(sid);
      await runOnce(f.agentId, f.issueId, { reason: "issue_assigned", source: "assignment" });
      await storedSession(f.agentId);
      await db.update(issues).set({
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceRuntime: { profile: "changed" } },
      }).where(eq(issues.id, f.issueId));

      adapterExecute.mockClear();
      nextResult(randomUUID());
      const run2 = await runOnce(f.agentId, f.issueId);
      const input = adapterExecute.mock.calls[0]?.[0] as { runtime: { sessionId: string | null } };
      expect(input.runtime.sessionId).toBeNull();
      expect(await runLog(run2)).toContain("workspace config");
    } finally {
      await rm(f.repoRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
