import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test.each(["auth_copy", "database_open", "runtime_start"])("real fixture cleans its disposable root after early %s failure", async (failureStage) => {
  const parent = await mkdtemp(join(tmpdir(), "lane-router-fixture-parent-")); roots.push(parent);
  const auth = join(parent, "auth.json"); await writeFile(auth, "{}");
  const result = spawnSync(process.execPath, [join(process.cwd(), "tests", "fixtures", "codex", "real-app-server-smoke.mjs")], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, CODEX_EXE: process.execPath, CODEX_AUTH_FILE: auth, CODEX_VERSION: "test", EXPECTED_RUNTIME_SHA: "0".repeat(40), REAL_FIXTURE_TEST_PARENT: parent, REAL_FIXTURE_TEST_FAIL_STAGE: failureStage },
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ stage: failureStage, code: `TEST_${failureStage.toUpperCase()}` });
  expect(await readdir(parent)).toEqual(["auth.json"]);
});

test("real fixture mechanically rejects an expected runtime SHA unrelated to production source", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lane-router-fixture-sha-")); roots.push(parent);
  const auth = join(parent, "auth.json"); await writeFile(auth, "{}");
  const result = spawnSync(process.execPath, [join(process.cwd(), "tests", "fixtures", "codex", "real-app-server-smoke.mjs")], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, CODEX_EXE: process.execPath, CODEX_AUTH_FILE: auth, CODEX_VERSION: "test", EXPECTED_RUNTIME_SHA: "0".repeat(40), REAL_FIXTURE_TEST_PARENT: parent, REAL_FIXTURE_VERIFY_ONLY: "1" },
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ stage: "verify_runtime", code: "RUNTIME_SHA_MISMATCH" });
  expect(await readdir(parent)).toEqual(["auth.json"]);
});
