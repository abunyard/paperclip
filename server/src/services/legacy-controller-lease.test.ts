import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { hasLiveLegacyController, legacyControllerBootId, legacyControllerClaim,
  renewLegacyControllerLease, revokeExpiredLegacyController, watchLegacyControllerLease } from "./legacy-controller-lease.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable legacy controller ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-controller-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Controller test", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "claude_local", status: "idle" });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", ...legacyControllerClaim("legacy") })
      .where(eq(heartbeatRuns.id, queued.id)).returning();
    return run;
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, id));
  }
  it("commits ownership with the queued claim before provisioning or logs exist", async () => {
    const run = await seed();
    expect(run).toMatchObject({ status: "running", controllerBootId: legacyControllerBootId, executionStage: "preparing", processPid: null });
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("another deployment's startup reaper preserves an unexpired controller", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
    expect(saved.errorCode).toBeNull();
  });
  it.each([false, true])("shutdown preserves a foreign controller (expired: %s)", async expired => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    if (expired) await expire(run.id);
    const result = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    expect(result.interruptedRunIds).toEqual([]);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
  });
  it("a current controller renews and records the dispatch boundary", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.executionStage).toBe("dispatching");
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("an expired controller cannot renew or dispatch even before a reaper claims it", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); }
  });
  it("L0007: a lost lease logs why, persists the reason, and aborts with it (not a generic Cancelled)", async () => {
    const run = await seed();
    await expire(run.id);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned()).rejects.toThrow(/Legacy controller lease lost \(renewal returned no row/);
      expect((controller.signal.reason as Error).message).toMatch(/^Legacy controller lease lost \(renewal returned no row/);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "legacy_controller_lease_lost", runId: run.id, leaseMs: 60_000, renewMs: 10_000 }),
        expect.stringContaining("lease lost"),
      );
      // Finalization prefers the stored error for cancelled runs; the reason is persisted best-effort.
      await vi.waitFor(async () => {
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        expect(saved).toMatchObject({ errorCode: "controller_lease_lost", error: expect.stringContaining("renewal returned no row") });
      });
      // A second loss signal after abort is ignored (one log line, first reason kept).
      await expect(watch.assertOwned()).rejects.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { watch.stop(); warn.mockRestore(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });
  it("a crash after revocation permits a later recovery claim", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await hasLiveLegacyController(db, claimed)).toBe(true);
    expect(await revokeExpiredLegacyController(db, claimed)).toBe(false);
    await expire(run.id);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await revokeExpiredLegacyController(db, saved)).toBe(true);
  });
  it("rejects foreign company renewal and revocation", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, { ...run, companyId: randomUUID() })).toBe(false);
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });
  it("never turns a terminal run back into owned execution", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("rejects dispatch at the lease deadline even if the database query never settles", async () => {
    const run = await seed();
    const hungDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => new Promise(() => {}) }) }) }) } as unknown as typeof db;
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(hungDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 100) }, controller);
    try {
      const checked = expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(101);
      await checked;
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("leaves native controller ownership to the native coordinator", () => {
    expect(legacyControllerClaim("native")).toEqual({});
  });
});
