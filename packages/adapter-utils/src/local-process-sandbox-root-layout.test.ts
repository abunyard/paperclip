// wabnet L0010: the builder must mirror the host's /bin, /sbin, /lib, /lib64 layout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalProcessSandboxSpawnTarget, rootSystemPathArgs, type RootSystemPathKind } from "./local-process-sandbox.js";

const merged: Record<string, RootSystemPathKind> = {
  "/bin": { kind: "symlink", target: "usr/bin" },
  "/sbin": { kind: "symlink", target: "usr/sbin" },
  "/lib": { kind: "symlink", target: "usr/lib" },
  "/lib64": { kind: "symlink", target: "usr/lib64" },
};
const split: Record<string, RootSystemPathKind> = {
  "/bin": { kind: "directory" },
  "/sbin": { kind: "directory" },
  "/lib": { kind: "directory" },
  "/lib64": { kind: "missing" },
};
const probeFrom = (layout: Record<string, RootSystemPathKind>) => async (candidate: string) => layout[candidate] ?? { kind: "missing" as const };

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

function pairs(args: string[], flag: string) {
  const out: string[][] = [];
  args.forEach((arg, i) => { if (arg === flag) out.push(args.slice(i + 1, i + 3)); });
  return out;
}

describe("root system path layout (L0010)", () => {
  it("keeps merged-/usr symlinks as symlinks and binds nothing onto them", async () => {
    expect(await rootSystemPathArgs(probeFrom(merged))).toEqual({
      args: ["--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64"],
      bindDirectories: [],
    });
  });

  it("binds real directories on a split layout and skips missing ones", async () => {
    expect(await rootSystemPathArgs(probeFrom(split))).toEqual({ args: [], bindDirectories: ["/bin", "/sbin", "/lib"] });
  });

  it.runIf(process.platform === "linux").each([
    ["merged /usr (Ubuntu 24.04)", merged],
    ["split /usr", split],
  ] as const)("builds a mountable command for %s", async (_label, layout) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-root-layout-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "0"],
      cwd: workspace,
      options: { workspaceDir: workspace, filesystemScope: "workspace", rootSystemPathProbe: probeFrom(layout) },
    });
    const roBinds = pairs(target.args, "--ro-bind").map(([source]) => source);
    const symlinks = pairs(target.args, "--symlink").map(([, dest]) => dest);
    for (const top of ["/bin", "/sbin", "/lib", "/lib64"]) {
      // The bug: a path must never be both a new-root symlink and a bind destination.
      expect(symlinks.includes(top) && roBinds.includes(top)).toBe(false);
    }
    const usrIndex = roBinds.indexOf("/usr");
    expect(usrIndex).toBeGreaterThanOrEqual(0);
    if (layout === merged) {
      expect(symlinks).toEqual(["/bin", "/sbin", "/lib", "/lib64"]);
      expect(roBinds.filter((s) => ["/bin", "/sbin", "/lib", "/lib64"].includes(s))).toEqual([]);
    } else {
      expect(symlinks).toEqual([]);
      // Real top-level dirs are bound after /usr; /lib64 (missing) is left out.
      for (const dir of ["/bin", "/sbin", "/lib"]) expect(roBinds.indexOf(dir)).toBeGreaterThan(usrIndex);
      expect(roBinds).not.toContain("/lib64");
    }
  });

  it.runIf(process.platform === "linux")("mirrors the real host layout by default", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-root-layout-host-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "0"], cwd: workspace,
      options: { workspaceDir: workspace, filesystemScope: "workspace" },
    });
    const hostBin = await fs.lstat("/bin");
    const symlinks = pairs(target.args, "--symlink").map(([, dest]) => dest);
    expect(symlinks.includes("/bin")).toBe(hostBin.isSymbolicLink());
  });
});
