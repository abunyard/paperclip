import type { AdapterBillingType } from "@paperclipai/adapter-utils";

export type ClaudeBillingIdentity = {
  biller: string;
  billingType: AdapterBillingType;
};

/** True when a base URL names Anthropic's own API (or is unset). */
export function isAnthropicApiBaseUrl(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function gatewayBiller(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase() || "custom_gateway";
  } catch {
    return "custom_gateway";
  }
}

/**
 * Classify a Claude run for the cost ledger from the env the CLI will see.
 *
 * A credential variable routed to a non-Anthropic `ANTHROPIC_BASE_URL` is a
 * third-party gateway credential, not a claude.ai subscription. Claude Code
 * docs: while a gateway credential (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
 * or apiKeyHelper) is active, requests carry that credential instead of the
 * subscription login and are billed to whoever owns it. Previously any run
 * without `ANTHROPIC_API_KEY` was recorded as `subscription` (0 cents), so
 * gateway runs using `ANTHROPIC_AUTH_TOKEN` never counted toward budgets.
 * A base URL with no credential variable still uses the saved subscription
 * login, so it stays `subscription`.
 */
export function resolveClaudeBillingIdentity(readEnv: (key: string) => string): ClaudeBillingIdentity {
  const bedrockFlag = readEnv("CLAUDE_CODE_USE_BEDROCK");
  if (bedrockFlag === "1" || bedrockFlag === "true" || readEnv("ANTHROPIC_BEDROCK_BASE_URL")) {
    return { biller: "aws_bedrock", billingType: "metered_api" };
  }
  const baseUrl = readEnv("ANTHROPIC_BASE_URL");
  const gateway = !isAnthropicApiBaseUrl(baseUrl);
  const biller = gateway ? gatewayBiller(baseUrl) : "anthropic";
  if (readEnv("ANTHROPIC_API_KEY")) return { biller, billingType: "api" };
  if (gateway && readEnv("ANTHROPIC_AUTH_TOKEN")) return { biller, billingType: "unknown" };
  return { biller: "anthropic", billingType: "subscription" };
}

export function readTrimmedEnv(env: Record<string, string | undefined>) {
  return (key: string): string => {
    const value = env[key];
    return typeof value === "string" ? value.trim() : "";
  };
}
