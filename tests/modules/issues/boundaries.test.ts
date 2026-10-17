import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

describe("issue composition boundaries", () => {
  it("imports and constructs a service without opening or creating a database", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-issues-import-"));
    const moduleUrl = new URL("../../../src/modules/issues/index.ts", import.meta.url).href;
    const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    const code = `const m=await import(${JSON.stringify(moduleUrl)}); new m.IssuesService({store:{},lanes:{}});`;
    try {
      execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", code], { cwd: root, windowsHide: true });
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps core independent and business free of HTTP, UI and core storage imports", () => {
    const source = fileURLToPath(new URL("../../../src/", import.meta.url));
    const routerFiles = readdirSync(join(source, "router")).filter((file) => file.endsWith(".ts"));
    for (const file of routerFiles) {
      expect(readFileSync(join(source, "router", file), "utf8"), file).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*modules\/issues/);
    }
    for (const file of ["service.ts", "ports.ts", "store.ts", "schema.ts"]) {
      const text = readFileSync(join(source, "modules/issues", file), "utf8");
      expect(text, file).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:ui\/|http|router\/(?:state-store|database|router-core))/);
    }
  });
});
