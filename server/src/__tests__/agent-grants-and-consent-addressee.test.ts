// wabnet L0011: (a) PUT/GET /agents/:id/grants for existing agents; (b) an agent's change-consent
// confirmation is addressed to one human (default: the company's responsible owner user).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { agentProfileChangeTargetKey, isChangeConsentTargetKey } from "../services/change-consent-gate.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();
const otherAgentId = randomUUID();
const issueId = randomUUID();
const manager = "manager-user";
const plain = "plain-user";

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-l0011-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "l0011");
  database = await startEmbeddedPostgresTestDatabase("paperclip-l0011-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Grants", issuePrefix: "GRT", defaultResponsibleUserId: manager });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: manager, membershipRole: "owner", status: "active" },
    { companyId, principalType: "user", principalId: plain, membershipRole: "member", status: "active" },
  ]);
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: manager, permissionKey: "users:manage_permissions" });
  await db.insert(agents).values([
    { id: agentId, companyId, name: "Master of Puppets", role: "ceo", adapterType: "claude_local" },
    { id: otherAgentId, companyId, name: "The Oracle", role: "general", adapterType: "claude_local" },
  ]);
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId, permissionKey: "tasks:assign" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Proposal", status: "in_progress", priority: "medium", identifier: "GRT-1", issueNumber: 1, createdByAgentId: agentId });
}, 90_000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

function app(actor: Record<string, unknown>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
  server.use("/api", agentRoutes(db));
  server.use(errorHandler);
  return server;
}
const board = (userId: string, role = "owner") => ({
  type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }],
});
const grantKeys = async (id: string) =>
  (await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, id)))).map((g) => g.permissionKey).sort();

describe("PUT /agents/:id/grants (L0011a)", () => {
  it("merges new grants into an existing agent's grants and logs before/after", async () => {
    const res = await request(app(board(manager))).put(`/api/agents/${agentId}/grants`).send({ grants: [{ permissionKey: "agents:suggest-changes" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantKeys(agentId)).toEqual(["agents:suggest-changes", "tasks:assign"]);
    const [entry] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.grants_updated")));
    expect(entry?.details).toMatchObject({ replace: false, before: ["tasks:assign"], after: ["agents:suggest-changes", "tasks:assign"] });
    const read = await request(app(board(manager))).get(`/api/agents/${agentId}/grants`);
    expect(read.body.grants.map((g: { permissionKey: string }) => g.permissionKey).sort()).toEqual(["agents:suggest-changes", "tasks:assign"]);
  });

  it("replaces only when explicit, keeping tasks:assign (owned by PATCH /permissions)", async () => {
    await request(app(board(manager))).put(`/api/agents/${agentId}/grants`).send({ grants: [{ permissionKey: "skills:suggest-changes" }] });
    const res = await request(app(board(manager))).put(`/api/agents/${agentId}/grants`).send({ grants: [{ permissionKey: "skills:suggest-changes" }], replace: true });
    expect(res.status).toBe(200);
    expect(await grantKeys(agentId)).toEqual(["skills:suggest-changes", "tasks:assign"]);
  });

  it.each(["users:manage_permissions", "users:invite", "joins:approve"])("refuses %s (it would let the agent confer grants)", async (key) => {
    const res = await request(app(board(manager))).put(`/api/agents/${otherAgentId}/grants`).send({ grants: [{ permissionKey: key }] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("agent_grant_refused");
    expect(await grantKeys(otherAgentId)).toEqual([]);
  });

  it("refuses tasks:assign (managed elsewhere) and unknown keys", async () => {
    expect((await request(app(board(manager))).put(`/api/agents/${otherAgentId}/grants`).send({ grants: [{ permissionKey: "tasks:assign" }] })).status).toBe(422);
    expect((await request(app(board(manager))).put(`/api/agents/${otherAgentId}/grants`).send({ grants: [{ permissionKey: "root:everything" }] })).status).toBe(400);
  });

  it("is board-only and needs users:manage_permissions", async () => {
    const agentActor = { type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_jwt" };
    expect((await request(app(agentActor)).put(`/api/agents/${agentId}/grants`).send({ grants: [{ permissionKey: "agents:configure" }] })).status).toBe(403);
    const denied = await request(app(board(plain, "member"))).put(`/api/agents/${otherAgentId}/grants`).send({ grants: [{ permissionKey: "agents:suggest-changes" }] });
    expect(denied.status).toBe(403);
    expect(await grantKeys(otherAgentId)).toEqual([]);
    const local = await request(app({ type: "board", source: "local_implicit", userId: "local-board", companyIds: [companyId], isInstanceAdmin: true }))
      .put(`/api/agents/${otherAgentId}/grants`).send({ grants: [{ permissionKey: "agents:suggest-changes" }] });
    expect(local.status).toBe(200);
  });
});

describe("change-consent addressee (L0011b)", () => {
  const consentInput = (extra: Record<string, unknown> = {}) => ({
    kind: "request_confirmation" as const,
    continuationPolicy: "wake_assignee" as const,
    payload: { version: 1 as const, prompt: "Apply this profile change?", detailsMarkdown: "```diff\n+new description\n```", target: { type: "custom" as const, key: agentProfileChangeTargetKey(otherAgentId) } },
    ...extra,
  });

  it("recognizes current and legacy consent target keys", () => {
    expect(isChangeConsentTargetKey(agentProfileChangeTargetKey("a"))).toBe(true);
    expect(isChangeConsentTargetKey("agent:a:instructions")).toBe(true);
    expect(isChangeConsentTargetKey("skill:s")).toBe(true);
    expect(isChangeConsentTargetKey("reflection-coach:agent-description:a")).toBe(true);
    expect(isChangeConsentTargetKey("deploy:prod")).toBe(false);
  });

  it("defaults an agent's consent request to the company's responsible owner", async () => {
    const created = await issueThreadInteractionService(db).create({ id: issueId, companyId }, consentInput(), { agentId, runId: randomUUID() });
    expect(created.addresseeUserId).toBe(manager);
  });

  it("keeps an explicit human addressee and refuses an agent addressee", async () => {
    const explicit = await issueThreadInteractionService(db).create({ id: issueId, companyId }, consentInput({ addresseeUserId: plain }), { agentId, runId: randomUUID() });
    expect(explicit.addresseeUserId).toBe(plain);
    await expect(issueThreadInteractionService(db).create({ id: issueId, companyId }, consentInput({ addresseeAgentId: otherAgentId }), { agentId, runId: randomUUID() }))
      .rejects.toMatchObject({ details: { code: "change_consent_addressee_user_required" } });
  });

  it("leaves non-consent confirmations alone", async () => {
    const other = await issueThreadInteractionService(db).create(
      { id: issueId, companyId },
      { kind: "request_confirmation", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Ship it?" } },
      { agentId, runId: randomUUID() },
    );
    expect(other.addresseeUserId ?? null).toBeNull();
  });
});
