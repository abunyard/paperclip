import { z } from "zod";

/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion(
  "connectionPurpose",
  [
    z.object({
      connectionPurpose: z.literal("tool"),
      transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
      connectionPurpose: z.literal("channel"),
      transport: z.enum(["chat_sdk", "rest_api"]),
      config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine(
      (connection) => connection.transport === "chat_sdk" || connection.config?.provider === "agentmail",
      { message: "REST channel connections require the AgentMail provider", path: ["config", "provider"] },
    ),
    z.object({
      connectionPurpose: z.literal("ai"),
      transport: z.literal("runtime_auth"),
    }),
  ],
);
export type ConnectionPurposeTransport = z.infer<
  typeof connectionPurposeTransportSchema
>;

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "xai",
  // wabnet fork: a user-configured Anthropic Messages endpoint (MiniMax, Alibaba
  // Token Plan, an LLM gateway). Routing lives in the connection's endpoint config.
  "anthropic_compatible",
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiAuthMethod = z.infer<typeof aiAuthMethodSchema>;
const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: aiProviderSchema,
    // Retained on the wire for older servers during rolling upgrades. The
    // responsible user's provider default determines the actual run method.
    method: aiAuthMethodSchema,
    mode: z.literal("responsible_user"),
  }).strict(),
  z
    .object({
      ...requirement,
      mode: z.literal("shared"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requirement,
      // Legacy wire format only; human access still applies. New UI never creates it.
      mode: z.literal("delegated"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
]);
export type AiConnectionBinding = z.infer<typeof aiConnectionBindingSchema>;
export const aiConnectionMetadataSchema = z.object(requirement).strict();
export type AiConnectionMetadata = z.infer<typeof aiConnectionMetadataSchema>;

/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES: Record<
  AiProvider,
  {
    name: string;
    methods: Partial<
      Record<AiAuthMethod, { adapters: readonly string[]; envKey: string }>
    >;
  }
> = {
  anthropic: {
    name: "Claude",
    methods: {
      subscription: {
        adapters: ["claude_local"],
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_API_KEY" },
    },
  },
  openai: {
    name: "OpenAI",
    methods: {
      subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openrouter: {
    name: "OpenRouter",
    methods: {
      api_key: { adapters: ["opencode_local"], envKey: "OPENROUTER_API_KEY" },
    },
  },
  xai: {
    name: "Grok",
    methods: {
      subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
      api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
    },
  },
  anthropic_compatible: {
    name: "Anthropic-compatible endpoint",
    methods: {
      // Default credential variable. An endpoint with authHeader "x-api-key"
      // receives ANTHROPIC_API_KEY instead (see anthropicCompatibleCredentialEnvKey).
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_AUTH_TOKEN" },
    },
  },
};

/** Presets fill the endpoint form. They are suggestions; the saved endpoint is authoritative. */
export const ANTHROPIC_COMPATIBLE_PRESETS = {
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    biller: "minimax",
    // Probed 2026-09-29: GET /v1/models returns the model list (Bearer or x-api-key).
    discovery: "v1_models",
  },
  alibaba_token_plan: {
    label: "Alibaba Token Plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    biller: "alibaba_token_plan",
    // Probed 2026-09-29: GET /v1/models returns 403 AccessDenied.Unpurchased; list models by hand.
    discovery: "manual",
  },
  switchyard: {
    label: "Switchyard",
    baseUrl: "http://127.0.0.1:4000",
    biller: "switchyard",
    discovery: "manual",
  },
  custom: { label: "Custom", baseUrl: "", biller: "custom_gateway", discovery: "manual" },
} as const;
export const ANTHROPIC_COMPATIBLE_PRESET_IDS = ["minimax", "alibaba_token_plan", "switchyard", "custom"] as const;
export type AnthropicCompatiblePreset = (typeof ANTHROPIC_COMPATIBLE_PRESET_IDS)[number];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/**
 * An endpoint base URL must be https, or plain http on loopback only (a local gateway
 * such as Switchyard). No embedded credentials, query, or fragment.
 */
export function isAllowedAnthropicCompatibleBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

const endpointModelIdSchema = z.string().trim().min(1).max(200).regex(/^[^\s]+$/, "Model ids cannot contain spaces");
export const anthropicCompatibleEndpointSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .refine(isAllowedAnthropicCompatibleBaseUrl, {
        message: "Use an https URL (plain http only for 127.0.0.1/localhost), without credentials, query, or fragment",
      })
      .transform((value) => value.replace(/\/+$/, "")),
    authHeader: z.enum(["bearer", "x-api-key"]).default("bearer"),
    preset: z.enum(ANTHROPIC_COMPATIBLE_PRESET_IDS).default("custom"),
    models: z.array(endpointModelIdSchema).max(200).default([]),
    modelMap: z
      .object({
        main: endpointModelIdSchema.optional(),
        opus: endpointModelIdSchema.optional(),
        sonnet: endpointModelIdSchema.optional(),
        haiku: endpointModelIdSchema.optional(),
        subagent: endpointModelIdSchema.optional(),
      })
      .strict()
      .default({}),
    // Operator decision 2026-09-29: every preset bills as a fixed plan (0 cents, tokens tracked).
    billing: z
      .object({
        type: z.literal("fixed").default("fixed"),
        biller: z.string().trim().regex(/^[a-z0-9_.-]{1,64}$/, "Use lowercase letters, digits, _ . -"),
      })
      .strict(),
    clientFlags: z
      .object({
        disableExperimentalBetas: z.boolean().default(false),
        disableNonessentialTraffic: z.boolean().default(true),
      })
      .strict()
      .default({ disableExperimentalBetas: false, disableNonessentialTraffic: true }),
  })
  .strict();
export type AnthropicCompatibleEndpoint = z.infer<typeof anthropicCompatibleEndpointSchema>;
export type AnthropicCompatibleEndpointInput = z.input<typeof anthropicCompatibleEndpointSchema>;

/** Which env var carries the endpoint credential (Claude Code: bearer -> ANTHROPIC_AUTH_TOKEN, x-api-key -> ANTHROPIC_API_KEY). */
export function anthropicCompatibleCredentialEnvKey(endpoint: Pick<AnthropicCompatibleEndpoint, "authHeader">) {
  return endpoint.authHeader === "x-api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
}
export function isAiConnectionCompatible(
  requirement: AiConnectionMetadata | AiConnectionBinding,
  adapterType: string,
  model?: unknown,
  runnerProvider?: unknown,
  acpxAgent?: unknown,
): boolean {
  if (adapterType === "paperclip_runner")
    adapterType =
      runnerProvider === "claude" ||
      (runnerProvider === "acpx" && acpxAgent === "claude")
        ? "claude_local"
        : runnerProvider === "codex"
          ? "codex_local"
          : runnerProvider === "opencode"
            ? "opencode_local"
            : "unsupported";
  const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
  const candidates = "mode" in requirement && requirement.mode === "responsible_user"
    ? Object.values(methods)
    : requirement.method ? [methods[requirement.method]] : [];
  return (
    candidates.some((method) => method?.adapters.includes(adapterType)) &&
    (requirement.provider !== "openrouter" ||
      (typeof model === "string" && model.startsWith("openrouter/")))
  );
}
export type AiConnectionUnavailableReason =
  | "responsible_user_missing"
  | "membership_missing"
  | "default_missing"
  | "connection_missing"
  | "connection_unavailable"
  | "incompatible"
  | "access_denied"
  | "credential_missing";
export interface AiConnectionAttribution {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  mode: AiConnectionBinding["mode"];
  responsibleUserId: string | null;
}
export type AiConnectionResolution =
  | { ok: true; attribution: AiConnectionAttribution }
  | { ok: false; reason: AiConnectionUnavailableReason; message: string };

export interface AiManagedConnectionSummary {
  id: string;
  grantId: string;
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  name: string;
  accountLabel?: string;
  ownership: "personal" | "shared";
  ownerUserId?: string;
  ownerName?: string;
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
  /** anthropic_compatible only. Routing metadata; never contains the credential. */
  endpoint?: AnthropicCompatibleEndpoint;
}
export const createAiConnectionSchema = z
  .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    loginSessionId: z.string().max(128).optional(),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
    endpoint: anthropicCompatibleEndpointSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
      ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    if ((v.provider === "anthropic_compatible") !== Boolean(v.endpoint))
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: v.endpoint
          ? "Only Anthropic-compatible connections take an endpoint"
          : "An Anthropic-compatible connection needs an endpoint",
      });
    if (
      v.method === "api_key"
        ? !v.apiKey || Boolean(v.loginSessionId)
        : !v.loginSessionId || Boolean(v.apiKey)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide exactly the credential for the selected sign-in method",
      });
    }
  });
export type CreateAiConnection = z.infer<typeof createAiConnectionSchema>;

export const aiConnectionLoginIntentSchema = z
  .object({
    provider: aiProviderSchema,
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict();
export type AiConnectionLoginIntent = z.infer<
  typeof aiConnectionLoginIntentSchema
>;

export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
  localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
export interface LocalAiLoginStatus {
  status: "ready" | "sign_in_required" | "expired";
}
export interface LocalAiLoginAttempt {
  sessionId: string;
  command: string;
  expiresAt: string;
}

/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config: Record<string, unknown> | undefined): boolean {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success && metadata.data.method === "subscription" &&
    (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
    config?.aiIsolatedSubscription !== true;
}
