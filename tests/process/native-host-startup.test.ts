import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runRouterProcess } from "../../src/process/main.js";

vi.mock("../../src/process/codex-host-hub.js", () => ({ CodexHostHub: class { constructor() { throw new Error("fixture provider must not start"); } } }));
vi.mock("../../src/process/ensure-codex-host.js", () => ({ ensureCodexHost: () => { throw new Error("fixture provider must not start"); } }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function setup(value?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "native-startup-")); roots.push(root);
  vi.stubEnv("LANE_ROUTER_CONFIG", join(root, "config.json"));
  const path = join(root, "permits.json");
  writeFileSync(join(root, "config.json"), JSON.stringify({ nativeHostsFile: path }));
  if (value !== undefined) writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return root;
}
const permit = { token: "fixture-secret", hostInstanceId: "fixture-host", address: "fixture/lead", slot: "lead", model: "fixture-model", roleDescription: "Lead" };
test("missing configured permit file fails before provider startup and releases its runtime lock", async () => {
  const root = setup();
  await expect(runRouterProcess({ dataRoot: root })).rejects.toThrow("NATIVE_HOST_PERMITS_UNREADABLE");
  await expect(runRouterProcess({ dataRoot: root })).rejects.toThrow("NATIVE_HOST_PERMITS_UNREADABLE");
});
test.each(["{fixture-secret", {}, [{ ...permit, slot: "employee" }], [{ ...permit, address: "invalid" }], [{ ...permit, "fixture-secret-key": true }], [permit, { ...permit, address: "other/lead" }]].map(value => [value]))("invalid permit file is sanitized and fails before provider startup: %j", async value => {
  await expect(runRouterProcess({ dataRoot: setup(value) })).rejects.toThrow("NATIVE_HOST_PERMITS_INVALID");
});
test("explicit permits and configured permit file never silently override each other", async () => {
  await expect(runRouterProcess({ dataRoot: setup([permit]), nativeHosts: [] } as Parameters<typeof runRouterProcess>[0])).rejects.toThrow("NATIVE_HOST_PERMITS_AMBIGUOUS");
});
