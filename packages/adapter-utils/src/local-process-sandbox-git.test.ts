// wabnet L0008: git metadata mount plan for workspace-scoped sandboxes.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitSandboxMounts } from "./local-process-sandbox-git.js";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-sandbox-")));
  cleanup.push(root);
  const main = path.join(root, "_default");
  await fs.mkdir(main);
  git(main, "init", "-q");
  git(main, "config", "core.hooksPath", ".githooks");
  await fs.mkdir(path.join(main, ".githooks"));
  await fs.writeFile(path.join(main, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(main, "a.txt"), "a");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");
  const worktree = path.join(root, "_worktrees", "WAB-1");
  git(main, "worktree", "add", "-q", "-b", "wab-1", worktree);
  return { root, main, worktree, common: path.join(main, ".git"), gitDir: path.join(main, ".git", "worktrees", "WAB-1") };
}

describe("git sandbox mounts (L0008)", () => {
  it("returns null outside a git work tree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-no-git-"));
    cleanup.push(dir);
    expect(await resolveGitSandboxMounts(dir)).toBeNull();
  });

  it("mounts a worktree's metadata writable where git writes and read-only where code or redirects live", async () => {
    const p = await project();
    const plan = (await resolveGitSandboxMounts(p.worktree))!;
    expect(plan).toMatchObject({ worktree: true, gitDir: p.gitDir, commonDir: p.common });
    expect(plan.paths).toEqual([
      { path: p.common, access: "ro" },
      { path: path.join(p.common, "objects"), access: "rw" },
      { path: path.join(p.common, "refs"), access: "rw" },
      { path: path.join(p.common, "logs"), access: "rw" },
      { path: p.gitDir, access: "rw" },
      { path: path.join(p.common, "hooks"), access: "ro" },
      { path: path.join(p.common, "config"), access: "ro" },
      { path: path.join(p.common, "info"), access: "ro" },
      { path: path.join(p.gitDir, "commondir"), access: "ro" },
      { path: path.join(p.gitDir, "gitdir"), access: "ro" },
      { path: path.join(p.worktree, ".git"), access: "ro" },
      // A relative core.hooksPath resolves inside the (writable) worktree.
      { path: path.join(p.worktree, ".githooks"), access: "ro" },
    ]);
  });

  it("overlays hooks, config and info read-only for an in-workspace repository", async () => {
    const p = await project();
    await fs.rm(path.join(p.common, "hooks"), { recursive: true, force: true });
    const plan = (await resolveGitSandboxMounts(p.main))!;
    expect(plan.worktree).toBe(false);
    expect(plan.paths).toEqual([
      { path: path.join(p.common, "hooks"), access: "ro" },
      { path: path.join(p.common, "config"), access: "ro" },
      { path: path.join(p.common, "info"), access: "ro" },
      { path: path.join(p.main, ".githooks"), access: "ro" },
    ]);
    // A missing hooks dir is created empty so the agent cannot create it.
    expect((await fs.stat(path.join(p.common, "hooks"))).isDirectory()).toBe(true);
  });

  it("protects config.worktree when extensions.worktreeConfig is on", async () => {
    const p = await project();
    git(p.main, "config", "extensions.worktreeConfig", "true");
    const plan = (await resolveGitSandboxMounts(p.worktree))!;
    expect(plan.paths.at(-1)).toEqual({ path: path.join(p.gitDir, "config.worktree"), access: "ro" });
    expect(await fs.readFile(path.join(p.gitDir, "config.worktree"), "utf8")).toBe("");
  });

  it.runIf(process.platform === "linux")("mounts the plan after the workspace, in order", async () => {
    const p = await project();
    const plan = (await resolveGitSandboxMounts(p.worktree))!;
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "0"], cwd: p.worktree,
      options: { workspaceDir: p.worktree, filesystemScope: "workspace", postWorkspacePaths: plan.paths },
    });
    const flat = target.args.join("\n");
    const at = (flag: string, src: string) => flat.indexOf(`${flag}\n${src}\n${src}`);
    expect(at("--bind", p.worktree)).toBeGreaterThan(0);
    expect(at("--ro-bind", p.common)).toBeGreaterThan(at("--bind", p.worktree));
    expect(at("--bind", path.join(p.common, "refs"))).toBeGreaterThan(at("--ro-bind", p.common));
    expect(at("--ro-bind", path.join(p.worktree, ".githooks"))).toBeGreaterThan(at("--bind", p.gitDir));
  });
});
