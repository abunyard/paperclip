// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
  testAnthropicCompatible: vi.fn(async () => ({ ok: true })),
  listAnthropicCompatibleModels: vi.fn(async () => ({ models: ["MiniMax-M3", "MiniMax-M2.7"] })),
  create: vi.fn(async () => ({ connectionId: "c1", grantId: "g1" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

import { AnthropicCompatibleEndpointForm, parseModelList } from "./AnthropicCompatibleEndpointForm";

let root: Root | undefined;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
const tick = () => new Promise((r) => setTimeout(r, 0));
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function mount(onComplete = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  flushSync(() => root!.render(
    <QueryClientProvider client={client}>
      <AnthropicCompatibleEndpointForm companyId="co" agentIds={["a1"]} onComplete={onComplete} onCancel={vi.fn()} />
    </QueryClientProvider>,
  ));
  const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;
  const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
  return { container, q, button, onComplete };
}

describe("parseModelList", () => {
  it("splits on whitespace/commas and dedupes", () => {
    expect(parseModelList("MiniMax-M3, MiniMax-M2.7\nMiniMax-M3 ")).toEqual(["MiniMax-M3", "MiniMax-M2.7"]);
  });
});

describe("AnthropicCompatibleEndpointForm", () => {
  it("prefills the MiniMax preset, discovers models, tests, then saves the endpoint and clears the key", async () => {
    const { q, button, onComplete } = mount();
    const baseUrl = q<HTMLInputElement>('input[aria-label="Base URL"]');
    expect(baseUrl.value).toBe("https://api.minimax.io/anthropic");
    const key = q<HTMLInputElement>('input[aria-label="API key"]');
    expect(key.type).toBe("password");
    expect(button("Connect").disabled).toBe(true);
    setValue(key, "fixture-key");
    flushSync(() => button("Discover models").click());
    await tick(); await tick();
    expect(api.listAnthropicCompatibleModels).toHaveBeenCalledWith("co", expect.objectContaining({ apiKey: "fixture-key", endpoint: expect.objectContaining({ baseUrl: "https://api.minimax.io/anthropic", preset: "minimax" }) }));
    expect(q<HTMLTextAreaElement>('textarea[aria-label="Models"]').value).toBe("MiniMax-M3\nMiniMax-M2.7");
    flushSync(() => button("Test").click());
    await tick(); await tick();
    expect(api.testAnthropicCompatible).toHaveBeenCalledTimes(1);
    flushSync(() => button("Connect").click());
    await tick(); await tick();
    expect(api.create).toHaveBeenCalledWith("co", expect.objectContaining({
      provider: "anthropic_compatible", method: "api_key", ownership: "shared", agentIds: ["a1"], apiKey: "fixture-key",
      endpoint: expect.objectContaining({ models: ["MiniMax-M3", "MiniMax-M2.7"], billing: { type: "fixed", biller: "minimax" }, authHeader: "bearer" }),
    }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c1", grantId: "g1" }));
    expect(q<HTMLInputElement>('input[aria-label="API key"]').value).toBe("");
  });

  it("rejects a plain-http non-loopback base URL before any request", () => {
    const { q, container, button } = mount();
    setValue(q<HTMLInputElement>('input[aria-label="Base URL"]'), "http://10.0.0.5:4000");
    setValue(q<HTMLInputElement>('input[aria-label="API key"]'), "k");
    expect(container.textContent).toContain("Use https (plain http only for 127.0.0.1 or localhost)");
    expect(button("Discover models").disabled).toBe(true);
    expect(button("Connect").disabled).toBe(true);
    setValue(q<HTMLInputElement>('input[aria-label="Base URL"]'), "http://127.0.0.1:4000");
    expect(button("Discover models").disabled).toBe(false);
  });
});
