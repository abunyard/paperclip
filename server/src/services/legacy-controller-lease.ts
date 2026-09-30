import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;

type Run = typeof heartbeatRuns.$inferSelect;

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return false;
  const [owner] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return Boolean(owner);
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent. */
export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return true;
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(revoked);
}

/** Abort the adapter if the controller cannot renew. Bound each check by the
 * lease duration even when the database connection never settles. */
export function watchLegacyControllerLease(db: Db, run: Run, controller: AbortController) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  let stopped = false;
  let pending = false;
  let lastRenewedAt = Date.now();
  // L0007: record WHY the controller aborts. Without this the run ends as a generic
  // adapter "Cancelled" (errorCode "cancelled") and the lease loss is invisible.
  const lost = (cause: unknown = "deadline") => {
    if (stopped || controller.signal.aborted) return;
    const causeText = cause instanceof Error ? cause.message : String(cause);
    const reason = `Legacy controller lease lost (${causeText})`;
    logger.warn({
      event: "legacy_controller_lease_lost",
      runId: run.id,
      companyId: run.companyId,
      cause: causeText,
      renewalPending: pending,
      msSinceLastRenewal: Date.now() - lastRenewedAt,
      leaseMs: LEGACY_CONTROLLER_LEASE_MS,
      renewMs: LEGACY_CONTROLLER_RENEW_MS,
    }, "legacy controller lease lost; aborting adapter");
    // Best effort: persist the reason so run finalization (which prefers the stored
    // error/errorCode for cancelled runs) reports it instead of the adapter's "Cancelled".
    // Deferred and fully guarded: a hung or failing DB must never delay or break the abort below.
    void Promise.resolve()
      .then(() => db.update(heartbeatRuns).set({ error: reason, errorCode: "controller_lease_lost", updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running"))))
      .catch(() => undefined);
    controller.abort(new Error(reason));
  };
  let deadline = setTimeout(() => lost("initial lease deadline"), Math.max(0,
    (run.controllerLeaseExpiresAt?.getTime() ?? 0) - Date.now()));
  deadline.unref();
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost("renewal returned no row (lease expired or taken over)");
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    lastRenewedAt = Date.now();
    if (!stopped) {
      clearTimeout(deadline);
      deadline = setTimeout(() => lost("renewal deadline (no successful renewal within lease)"), Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt)));
      deadline.unref();
    }
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch((err) => lost(err ?? "renewal error")).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}
