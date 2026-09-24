import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuidOrFallback } from "./random-uuid";

describe("randomUuidOrFallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to crypto.randomUUID when it is available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-from-crypto" });
    expect(randomUuidOrFallback()).toBe("uuid-from-crypto");
  });

  it("falls back to a locally unique id when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const first = randomUuidOrFallback();
    const second = randomUuidOrFallback();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});
