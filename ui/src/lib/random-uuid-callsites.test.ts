// wabnet fork (completes #13914 on v2026.916.1): crypto.randomUUID is undefined on plain-HTTP
// LAN origins (the lab serves http://192.168.17.10:3100), so an unguarded call throws and the
// action silently does nothing (#13858). Every call must go through randomUuidOrFallback()
// or sit behind a `typeof crypto.randomUUID === "function"` guard.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("crypto.randomUUID call sites", () => {
  it("are all guarded or routed through randomUuidOrFallback", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file.endsWith(path.join("lib", "random-uuid.ts"))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/crypto\.randomUUID\(\)/.test(line) && !/typeof crypto/.test(line)) {
          // A guarded ternary may put the call on the line after its guard.
          offenders.push(`${path.relative(srcRoot, file)}:${index + 1}`);
        }
      });
    }
    const guardedOnNextLine = offenders.filter((entry) => {
      const [file, lineNo] = entry.split(":");
      const lines = readFileSync(path.join(srcRoot, file!), "utf8").split("\n");
      return /typeof crypto\.randomUUID === "function"/.test(lines[Number(lineNo) - 2] ?? "");
    });
    expect(offenders.filter((o) => !guardedOnNextLine.includes(o))).toEqual([]);
  });
});
