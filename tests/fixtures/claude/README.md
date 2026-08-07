# Claude Channel fixtures

`fake-channel-client.mjs` is the deterministic MCP client used by `lane-mcp-stdio.test.ts`. It spawns the production stdio entrypoint, advertises the experimental Claude Channel capability, and exposes received notifications to the test without interpreting message bodies.

`real-channel-smoke.mjs` is a bounded manual fixture for an installed Claude CLI. It creates a temporary broker database and Claude config directory, copies the selected settings file without printing its contents, launches Claude through `pty-host.py`, and removes all temporary state on exit. The fixture checks idle and busy wake acceptance, model-driven claim and acknowledgment, disconnected pending behavior, and reconnect recovery. `pywinpty` is required on Windows.

Build first, then set `CLAUDE_SETTINGS_FILE` to the home Kimi settings file and optionally set `CLAUDE_EXE`, `CLAUDE_VERSION`, and `CLAUDE_CHANNEL_SMOKE_TIMEOUT_MS`. Run `node tests/fixtures/claude/real-channel-smoke.mjs`. Its output contains only the stage, version, acceptance results, counts, reconnect flag, TUI flag, and elapsed time. It never prints credentials, prompts, message bodies, or model responses.

The real fixture fails closed when Claude presents an interactive research-preview or organization-policy confirmation. Do not bypass such a gate by copying account state or requiring a person to approve it during an automated run; record the blocked result in `docs/manual-tests.md` instead.
