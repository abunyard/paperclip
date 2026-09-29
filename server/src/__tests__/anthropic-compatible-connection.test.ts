// wabnet fork: anthropic_compatible AI connections (endpoint routing, env injection, billing,
// probes) and the env-agent migration. Credentials are fixtures and must never appear in output.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { agents, agentConfigRevisions, companies, companyMemberships, companySecrets, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import {
  ANTHROPIC_COMPATIBLE_PRESETS,
  anthropicCompatibleEndpointSchema,
  createAiConnectionSchema,
  isAiConnectionCompatible,
  isAllowedAnthropicCompatibleBaseUrl,
} from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import {
  anthropicCompatibleRuntimeEnv,
  discoverAnthropicCompatibleModels,
  probeAnthropicCompatibleEndpoint,
} from "../services/anthropic-compatible-endpoint.js";
import { planEnvAgentMigration, type MigrationAgentRow } from "../services/anthropic-compatible-migration.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";

const KEY = "fixture-gateway-key-0123456789";
const endpointInput = {
  baseUrl: "https://api.minimax.io/anthropic/",
  preset: "minimax",
  models: ["MiniMax-M3", "MiniMax-M2.7"],
  modelMap: { main: "MiniMax-M3", haiku: "MiniMax-M2.7", subagent: "MiniMax-M3" },
  billing: { biller: "minimax" },
} as const;
const endpoint = anthropicCompatibleEndpointSchema.parse(endpointInput);

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();
const owner = "owner-user";

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-anthropic-compatible-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "anthropic-compatible");
  database = await startEmbeddedPostgresTestDatabase("paperclip-anthropic-compatible-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Compatible", issuePrefix: "ACX" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Gateway worker", adapterType: "claude_local" });
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "owner" });
}, 90_000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: owner, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] } as Express.Request["actor"];
    next();
  });
  server.use("/api", aiConnectionRoutes(db));
  server.use(errorHandler);
  return server;
}

describe("anthropic_compatible schema", () => {
  it("is claude_local-only, api_key-only, and needs an endpoint", () => {
    const binding = { provider: "anthropic_compatible", method: "api_key", mode: "responsible_user" } as const;
    expect(isAiConnectionCompatible(binding, "claude_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "codex_local")).toBe(false);
    const base = { provider: "anthropic_compatible", method: "api_key", name: "MiniMax", ownership: "shared", apiKey: KEY } as const;
    expect(createAiConnectionSchema.safeParse(base).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...base, endpoint: endpointInput }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...base, method: "subscription", endpoint: endpointInput }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ provider: "anthropic", method: "api_key", name: "x", ownership: "personal", apiKey: KEY, endpoint: endpointInput }).success).toBe(false);
  });

  it("allows https, or http only on loopback, and normalizes the base URL", () => {
    expect(isAllowedAnthropicCompatibleBaseUrl(ANTHROPIC_COMPATIBLE_PRESETS.alibaba_token_plan.baseUrl)).toBe(true);
    expect(isAllowedAnthropicCompatibleBaseUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isAllowedAnthropicCompatibleBaseUrl("http://localhost:4000")).toBe(true);
    expect(isAllowedAnthropicCompatibleBaseUrl("http://10.0.0.5:4000")).toBe(false);
    expect(isAllowedAnthropicCompatibleBaseUrl("https://user:pw@gateway.example")).toBe(false);
    expect(isAllowedAnthropicCompatibleBaseUrl("https://gateway.example/?key=1")).toBe(false);
    expect(endpoint.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(endpoint.billing).toEqual({ type: "fixed", biller: "minimax" });
    expect(endpoint.clientFlags).toEqual({ disableExperimentalBetas: false, disableNonessentialTraffic: true });
  });
});

describe("runtime env", () => {
  it("routes through the endpoint with the key in the variable its auth header needs", () => {
    expect(anthropicCompatibleRuntimeEnv(endpoint, KEY)).toEqual({
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "MiniMax-M3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.7",
      CLAUDE_CODE_SUBAGENT_MODEL: "MiniMax-M3",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const xApiKey = anthropicCompatibleRuntimeEnv({ ...endpoint, authHeader: "x-api-key" }, KEY, "MiniMax-M2.7");
    expect(xApiKey.ANTHROPIC_API_KEY).toBe(KEY);
    expect(xApiKey.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(xApiKey.ANTHROPIC_MODEL).toBe("MiniMax-M2.7");
  });

  it("prepares a claude_local run from a shared connection, blanking every other credential", async () => {
    const service = aiConnectionService(db);
    const saved = await service.save(companyId, owner, { provider: "anthropic_compatible", method: "api_key", name: "MiniMax direct", ownership: "shared", apiKey: KEY, agentIds: [agentId], allAgents: false, endpoint }, KEY);
    const binding = { provider: "anthropic_compatible", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId } as const;
    const run = await prepareManagedAiRuntime(db, {
      companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding,
      config: { model: "MiniMax-M2.7", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "agent-override", ANTHROPIC_API_KEY: "ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient", KEEP_ME: "1" } },
    });
    try {
      const env = run.config.env as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
      expect(env.ANTHROPIC_API_KEY).toBe("");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
      expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.7"); // agent model wins over modelMap.main
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("agent-override"); // per-agent override kept
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("MiniMax-M2.7");
      expect(env.KEEP_ME).toBe("1");
      expect(run.config.managedAiConnection).toMatchObject({ provider: "anthropic_compatible", endpointBilling: { type: "fixed", biller: "minimax" } });
    } finally { await run.cleanup(); }
    // An agent may not route itself while bound to a connection.
    await expect(prepareManagedAiRuntime(db, {
      companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding,
      config: { env: { ANTHROPIC_BASE_URL: "https://elsewhere.example" } },
    })).rejects.toMatchObject({ details: { code: "ai_connection_incompatible" } });
    // The list exposes the endpoint, never the credential.
    const listed = (await service.list(companyId, owner)).find((c) => c.id === saved.connectionId);
    expect(listed?.endpoint?.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(JSON.stringify(await service.list(companyId, owner))).not.toContain(KEY);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.connectionId));
    expect(JSON.stringify(row.config)).not.toContain(KEY);
  });
});

describe("endpoint probes", () => {
  it("tests with a one-token Messages call and redacts the key from provider errors", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await probeAnthropicCompatibleEndpoint(endpoint, KEY, fetchMock as unknown as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "MiniMax-M3", max_tokens: 1 });
    expect(init.redirect).toBe("error");
    const denied = vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 }));
    const error = await probeAnthropicCompatibleEndpoint(endpoint, KEY, denied as unknown as typeof fetch).catch((e: Error) => e);
    expect(String((error as Error).message)).toContain("401");
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("keeps non-Claude model ids from /v1/models and explains endpoints that do not list", async () => {
    const listing = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M3" }, { id: "claude-x" }, { id: "has space" }, {}] })));
    await expect(discoverAnthropicCompatibleModels(endpoint, KEY, listing as unknown as typeof fetch)).resolves.toEqual(["MiniMax-M3", "claude-x"]);
    const alibaba = vi.fn(async () => new Response(JSON.stringify({ code: "AccessDenied.Unpurchased", message: "Access to model denied." }), { status: 403 }));
    await expect(discoverAnthropicCompatibleModels(endpoint, KEY, alibaba as unknown as typeof fetch)).rejects.toThrow(/does not list models \(403\).*by hand/);
  });

  it("creates a connection through the route, verifying against the endpoint, without echoing the key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await request(app()).post(`/api/companies/${companyId}/ai-connections`).send({
      provider: "anthropic_compatible", method: "api_key", name: "Via route", ownership: "shared", apiKey: KEY, agentIds: [], allAgents: false, endpoint: endpointInput,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain(KEY);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.minimax.io/anthropic/v1/messages");
    const models = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/models`).send({ endpoint: endpointInput, apiKey: KEY });
    expect(models.status).toBe(200);
  });
});

describe("env-agent migration", () => {
  const gatewayEnv = (token: string, model: string, extra: Record<string, unknown> = {}) => ({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ...extra,
  });
  const row = (name: string, env: Record<string, unknown>, over: Partial<MigrationAgentRow> = {}): MigrationAgentRow => ({
    id: randomUUID(), name, companyId, adapterType: "claude_local", status: "idle", adapterConfig: { model: env.ANTHROPIC_MODEL, env }, runtimeConfig: {}, ...over,
  });

  it("plans one connection per (endpoint, token) and never prints the token", () => {
    const rows = [
      row("a-m3", gatewayEnv("token-one", "MiniMax-M3")),
      row("b-qwen", gatewayEnv("token-one", "qwen3.8-max")),
      row("c-dup", gatewayEnv("token-two", "MiniMax-M3", { ANTHROPIC_API_KEY: "token-two" })),
      row("d-ref", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: randomUUID() } }),
      row("e-dead", gatewayEnv("token-one", "x"), { status: "terminated" }),
      row("f-plain-claude", {}),
    ];
    const plan = planEnvAgentMigration(companyId, rows);
    expect(plan.groups.map((g) => g.agents.map((a) => a.name))).toEqual([["a-m3", "b-qwen"], ["c-dup"]]);
    expect(plan.groups[0]).toMatchObject({ baseUrl: "http://127.0.0.1:4000", preset: "switchyard", biller: "switchyard", authHeader: "bearer", models: ["MiniMax-M3", "qwen3.8-max"] });
    expect(plan.groups[0]!.agents[0]).toMatchObject({ removeKeys: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"], keptModelKeys: ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"] });
    expect(plan.groups[1]!.warnings[0]).toContain("duplicates the bearer token");
    expect(plan.skipped.map((s) => s.name)).toEqual(["d-ref", "e-dead"]);
    expect(JSON.stringify(plan)).not.toMatch(/token-one|token-two/);
    expect(planEnvAgentMigration(companyId, [...rows].reverse()).planHash).toBe(plan.planHash);
  });

  it("dry-runs, refuses a stale hash, then applies exactly the reviewed plan", async () => {
    const ids = [randomUUID(), randomUUID()];
    await db.insert(agents).values([
      { id: ids[0]!, companyId, name: "zz-mig-1", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M3", env: gatewayEnv(KEY, "MiniMax-M3") } },
      { id: ids[1]!, companyId, name: "zz-mig-2", adapterType: "claude_local", adapterConfig: { model: "glm-5.2", env: gatewayEnv(KEY, "glm-5.2", { KEEP_ME: "1" }) } },
    ]);
    const dry = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({});
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(JSON.stringify(dry.body)).not.toContain(KEY);
    const [unchanged] = await db.select().from(agents).where(eq(agents.id, ids[0]!));
    expect((unchanged.adapterConfig as { env: Record<string, unknown> }).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    const stale = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({ apply: true, planHash: "0000000000000000" });
    expect(stale.status).toBe(422);
    const applied = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({ apply: true, planHash: dry.body.planHash });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    for (const id of ids) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      const env = (agent.adapterConfig as { env: Record<string, unknown> }).env;
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_MODEL).toBeDefined();
      expect((agent.runtimeConfig as { aiConnection: { provider: string; mode: string } }).aiConnection).toMatchObject({ provider: "anthropic_compatible", mode: "shared" });
      const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, id));
      expect(revisions.some((r) => r.source === "anthropic_compatible_migration")).toBe(true);
    }
    const [second] = await db.select().from(agents).where(eq(agents.id, ids[1]!));
    // The agent service stores env as bindings; the unrelated key survives either way.
    expect(JSON.stringify((second.adapterConfig as { env: Record<string, unknown> }).env.KEEP_ME)).toMatch(/"1"|"value":"1"/);
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(JSON.stringify(secrets)).not.toContain(KEY); // stored encrypted
    // Idempotent: the migrated agents no longer match.
    const again = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({});
    expect(again.body.groups.flatMap((g: { agents: { name: string }[] }) => g.agents.map((a) => a.name))).not.toContain("zz-mig-1");
    // The migrated agent runs through its new connection.
    const [migrated] = await db.select().from(agents).where(eq(agents.id, ids[0]!));
    const run = await prepareManagedAiRuntime(db, {
      companyId, agentId: ids[0]!, responsibleUserId: owner, adapterType: "claude_local",
      binding: (migrated.runtimeConfig as { aiConnection: never }).aiConnection,
      config: migrated.adapterConfig as Record<string, unknown>,
    });
    try {
      const env = run.config.env as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
      expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3");
      expect(run.config.managedAiConnection).toMatchObject({ endpointBilling: { type: "fixed", biller: "switchyard" } });
    } finally { await run.cleanup(); }
  }, 60_000);

  it("refuses to apply while a planned agent is running", async () => {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "zz-running", adapterType: "claude_local", status: "running", adapterConfig: { env: gatewayEnv("other-token", "m") } });
    const dry = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({});
    const applied = await request(app()).post(`/api/companies/${companyId}/ai-connections/anthropic-compatible/migrate-env-agents`).send({ apply: true, planHash: dry.body.planHash });
    expect(applied.status).toBe(422);
    expect(JSON.stringify(applied.body)).toContain("zz-running");
  });
});
