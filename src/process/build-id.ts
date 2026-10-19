import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A content hash of the server code in this build directory (`dist/` when built). The Codex host
 * outlives core restarts, so after a deploy the two can be running different builds; comparing
 * this value is how the board notices, and reading the existing output means no build stamp has to
 * be added. Browser assets under `ui/` are left out: they change nothing either process runs.
 */
export function buildId(root: string = dirname(dirname(fileURLToPath(import.meta.url)))): string {
  const hash = createHash("sha256");
  for (const path of serverFiles(root, root).sort()) {
    hash.update(relative(root, path).replaceAll("\\", "/")).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function serverFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === root && entry.name === "ui") continue;
      files.push(...serverFiles(root, path));
    } else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}
