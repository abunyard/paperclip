// wabnet L0009: local confinement settings are board-controlled.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentConfigRevisions, agents, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { changedLocalConfinementKeys, droppedLocalConfinementKeys } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const ceo = randomUUID();
const peer = randomUUID();
let runId = "";
const confined = { filesystemScope: "workspace", networkScope: "allowlist", networkAllowlist: ["127.0.0.1:4000"], filesystemExtraPaths: ["/etc/claude-code"], engine: "cli" };

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-l0009-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "l0009");
  database = await startEmbeddedPostgresTestDatabase("paperclip-l0009-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Confine", issuePrefix: "CNF", defaultResponsibleUserId: "owner", requireBoardApprovalForNewAgents: false });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
  await db.insert(agents).values([
    { id: ceo, companyId, name: "Master of Puppets", role: "ceo", adapterType: "claude_local", adapterConfig: { model: "claude-opus-5", ...confined }, permissions: { canCreateAgents: true } },
    { id: peer, companyId, name: "Peer", role: "engineer", adapterType: "claude_local", adapterConfig: { model: "m", ...confined } },
  ]);
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: ceo, status: "running" }).returning();
  runId = run!.id;
  await db.insert(principalPermissionGrants).values([
    { companyId, principalType: "agent", principalId: ceo, permissionKey: "agents:configure" },
    { companyId, principalType: "agent", principalId: ceo, permissionKey: "agents:create" },
  ]);
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
const agentActor = () => ({ type: "agent", agentId: ceo, companyId, runId, source: "agent_jwt" });
const board = { type: "board", source: "local_implicit", userId: "owner", companyIds: [companyId], isInstanceAdmin: true };
const configOf = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!.adapterConfig as Record<string, unknown>;

describe("confinement key helpers", () => {
  it("detects added, changed and removed keys, and drops", () => {
    expect(changedLocalConfinementKeys({ networkScope: "deny" }, { networkScope: "deny" })).toEqual([]);
    expect(changedLocalConfinementKeys({ networkAllowlist: ["a"] }, { networkAllowlist: ["b"] })).toEqual(["networkAllowlist"]);
    expect(changedLocalConfinementKeys({}, { filesystemBindSyslog: true })).toEqual(["filesystemBindSyslog"]);
    expect(droppedLocalConfinementKeys({ filesystemScope: "workspace" }, {})).toEqual(["filesystemScope"]);
    expect(droppedLocalConfinementKeys({ networkAllowlist: ["a"] }, { networkAllowlist: ["b"] })).toEqual([]);
  });
});

describe("agents cannot touch confinement (L0009)", () => {
  it.each([
    ["remove networkScope on itself", ceo, { adapterConfig: { networkScope: null } }],
    ["widen its own allowlist", ceo, { adapterConfig: { networkAllowlist: ["127.0.0.1:4000", "example.com"] } }],
    ["drop a peer's filesystem scope via replace", peer, { adapterConfig: { model: "m" }, replaceAdapterConfig: true }],
    ["switch a peer to the ACP engine", peer, { adapterConfig: { engine: "acp" } }],
    ["add a syslog bind to a peer", peer, { adapterConfig: { filesystemBindSyslog: true } }],
  ])("refuses an agent trying to %s", async (_label, target, body) => {
    const before = await configOf(target);
    const res = await request(app(agentActor())).patch(`/api/agents/${target}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("agent_confinement_locked");
    expect(await configOf(target)).toEqual(before);
  });

  it("lets an agent resend unchanged confinement (no-op) with another edit", async () => {
    const res = await request(app(agentActor())).patch(`/api/agents/${peer}`).send({ adapterConfig: { ...confined, model: "m2" } });
    expect(JSON.stringify(res.body)).not.toContain("agent_confinement_locked");
  });

  it("makes agent-created agents inherit the creator's confinement and refuses different values", async () => {
    const created = await request(app(agentActor())).post(`/api/companies/${companyId}/agents`).send({ name: "Hire", role: "engineer", adapterType: "claude_local", adapterConfig: { model: "m" } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const hireConfig = await configOf(created.body.id ?? created.body.agent?.id);
    expect(hireConfig).toMatchObject(confined);
    const unconfined = await request(app(agentActor())).post(`/api/companies/${companyId}/agents`).send({ name: "Hire 2", role: "engineer", adapterType: "claude_local", adapterConfig: { model: "m", networkScope: null } });
    expect(unconfined.status).toBe(403);
    expect(JSON.stringify(unconfined.body)).toContain("agent_confinement_locked");
  });
});

describe("board changes (L0009, covers #11079)", () => {
  it("keeps confinement on a merge PATCH that doesn't mention it", async () => {
    const res = await request(app(board)).patch(`/api/agents/${peer}`).send({ adapterConfig: { model: "m3" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await configOf(peer)).toMatchObject({ ...confined, model: "m3" });
  });

  it("refuses a replace that drops confinement without allowConfinementChange, and accepts it with the flag", async () => {
    const dropped = await request(app(board)).patch(`/api/agents/${peer}`).send({ adapterConfig: { model: "m4" }, replaceAdapterConfig: true });
    expect(dropped.status).toBe(422);
    expect(JSON.stringify(dropped.body)).toContain("confinement_change_requires_flag");
    expect(await configOf(peer)).toMatchObject(confined);
    const confirmed = await request(app(board)).patch(`/api/agents/${peer}`).send({ adapterConfig: { model: "m4" }, replaceAdapterConfig: true, allowConfinementChange: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((await configOf(peer)).filesystemScope).toBeUndefined();
  });

  it("lets the board tighten or re-add confinement without the flag", async () => {
    const res = await request(app(board)).patch(`/api/agents/${peer}`).send({ adapterConfig: { ...confined } });
    expect(res.status).toBe(200);
    expect(await configOf(peer)).toMatchObject(confined);
  });

  it("refuses an agent rolling a peer back to an unconfined revision", async () => {
    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, peer));
    const unconfinedRevision = revisions.find((r) => !((r.afterConfig as { adapterConfig?: Record<string, unknown> }).adapterConfig ?? {}).filesystemScope);
    expect(unconfinedRevision).toBeTruthy();
    const res = await request(app(agentActor())).post(`/api/agents/${peer}/config-revisions/${unconfinedRevision!.id}/rollback`).send({});
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("agent_confinement_locked");
    expect(await configOf(peer)).toMatchObject(confined);
  });
});
