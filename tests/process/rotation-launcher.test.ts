import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { launchRotation } from "../../src/process/rotation-launcher.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("opens a Codex terminal from a one-shot handoff file and deletes it after spawn", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000000.md");
  writeFileSync(handoff, "继续处理 Unicode：你好", "utf8");
  const spawnTerminal = vi.fn(async () => undefined);

  await launchRotation(["codex", "alpha/design", "--handoff-file", handoff], {
    dataRoot,
    cwd: "D:\\project",
    spawnTerminal,
  });

  const request = spawnTerminal.mock.calls[0]![0];
  expect(request).toMatchObject({ backend: "codex", cwd: "D:\\project" });
  expect(request.prompt).toContain("alpha/design");
  expect(request.prompt).toContain("继续处理 Unicode：你好");
  expect(() => readFileSync(handoff)).toThrow();
});

test("rejects handoff files outside the rotation root without spawning", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const outside = join(dataRoot, "outside.md");
  writeFileSync(outside, "no", "utf8");
  const spawnTerminal = vi.fn(async () => undefined);
  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", outside], { dataRoot, spawnTerminal }))
    .rejects.toThrow(/rotation-handoffs/i);
  expect(spawnTerminal).not.toHaveBeenCalled();
  expect(readFileSync(outside, "utf8")).toBe("no");
});

test("keeps the handoff file when terminal creation fails", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lane-router-rotate-"));
  roots.push(dataRoot);
  const handoffRoot = join(dataRoot, "rotation-handoffs");
  mkdirSync(handoffRoot);
  const handoff = join(handoffRoot, "00000000-0000-4000-8000-000000000001.md");
  writeFileSync(handoff, "retry me", "utf8");
  await expect(launchRotation(["claude", "alpha/design", "--handoff-file", handoff], {
    dataRoot,
    spawnTerminal: async () => { throw new Error("terminal failed"); },
  })).rejects.toThrow(/terminal failed/i);
  expect(readFileSync(handoff, "utf8")).toBe("retry me");
});
