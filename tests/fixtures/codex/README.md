# Codex App Server fixture

`fake-app-server.mjs` emulates only the App Server protocol surface consumed by Lane Router. It supports version/schema probing and a loopback WebSocket server. Set `FAKE_CODEX_SCHEMA=incompatible` to remove required methods and exercise the startup gate.

`real-app-server-smoke.mjs` requires `EXPECTED_RUNTIME_SHA` to be the full 40-character commit SHA of the built implementation under test, in addition to the Codex executable and authentication environment variables documented in `docs/manual-tests.md`.

`real-app-server-smoke.mjs` imports the built production runtime, process manager, client, broker, scheduler, and SQLite storage. It creates an isolated `CODEX_HOME` and workspace, copies an existing authentication file into that temporary home, advertises all eight tools, drives a body-free broker wake, verifies the requested tool effect, stops the first runtime, and verifies persisted history through a fresh production runtime. It removes the database, temporary tree, copied authentication file, child processes, and ports in `finally`. Child streams are discarded; output contains stages, identifiers, and counts only.
