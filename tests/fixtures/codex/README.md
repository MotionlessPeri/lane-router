# Codex App Server fixture

`fake-app-server.mjs` emulates only the App Server protocol surface consumed by Lane Router. It supports version/schema probing and a loopback WebSocket server. Set `FAKE_CODEX_SCHEMA=incompatible` to remove required methods and exercise the startup gate.

`real-app-server-smoke.mjs` creates an isolated `CODEX_HOME` and workspace, copies an existing authentication file into that temporary home, starts a loopback App Server, creates a thread with a dynamic tool, completes a turn, disconnects, and verifies persisted history through a new connection. It removes the temporary tree and child process in `finally`. Its output contains identifiers and counts only.
