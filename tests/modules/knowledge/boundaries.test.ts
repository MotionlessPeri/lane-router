import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const source = fileURLToPath(new URL("../../../src/", import.meta.url));
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)].map(match => match[1]!);
const tsFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? tsFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);

test("15. core never imports the knowledge module, and the knowledge service and storage import no HTTP or UI", () => {
  for (const file of tsFiles(join(source, "router"))) expect(imports(file).filter(path => path.includes("modules/knowledge")), file).toEqual([]);
  for (const name of ["service.ts", "store.ts", "schema.ts", "types.ts", "tool-schema.ts"]) {
    const file = join(source, "modules/knowledge", name);
    expect(imports(file).filter(path => /(?:^|\/)(?:http|ui|process)(?:\/|\.js$)|node:http|local-server/.test(path)), name).toEqual([]);
  }
  const page = readFileSync(join(source, "ui/knowledge/index.html"), "utf8");
  expect(page).not.toMatch(/import\s|require\(|modules\/knowledge|knowledge\.sqlite/);
});
