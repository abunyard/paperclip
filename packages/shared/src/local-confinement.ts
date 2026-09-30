// wabnet L0009: the adapterConfig keys that define (or can bypass) local bwrap confinement.
export const LOCAL_CONFINEMENT_KEYS = [
  "engine",
  "command",
  "agentCommand",
  "extraArgs",
  "filesystemScope",
  "filesystemExtraPaths",
  "filesystemSandboxCommand",
  "filesystemBindSyslog",
  "filesystemPnpmStore",
  "networkScope",
  "networkAllowlist",
] as const;
export type LocalConfinementKey = (typeof LOCAL_CONFINEMENT_KEYS)[number];

/** Adapters whose runs can be confined with bwrap (and so can be required to be). */
export const LOCAL_CONFINEMENT_ADAPTER_TYPES = ["claude_local", "codex_local"] as const;

function stable(value: unknown): string {
  if (value === undefined) return "<absent>";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Confinement keys whose effective value differs between two adapterConfigs (added, changed or removed). */
export function changedLocalConfinementKeys(before: unknown, after: unknown): LocalConfinementKey[] {
  const a = record(before);
  const b = record(after);
  return LOCAL_CONFINEMENT_KEYS.filter((key) => stable(a[key]) !== stable(b[key]));
}

/** Confinement keys present (non-null) before and absent or null after. */
export function droppedLocalConfinementKeys(before: unknown, after: unknown): LocalConfinementKey[] {
  const a = record(before);
  const b = record(after);
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return LOCAL_CONFINEMENT_KEYS.filter((key) => present(a[key]) && !present(b[key]));
}

/** The confinement subset of an adapterConfig (for inheritance by agent-created agents). */
export function pickLocalConfinement(config: unknown): Partial<Record<LocalConfinementKey, unknown>> {
  const source = record(config);
  const out: Partial<Record<LocalConfinementKey, unknown>> = {};
  for (const key of LOCAL_CONFINEMENT_KEYS) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** True when a config is confined enough for requireLocalConfinement. */
export function isLocallyConfined(config: unknown): boolean {
  const c = record(config);
  return c.filesystemScope === "workspace" && (c.networkScope === "deny" || c.networkScope === "allowlist");
}
