// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({ grants: vi.fn(), setGrants: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
import { AgentGrantsSection, GRANTABLE_AGENT_PERMISSION_KEYS } from "./AgentGrantsSection";

let root: Root | undefined;
afterEach(() => { if (root) flushSync(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.clearAllMocks(); });
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(<QueryClientProvider client={new QueryClient()}><AgentGrantsSection agentId="a1" companyId="co" /></QueryClientProvider>));
  await tick(); await tick(); flushSync(() => {});
  return container;
}
const toggleFor = (c: HTMLElement, key: string) => c.querySelector(`[aria-label="${key}"]`) as HTMLButtonElement;

describe("AgentGrantsSection (L0011c)", () => {
  it("hides grant-conferring keys and tasks:assign", () => {
    for (const key of ["users:manage_permissions", "users:invite", "joins:approve", "tasks:assign"]) {
      expect(GRANTABLE_AGENT_PERMISSION_KEYS).not.toContain(key);
    }
    expect(GRANTABLE_AGENT_PERMISSION_KEYS).toContain("agents:suggest-changes");
  });

  it("adds a grant as a merge and removes one as an explicit replace of the rest", async () => {
    api.grants.mockResolvedValue({ agentId: "a1", grants: [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "skills:suggest-changes", scope: null }] });
    api.setGrants.mockImplementation(async (_id, body) => ({ agentId: "a1", grants: body.grants }));
    const c = await mount();
    flushSync(() => toggleFor(c, "agents:suggest-changes").click());
    await tick();
    expect(api.setGrants).toHaveBeenLastCalledWith("a1", { grants: [{ permissionKey: "agents:suggest-changes" }] }, "co");
    api.grants.mockResolvedValue({ agentId: "a1", grants: [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "skills:suggest-changes", scope: null }] });
    const c2 = await mount();
    flushSync(() => toggleFor(c2, "skills:suggest-changes").click());
    await tick();
    expect(api.setGrants).toHaveBeenLastCalledWith("a1", { grants: [], replace: true }, "co");
  });
});
