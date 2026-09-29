// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
import { AnthropicCompatibleEndpointChooser } from "./AnthropicCompatibleEndpointChooser";

let root: Root | undefined;
afterEach(() => { if (root) flushSync(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.clearAllMocks(); });
const tick = () => new Promise((r) => setTimeout(r, 0));
const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id, grantId: `g-${id}`, companyId: "co", provider: "anthropic_compatible", method: "api_key", name: `Endpoint ${id}`, ownership: "shared",
  isDefault: false, status: "connected", endpoint: { baseUrl: `https://${id}.example`, models: ["m1"] }, ...over,
});
async function mount(onChange = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(<QueryClientProvider client={new QueryClient()}><AnthropicCompatibleEndpointChooser companyId="co" onChange={onChange} /></QueryClientProvider>));
  await tick(); await tick();
  flushSync(() => {});
  return { container, onChange };
}

describe("AnthropicCompatibleEndpointChooser", () => {
  it("lists shared endpoint connections and binds the chosen one per agent", async () => {
    api.list.mockResolvedValue({ currentUserId: "u", connections: [summary("minimax"), summary("claude", { provider: "anthropic" }), summary("mine", { ownership: "personal" })] });
    const { container, onChange } = await mount();
    const names = [...container.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Endpoint minimax"]);
    expect(container.textContent).toContain("https://minimax.example · 1 models");
    flushSync(() => (container.querySelector('button[aria-label="Endpoint minimax"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith({ provider: "anthropic_compatible", method: "api_key", mode: "shared", connectionId: "minimax", grantId: "g-minimax" });
  });

  it("goes straight to the endpoint form when none exist", async () => {
    api.list.mockResolvedValue({ currentUserId: "u", connections: [] });
    const { container } = await mount();
    expect(container.querySelector('[aria-label="Anthropic-compatible endpoint"]')).not.toBeNull();
  });
});
