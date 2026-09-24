// `crypto.randomUUID()` is a [SecureContext] API, so it is undefined on
// non-HTTPS, non-localhost origins (for example a LAN IP served over plain
// HTTP). Fall back to a locally unique id there. Callers use the value for
// client-side attempt/idempotency bookkeeping, where a collision only needs
// to be unlikely within one browser session, not globally unique.
export function randomUuidOrFallback(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
