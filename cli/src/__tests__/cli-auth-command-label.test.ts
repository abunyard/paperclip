// wabnet local fix: the cli-auth challenge `command` label must fit
// createCliAuthChallengeSchema's 240-char cap, or a long argv never yields an approval URL.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliAuthChallengeSchema } from "@paperclipai/shared";
import { CLI_AUTH_COMMAND_MAX_LENGTH, clampCliAuthCommandLabel } from "../client/command-label.js";
import { loginBoardCli } from "../client/board-auth.js";

const longCommand = `paperclipai member permissions --company-id 7a2be3bb-6aa4-4260-8e3e-616d6b8a1992 --payload-json ${JSON.stringify({
  grants: Array.from({ length: 12 }, (_, index) => ({ permissionKey: `agents:configure-${index}`, scope: { kind: "company" } })),
})}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clampCliAuthCommandLabel", () => {
  it("leaves labels within the limit unchanged", () => {
    expect(clampCliAuthCommandLabel("paperclipai auth login")).toBe("paperclipai auth login");
    const exact = "x".repeat(CLI_AUTH_COMMAND_MAX_LENGTH);
    expect(clampCliAuthCommandLabel(exact)).toBe(exact);
  });

  it("ellipsizes an over-long label to the schema limit, keeping its start and end", () => {
    expect(longCommand.length).toBeGreaterThan(CLI_AUTH_COMMAND_MAX_LENGTH);
    // The unclamped label is what the server rejected ("Validation error").
    expect(createCliAuthChallengeSchema.safeParse({ command: longCommand }).success).toBe(false);
    const clamped = clampCliAuthCommandLabel(longCommand);
    expect(clamped.length).toBeLessThanOrEqual(CLI_AUTH_COMMAND_MAX_LENGTH);
    expect(clamped.startsWith("paperclipai member permissions --company-id")).toBe(true);
    expect(clamped.endsWith(longCommand.slice(-10))).toBe(true);
    expect(clamped).toContain("…");
    expect(createCliAuthChallengeSchema.safeParse({ command: clamped }).success).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const clamped = clampCliAuthCommandLabel("😀".repeat(200));
    expect(clamped.length).toBeLessThanOrEqual(CLI_AUTH_COMMAND_MAX_LENGTH);
    expect(clamped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("loginBoardCli with a long command", () => {
  it("creates the challenge and prints an approval URL instead of failing validation", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/cli-auth/challenges") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        // Mirror the server: validate with the same schema the route uses.
        if (!createCliAuthChallengeSchema.safeParse(body).success) {
          return new Response(JSON.stringify({ error: "Validation error" }), { status: 400 });
        }
        return new Response(JSON.stringify({
          id: "challenge-1", token: "poll-token", boardApiToken: "board-token",
          approvalPath: "/cli-auth/challenge-1", pollPath: "/cli-auth/challenges/challenge-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(), suggestedPollIntervalMs: 500,
        }), { status: 201 });
      }
      // First poll: end the flow without waiting for a human approval.
      return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 });
    }));
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { printed.push(args.join(" ")); });

    await expect(loginBoardCli({
      apiBase: "http://paperclip.test",
      requestedAccess: "board",
      command: longCommand,
      openBrowser: false,
    })).rejects.toThrow("CLI auth challenge was cancelled.");

    expect(posted).toHaveLength(1);
    const command = (posted[0] as { command: string }).command;
    expect(command.length).toBeLessThanOrEqual(CLI_AUTH_COMMAND_MAX_LENGTH);
    expect(printed.join("\n")).toContain("http://paperclip.test/cli-auth/challenge-1");
  });
});
