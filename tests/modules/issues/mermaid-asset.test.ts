import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 1: mermaid is pinned to one version
// and served from this machine, as markdown-it is.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("1: package.json names mermaid at an exact version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  expect(manifest.dependencies.mermaid).toMatch(/^\d+\.\d+\.\d+$/u);
});

test("1: /issues/assets/mermaid.js answers the packaged bundle as JavaScript", async () => {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "mermaid", issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const response = await fetch(`${url}/issues/assets/mermaid.js`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/javascript/u);
  const bundle = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
  expect((await response.arrayBuffer()).byteLength).toBe(statSync(bundle).size);
});
