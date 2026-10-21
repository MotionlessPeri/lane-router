// A stand-in for the `claude` CLI, for scripts/install-channel-plugin.ps1. It keeps the machine's
// plugin state in the JSON file FAKE_CLAUDE_STATE names, answers the few commands the script uses,
// and records every call so a test can see exactly what the script asked for.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => writeFileSync(path, JSON.stringify(state, null, 2));
const say = (text) => process.stdout.write(`${text}\n`);
const command = args.filter((arg) => !arg.startsWith("-")).slice(0, 3).join(" ");

let code = 0;
if (args[0] === "plugin" && args[1] === "validate") say("✔ Validation passed");
else if (command.startsWith("plugin marketplace list")) say(JSON.stringify(state.marketplaces));
else if (command.startsWith("plugin marketplace add")) { state.marketplaces.push({ name: "lane-local", source: "directory", path: args[3] }); say("added"); }
else if (command.startsWith("plugin list")) say(JSON.stringify(state.plugins));
else if (command.startsWith("plugin install")) { state.plugins.push({ id: args[2], scope: args[args.indexOf("--scope") + 1], enabled: true }); say("installed"); }
else if (command === "mcp get lane") {
  if (state.userLane) say("lane:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected");
  else { process.stderr.write("No MCP server named \"lane\".\n"); code = 1; }
}
else if (command === "mcp remove lane") { state.userLane = false; say("Removed MCP server lane from user config"); }
else { process.stderr.write(`fake claude: unexpected ${args.join(" ")}\n`); code = 9; }
save();
process.exit(code);
