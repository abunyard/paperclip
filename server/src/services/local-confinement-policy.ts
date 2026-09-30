// wabnet L0009: instance policy that fails local agent runs closed when bwrap confinement is missing.
import type { Db } from "@paperclipai/db";
import { LOCAL_CONFINEMENT_ADAPTER_TYPES, isLocallyConfined } from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export interface LocalConfinementPolicy {
  required: boolean;
  exemptAgentIds: Set<string>;
}

/** Instance setting `requireLocalConfinement` (board-only), or env PAPERCLIP_REQUIRE_LOCAL_CONFINEMENT=1. */
export async function resolveLocalConfinementPolicy(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<LocalConfinementPolicy> {
  const general = await instanceSettingsService(db).getGeneral();
  const envRequired = TRUTHY.has(String(env.PAPERCLIP_REQUIRE_LOCAL_CONFINEMENT ?? "").trim().toLowerCase());
  return {
    required: envRequired || general.requireLocalConfinement === true,
    exemptAgentIds: new Set(general.localConfinementExemptAgentIds ?? []),
  };
}

/** A human-readable reason when this run must not start, else null. */
export function localConfinementViolation(
  policy: LocalConfinementPolicy,
  agent: { id: string; adapterType: string },
  config: unknown,
): string | null {
  if (!policy.required || policy.exemptAgentIds.has(agent.id)) return null;
  if (!(LOCAL_CONFINEMENT_ADAPTER_TYPES as readonly string[]).includes(agent.adapterType)) return null;
  if (isLocallyConfined(config)) return null;
  return 'Local confinement is required on this instance: set adapterConfig filesystemScope "workspace" and a networkScope ("deny" or "allowlist"), or exempt this agent.';
}
