import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAccountConfigParams,
  CODING_PLAN_PROVIDER_IDS,
  computeBasedOnBuiltinRevision,
  newAccountConfigRevision,
  pushAccountConfig,
} from "../../../../src/adapters/zcode/driver/account-config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ACTIVE = "account:bigmodel-individual-coding-plan";

async function builtinFile(revision: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lane-router-uac-"));
  roots.push(root);
  const path = join(root, "zcode-builtin.json");
  await writeFile(path, JSON.stringify({ revision, providers: [], modelRules: [] }), "utf8");
  return path;
}

describe("zcode account config", () => {
  it("derives basedOnZCodeBuiltinRevision exactly as the verified formula prescribes", async () => {
    const builtinPath = await builtinFile(30);
    // Independent recomputation with the same primitives the spike validated numerically:
    // "zcode-builtin:" + catalog revision + ":" + sha256(path.resolve(file)) hex.
    const expected = `zcode-builtin:30:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`;
    expect(computeBasedOnBuiltinRevision(30, builtinPath)).toBe(expected);
    expect(computeBasedOnBuiltinRevision(30, builtinPath)).not.toContain("  ");
    expect(computeBasedOnBuiltinRevision(31, builtinPath)).not.toBe(expected);
  });

  it("lists all six coding plans with only the active one entitled, and gives it a current state", async () => {
    const builtinPath = await builtinFile(30);
    const params = await buildAccountConfigParams({
      builtinPath, activeProviderId: ACTIVE, revision: "rev-1",
      readConfigFile: async () => JSON.stringify({ revision: 30 }),
    });
    expect(Object.keys(params.providers as Record<string, unknown>).sort()).toEqual([...CODING_PLAN_PROVIDER_IDS].sort());
    const providers = params.providers as Record<string, { access: { type: string; entitled: boolean } }>;
    for (const id of CODING_PLAN_PROVIDER_IDS) {
      expect(providers[id]).toEqual({ access: { type: "zhipu-account", entitled: id === ACTIVE } });
    }
    // The exact shape whose absence produced -32603 "Account State 缺少 current" in the spike.
    expect(params.states).toEqual({ [ACTIVE]: { availability: "available", entitled: true, current: true } });
  });

  it("rejects an active provider outside the coding-plan catalogue", async () => {
    await expect(buildAccountConfigParams({
      builtinPath: "unused.json", activeProviderId: "account:some-other-plan", revision: "r",
      readConfigFile: async () => JSON.stringify({ revision: 1 }),
    })).rejects.toThrow(/not a known coding plan/u);
  });

  it("pushes through the client and refuses an answer naming a different revision", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("provider/updateAccountConfig");
      return { receivedRevision: (params as { revision: string }).revision, providerCount: 8, status: "received" };
    });
    await pushAccountConfig({ request }, {
      builtinPath: "b.json", activeProviderId: ACTIVE, revision: "rev-9",
      readConfigFile: async () => JSON.stringify({ revision: 30 }),
    });
    expect(request).toHaveBeenCalledTimes(1);

    const mismatch = vi.fn(async () => ({ receivedRevision: "other", providerCount: 8, status: "received" }));
    await expect(pushAccountConfig({ request: mismatch }, {
      builtinPath: "b.json", activeProviderId: ACTIVE, revision: "rev-9",
      readConfigFile: async () => JSON.stringify({ revision: 30 }),
    })).rejects.toThrow(/different revision/u);
  });

  it("rejects a non-received status rather than treating a rejection as success", async () => {
    await expect(pushAccountConfig({ request: async () => ({ status: "stale" }) as unknown }, {
      builtinPath: "b.json", activeProviderId: ACTIVE, revision: "r",
      readConfigFile: async () => JSON.stringify({ revision: 30 }),
    })).rejects.toThrow();
  });

  it("builds a unique-looking revision string", () => {
    expect(newAccountConfigRevision(1_720_000_000_000, "abc")).toBe("lane-router-1720000000000-abc");
  });
});
