// wabnet L0012: pnpm inside the sandbox uses the host store read-only via a private index copy.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalProcessSandboxSpawnTarget, preparePnpmStoreSandbox } from "./local-process-sandbox.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

async function hostStore() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pnpm-host-")));
  cleanup.push(root);
  const store = path.join(root, "store");
  await fs.mkdir(path.join(store, "v11", "files", "00"), { recursive: true });
  await fs.writeFile(path.join(store, "v11", "index.db"), "sqlite-bytes");
  await fs.writeFile(path.join(store, "v11", "files", "00", "abc"), "content");
  const cache = path.join(root, "cache");
  await fs.mkdir(cache);
  return { root, store, cache };
}

describe("preparePnpmStoreSandbox (L0012)", () => {
  it("copies the index privately, links the shared files read-only, and points pnpm at it offline", async () => {
    const h = await hostStore();
    const prepared = (await preparePnpmStoreSandbox({ storeDir: h.store, cacheDir: h.cache }))!;
    cleanup.push(prepared.privateStoreDir);
    expect(await fs.readFile(path.join(prepared.privateStoreDir, "v11", "index.db"), "utf8")).toBe("sqlite-bytes");
    expect(await fs.readlink(path.join(prepared.privateStoreDir, "v11", "files"))).toBe(path.join(h.store, "v11", "files"));
    expect(prepared.readOnlyPaths).toEqual([path.join(h.store, "v11", "files"), h.cache]);
    expect(prepared.env).toEqual({
      pnpm_config_store_dir: prepared.privateStoreDir,
      pnpm_config_offline: "true",
      pnpm_config_frozen_store: "true",
      pnpm_config_cache_dir: h.cache,
    });
    // Writes to the private index never reach the host store.
    await fs.writeFile(path.join(prepared.privateStoreDir, "v11", "index.db"), "changed");
    expect(await fs.readFile(path.join(h.store, "v11", "index.db"), "utf8")).toBe("sqlite-bytes");
  });

  it("returns null for a store without a vN layout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pnpm-empty-"));
    cleanup.push(dir);
    expect(await preparePnpmStoreSandbox({ storeDir: dir })).toBeNull();
  });

  it.runIf(process.platform === "linux")("binds shared files read-only and the private root read-write, and cleans up", async () => {
    const h = await hostStore();
    const workspace = path.join(h.root, "ws");
    await fs.mkdir(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "0"], cwd: workspace,
      options: { workspaceDir: workspace, filesystemScope: "workspace", pnpmStore: { storeDir: h.store, cacheDir: h.cache } },
    });
    const flat = target.args.join("\n");
    const files = path.join(h.store, "v11", "files");
    expect(flat).toContain(`--ro-bind\n${files}\n${files}`);
    expect(flat).toContain(`--ro-bind\n${h.cache}\n${h.cache}`);
    expect(flat).not.toContain(`--bind\n${files}\n`);
    const privateDir = target.env?.pnpm_config_store_dir as string;
    expect(privateDir).toMatch(/paperclip-pnpm-store-/);
    expect(flat).toContain(`--bind\n${privateDir}\n${privateDir}`);
    expect(target.env).toMatchObject({ pnpm_config_offline: "true", pnpm_config_frozen_store: "true" });
    await target.cleanup?.();
    await expect(fs.stat(privateDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(files, "00", "abc"), "utf8")).toBe("content");
  });
});
