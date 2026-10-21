// The lane plugin's MCP server is the Router's own lane server (LR-24). Claude Code starts this file
// as ${CLAUDE_PLUGIN_ROOT}/server.mjs, and it finds the build from where it sits, so no machine path
// is written anywhere and the repository can live wherever it is checked out. Importing the module
// alone would start nothing: it runs itself only when it is the script node was given.
import { runLaneMcpStdio } from "../../../../dist/mcp/lane-mcp-server.js";

runLaneMcpStdio().catch((error) => {
  process.stderr.write(`Lane MCP server failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
