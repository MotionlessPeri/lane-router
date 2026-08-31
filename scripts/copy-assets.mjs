import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tsc` emits the files it compiles and nothing else, so anything shipped beside the code has to
 * be carried here. Today that is the dashboard page, which is a real HTML file on purpose: keeping
 * it out of a TypeScript string is what makes it editable as a page.
 */
const ASSETS = ["process/dashboard.html"];

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

for (const asset of ASSETS) {
  const source = join(repository, "src", asset);
  const destination = join(repository, "dist", asset);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  // Verified by reading the artifact back, not by trusting the copy: "it works from the source
  // tree" and "it is in the build" are different claims, and only the second one ships.
  if (readFileSync(destination, "utf8") !== readFileSync(source, "utf8")) {
    process.stderr.write(`Asset did not land in dist: ${asset}\n`);
    process.exit(1);
  }
}
