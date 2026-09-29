// wabnet fork: runtime + probe logic for `anthropic_compatible` AI connections.
// A connection holds one credential (a secret) plus endpoint routing metadata in
// tool_connections.config.aiEndpoint. Nothing here returns or logs the credential.
import {
  anthropicCompatibleCredentialEnvKey,
  anthropicCompatibleEndpointSchema,
  type AnthropicCompatibleEndpoint,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const PROBE_TIMEOUT_MS = 15_000;

/** Parse the endpoint stored on a connection; a missing or invalid endpoint fails closed. */
export function endpointFromConnectionConfig(config: unknown): AnthropicCompatibleEndpoint {
  const stored = (config as { aiEndpoint?: unknown } | null | undefined)?.aiEndpoint;
  const parsed = anthropicCompatibleEndpointSchema.safeParse(stored);
  if (!parsed.success)
    throw unprocessable("This Anthropic-compatible connection has no valid endpoint. Reconnect it.", {
      code: "ai_connection_incompatible",
    });
  return parsed.data;
}

function authHeaders(endpoint: Pick<AnthropicCompatibleEndpoint, "authHeader">, credential: string): Record<string, string> {
  return endpoint.authHeader === "x-api-key"
    ? { "x-api-key": credential, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${credential}`, "anthropic-version": "2023-06-01" };
}

/** A short, credential-free excerpt of a provider error body for the operator. */
async function safeErrorExcerpt(response: Response, credential: string): Promise<string> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const candidate = parsed?.error?.message ?? parsed?.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    /* non-JSON body */
  }
  return message.split(credential).join("[redacted]").replace(/\s+/g, " ").trim().slice(0, 200);
}

function probeModel(endpoint: AnthropicCompatibleEndpoint): string {
  const model = endpoint.modelMap.main ?? endpoint.models[0];
  if (!model) throw unprocessable("Add at least one model (or a main model) before testing this endpoint.");
  return model;
}

/**
 * Verify URL + credential + model with a one-token Messages request, the check the
 * Claude Code gateway docs give. Consumes at most one output token of the key's quota.
 */
export async function probeAnthropicCompatibleEndpoint(
  endpoint: AnthropicCompatibleEndpoint,
  credential: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const model = probeModel(endpoint);
  let response: Response;
  try {
    response = await request(`${endpoint.baseUrl}/v1/messages`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { ...authHeaders(endpoint, credential), "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
    });
  } catch {
    throw unprocessable("Could not reach the endpoint. Check the base URL and network path.");
  }
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const excerpt = await safeErrorExcerpt(response, credential);
  if (response.status === 401)
    throw unprocessable(`The endpoint rejected this key (401). If the gateway expects x-api-key, switch the auth header.${excerpt ? ` ${excerpt}` : ""}`);
  throw unprocessable(`The endpoint refused the test request (${response.status})${excerpt ? `: ${excerpt}` : "."}`);
}

/**
 * List models from GET /v1/models. Unlike Claude Code's own gateway discovery, this
 * keeps every id (Claude Code keeps only ids containing "claude"/"anthropic").
 */
export async function discoverAnthropicCompatibleModels(
  endpoint: Pick<AnthropicCompatibleEndpoint, "baseUrl" | "authHeader">,
  credential: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await request(`${endpoint.baseUrl}/v1/models?limit=1000`, {
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: authHeaders(endpoint, credential),
    });
  } catch {
    throw unprocessable("Could not reach the endpoint. Check the base URL and network path.");
  }
  if (!response.ok) {
    const excerpt = await safeErrorExcerpt(response, credential);
    throw unprocessable(
      `This endpoint does not list models (${response.status})${excerpt ? `: ${excerpt}` : ""}. Enter model ids by hand.`,
    );
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  const ids = (body?.data ?? [])
    .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
    .filter((id) => id.length > 0 && id.length <= 200 && !/\s/.test(id));
  return [...new Set(ids)].slice(0, 200);
}

/**
 * The env a claude_local run receives for an anthropic_compatible connection.
 * Applied after every AI auth key was blanked, so no other credential leaks through.
 * The agent's own model setting wins over the connection's main model.
 */
export function anthropicCompatibleRuntimeEnv(
  endpoint: AnthropicCompatibleEndpoint,
  credential: string,
  agentModel?: unknown,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    [anthropicCompatibleCredentialEnvKey(endpoint)]: credential,
  };
  const main = typeof agentModel === "string" && agentModel.trim() ? agentModel.trim() : endpoint.modelMap.main;
  if (main) env.ANTHROPIC_MODEL = main;
  if (endpoint.modelMap.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = endpoint.modelMap.opus;
  if (endpoint.modelMap.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = endpoint.modelMap.sonnet;
  if (endpoint.modelMap.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = endpoint.modelMap.haiku;
  if (endpoint.modelMap.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = endpoint.modelMap.subagent;
  if (endpoint.clientFlags.disableNonessentialTraffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (endpoint.clientFlags.disableExperimentalBetas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  return env;
}

/** Billing identity handed to the adapter via config.managedAiConnection.endpointBilling. */
export function anthropicCompatibleBilling(endpoint: AnthropicCompatibleEndpoint) {
  return { type: endpoint.billing.type, biller: endpoint.billing.biller };
}
