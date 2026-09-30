// wabnet L0008: git inside the workspace-scoped bubblewrap sandbox.
//
// A Paperclip worktree's git metadata lives outside the workspace:
//   <workspace>/.git                      -> "gitdir: <common>/worktrees/<name>"
//   <common>/worktrees/<name>             per-worktree HEAD, index, logs, commondir, gitdir
//   <common>                              shared objects, refs, logs, packed-refs, config, hooks
// Without it, git fails in the sandbox. Mounting <common> read-write would let an agent plant
// hooks (or rewrite config / pointer files) that the server later runs as the same user.
//
// Mount plan (applied in order, AFTER the workspace bind, later binds win):
//   ro  <common>                                   everything readable, nothing new writable
//   rw  <common>/objects, refs, logs               what commit / branch / local push write
//   rw  <gitDir>  (worktree case)                  HEAD, index, per-worktree logs
//   ro  <gitDir>/commondir, <gitDir>/gitdir         pointer files: no redirect to a planted git dir
//   ro  <workspace>/.git  (pointer file)            same
//   ro  <common>/hooks, config, info  (in-tree repo case, where <common> is inside the workspace)
//   ro  resolved core.hooksPath directory           a relative hooksPath resolves INSIDE the worktree
//   ro  <gitDir>/config.worktree                    only when extensions.worktreeConfig is enabled
// Known limits: operations that rewrite files directly in <common> (packed-refs rewrites such as
// deleting a packed-only branch, `git pack-refs`, gc) fail with EROFS; `git fetch` needs network.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalProcessSandboxPath } from "./local-process-sandbox.js";

const execFileAsync = promisify(execFile);

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

const defaultGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim();
  } catch {
    return null;
  }
};

async function exists(candidate: string) {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function inside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface GitSandboxMountPlan {
  gitDir: string;
  commonDir: string;
  worktree: boolean;
  paths: LocalProcessSandboxPath[];
}

/**
 * Resolve the git metadata mounts for `workspaceDir`, or null when it is not a git work tree.
 * Directories that must be read-only but do not exist yet (hooks, info, a relative
 * core.hooksPath) are created empty on the host first, so the agent cannot create them.
 */
export async function resolveGitSandboxMounts(
  workspaceDir: string,
  git: GitRunner = defaultGit,
): Promise<GitSandboxMountPlan | null> {
  const topLevel = await git(workspaceDir, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!topLevel) return null;
  const dirs = await git(workspaceDir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (!dirs) return null;
  const [rawGitDir, rawCommonDir] = dirs.split("\n");
  if (!rawGitDir || !rawCommonDir) return null;
  const gitDir = await fs.realpath(rawGitDir).catch(() => path.resolve(rawGitDir));
  const commonDir = await fs.realpath(rawCommonDir).catch(() => path.resolve(rawCommonDir));
  const root = await fs.realpath(topLevel).catch(() => path.resolve(topLevel));
  const worktree = gitDir !== commonDir;
  const paths: LocalProcessSandboxPath[] = [];
  const ro = (candidate: string) => paths.push({ path: candidate, access: "ro" });
  const rw = (candidate: string) => paths.push({ path: candidate, access: "rw" });
  const ensureDir = async (candidate: string) => {
    if (!(await exists(candidate))) await fs.mkdir(candidate, { recursive: true });
  };

  const commonInsideWorkspace = inside(workspaceDir, commonDir);
  if (!commonInsideWorkspace) {
    ro(commonDir);
    for (const name of ["objects", "refs", "logs"]) rw(path.join(commonDir, name));
  }
  if (worktree && !inside(workspaceDir, gitDir)) rw(gitDir);

  // Read-only overlays. Hooks, config and info decide what the server's own git runs.
  await ensureDir(path.join(commonDir, "hooks"));
  await ensureDir(path.join(commonDir, "info"));
  ro(path.join(commonDir, "hooks"));
  ro(path.join(commonDir, "config"));
  ro(path.join(commonDir, "info"));
  if (worktree) {
    ro(path.join(gitDir, "commondir"));
    ro(path.join(gitDir, "gitdir"));
  }
  const dotGit = path.join(root, ".git");
  const dotGitStat = await fs.lstat(dotGit).catch(() => null);
  if (dotGitStat?.isFile()) ro(dotGit);

  const hooksPath = await git(workspaceDir, ["config", "--get", "core.hooksPath"]);
  if (hooksPath) {
    // Git resolves a relative core.hooksPath against the work tree root.
    const resolved = path.isAbsolute(hooksPath) ? hooksPath : path.join(root, hooksPath);
    if (inside(workspaceDir, resolved) || inside(commonDir, resolved)) {
      await ensureDir(resolved);
      ro(resolved);
    }
  }
  if ((await git(workspaceDir, ["config", "--bool", "--get", "extensions.worktreeConfig"])) === "true") {
    const worktreeConfig = path.join(gitDir, "config.worktree");
    if (!(await exists(worktreeConfig))) await fs.writeFile(worktreeConfig, "");
    ro(worktreeConfig);
  }
  return { gitDir, commonDir, worktree, paths };
}
