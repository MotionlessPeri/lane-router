# Claude Channel manual fixture

The V1 production boundary is exercised by the Claude section of `docs/manual-tests.md`. It uses the four-tool stdio MCP server, `CLAUDE_CODE_SESSION_ID`, the lifecycle hook, and file mailbox paths. The former credential-bound eight-tool fixture was removed with the legacy broker model.

`pty-host.py` remains available for an isolated interactive Claude CLI run. No real-model result is part of the automated test gate.
