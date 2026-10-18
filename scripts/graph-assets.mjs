import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../dist/ui/graphs/", import.meta.url);
const names = readdirSync(new URL("assets/", root), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `assets/${entry.name}`);
if (names.some(name => !/^assets\/[^/\\]+\.(js|css|ttf|woff2|svg|png)$/.test(name))) throw new Error("Unexpected graph asset output");
writeFileSync(fileURLToPath(new URL("asset-manifest.json", root)), JSON.stringify(names));
