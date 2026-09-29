import { describe, expect, it } from "vitest";
import { formatMigrationPlan } from "../commands/client/ai-connections.js";

describe("ai-connections migrate-env-agents output", () => {
  it("prints a dry-run plan with hashes only and the apply hint", () => {
    const text = formatMigrationPlan({
      dryRun: true,
      planHash: "0123456789abcdef",
      groups: [{
        key: "g1", baseUrl: "http://127.0.0.1:4000", tokenSha256: "b5a2c9625061", authHeader: "bearer", preset: "switchyard",
        biller: "switchyard", connectionName: "Switchyard (migrated b5a2c9)", models: ["MiniMax-M3"], warnings: ["w1"],
        agents: [{ name: "bakeoff-minimax-m3", status: "idle", removeKeys: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"], keptModelKeys: ["ANTHROPIC_MODEL"] }],
      }],
      skipped: [{ name: "old", reason: "terminated" }],
    });
    expect(text).toContain("DRY RUN — plan 0123456789abcdef (nothing was changed)");
    expect(text).toContain("token sha256:b5a2c9625061…");
    expect(text).toContain("bakeoff-minimax-m3 [idle]  remove: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN");
    expect(text).toContain("--apply --plan-hash 0123456789abcdef");
    expect(text).toContain("old: terminated");
  });
});
