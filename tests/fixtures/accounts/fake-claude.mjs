// Stands in for `claude -p ... --output-format stream-json --verbose`. It records what it was started
// with (token, config directory, working directory, arguments and every CLAUDE*/ANTHROPIC* variable
// name) to FAKE_CLAUDE_RECORD, then behaves according to the token it was given:
//   ...-good-...   prints a rate_limit_event like the real CLI and exits 0
//   ...-other-...  the same with different numbers, to tell two accounts apart
//   ...-bad-...    reports an authentication error and exits 1
//   ...-silent-... answers normally but without any rate_limit_event
//   ...-hang-...   never finishes
import { appendFileSync } from "node:fs";

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
if (process.env.FAKE_CLAUDE_RECORD) {
  appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify({
    token,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    cwd: process.cwd(),
    args: process.argv.slice(2),
    vendorKeys: Object.keys(process.env).filter((key) => /^(claude|anthropic)/iu.test(key)).sort(),
  })}\n`);
}

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const windows = (fiveHour, sevenDay) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: 1_792_400_000 },
      seven_day: { utilization: sevenDay, resetsAt: 1_792_900_000 },
    },
  },
  session_id: "fake",
});

if (token.includes("-hang-")) {
  setInterval(() => {}, 1_000);
} else if (token.includes("-bad-")) {
  line({ type: "system", subtype: "init", session_id: "fake" });
  line({ type: "result", subtype: "success", is_error: true, result: "Invalid bearer token", session_id: "fake" });
  process.exitCode = 1;
} else if (token.includes("-silent-")) {
  line({ type: "system", subtype: "init", session_id: "fake" });
  line({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "fake" });
} else {
  line({ type: "system", subtype: "init", session_id: "fake" });
  line(windows(token.includes("-other-") ? 0.9 : 0.37, token.includes("-other-") ? 0.5 : 0.12));
  line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, session_id: "fake" });
  line({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "fake" });
}
