// wabnet local fix L0004: PATCH /agents/:id must compare AI-connection bindings
// key-order-insensitively. Postgres jsonb stores object keys in its own order
// (shorter keys first), while the zod-parsed request binding keeps schema order,
// so JSON.stringify saw an identical binding as "changed" and re-validated it.
// Re-validation fails with 422 ai_connection_default_missing when the editing
// board user has no default of their own for that provider.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { aiConnectionBindingsEqual } from "../routes/agents.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-binding-order-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "binding-order");
  database = await startEmbeddedPostgresTestDatabase("paperclip-binding-order-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("aiConnectionBindingsEqual", () => {
  it("treats a reordered binding as equal and a different binding as changed", () => {
    const parsed = { provider: "anthropic", method: "subscription", mode: "responsible_user" };
    const jsonbOrder = { mode: "responsible_user", method: "subscription", provider: "anthropic" };
    // The pre-fix comparison saw these as different.
    expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(jsonbOrder));
    expect(aiConnectionBindingsEqual(parsed, jsonbOrder)).toBe(true);
    expect(aiConnectionBindingsEqual(parsed, { ...jsonbOrder, method: "api_key" })).toBe(false);
    expect(aiConnectionBindingsEqual(parsed, undefined)).toBe(false);
  });
});

describe("PATCH /agents/:id with an unchanged AI-connection binding", () => {
  it("does not re-validate a binding that only differs in key order", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${companyId}`;
    // A second board member with no AI connection of their own.
    const editorUserId = `editor-${companyId}`;
    const binding = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;
    await db.insert(companies).values({ id: companyId, name: "Binding order", issuePrefix: `B${companyId.slice(0, 7)}`, defaultResponsibleUserId: ownerUserId });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner", status: "active" },
      { companyId, principalType: "user", principalId: editorUserId, membershipRole: "owner", status: "active" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: editorUserId, permissionKey: "agents:configure" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });

    // The stored row comes back in jsonb key order, not the schema order.
    const [stored] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, agentId));
    expect(JSON.stringify((stored!.runtimeConfig as Record<string, unknown>).aiConnection)).not.toBe(JSON.stringify(binding));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: editorUserId, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] } as Express.Request["actor"];
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const response = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { aiConnection: { mode: "responsible_user", method: "subscription", provider: "anthropic" } } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.runtimeConfig.aiConnection).toEqual(binding);
  }, 60_000);
});
