/** Child-process fixture that observes whether startup failure releases router.lock before catch returns. */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runRouterProcess } from "../../../src/process/main.js";

const dataRoot = process.argv[2];
if (!dataRoot) throw new Error("data root is required");
try {
  await runRouterProcess({ dataRoot });
  process.stdout.write("unexpected-success");
} catch {
  process.stdout.write(existsSync(join(dataRoot, "router.lock")) ? "held" : "released");
}
