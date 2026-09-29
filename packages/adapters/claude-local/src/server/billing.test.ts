import { describe, expect, it } from "vitest";
import { isAnthropicApiBaseUrl, resolveClaudeBillingIdentity } from "./billing.js";

const read = (env: Record<string, string>) => (key: string) => env[key]?.trim() ?? "";

describe("resolveClaudeBillingIdentity", () => {
  it("does not count a bearer token routed to a third-party gateway as a subscription", () => {
    expect(resolveClaudeBillingIdentity(read({
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
    }))).toEqual({ biller: "api.minimax.io", billingType: "unknown" });
    expect(resolveClaudeBillingIdentity(read({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
    }))).toEqual({ biller: "127.0.0.1", billingType: "unknown" });
  });

  it("names the gateway as biller for an API key routed to a third-party gateway", () => {
    expect(resolveClaudeBillingIdentity(read({
      ANTHROPIC_BASE_URL: "https://llm-gateway.example.com",
      ANTHROPIC_API_KEY: "gateway-key",
    }))).toEqual({ biller: "llm-gateway.example.com", billingType: "api" });
  });

  it("keeps first-party and subscription behavior unchanged", () => {
    expect(resolveClaudeBillingIdentity(read({ ANTHROPIC_API_KEY: "sk-ant" }))).toEqual({ biller: "anthropic", billingType: "api" });
    expect(resolveClaudeBillingIdentity(read({}))).toEqual({ biller: "anthropic", billingType: "subscription" });
    // A bearer token against Anthropic's own API is an OAuth token, not a gateway credential.
    expect(resolveClaudeBillingIdentity(read({ ANTHROPIC_AUTH_TOKEN: "oauth", ANTHROPIC_BASE_URL: "https://api.anthropic.com" })))
      .toEqual({ biller: "anthropic", billingType: "subscription" });
    // A gateway URL with no credential variable still uses the saved subscription login (Claude Code docs).
    expect(resolveClaudeBillingIdentity(read({ ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" })))
      .toEqual({ biller: "anthropic", billingType: "subscription" });
    expect(resolveClaudeBillingIdentity(read({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_AUTH_TOKEN: "x" })))
      .toEqual({ biller: "aws_bedrock", billingType: "metered_api" });
  });

  it("recognizes Anthropic hosts", () => {
    expect(isAnthropicApiBaseUrl("")).toBe(true);
    expect(isAnthropicApiBaseUrl("https://api.anthropic.com/")).toBe(true);
    expect(isAnthropicApiBaseUrl("https://api.anthropic.com.evil.example")).toBe(false);
    expect(isAnthropicApiBaseUrl("not a url")).toBe(false);
  });
});
