# Manual integration tests

These cases verify the experimental Codex App Server boundary that deterministic unit tests cannot cover. They use disposable state and record identifiers only; prompt bodies, model responses, credentials, and authentication-file contents must not be captured.

## TC-CODEX-001: Installed capability gate

**Goal**: Verify that the installed executable exposes the exact experimental protocol consumed by Lane Router before a managed server starts.

**Fixture**: `tests/fixtures/codex/fake-app-server.mjs` for negative startup-gate coverage; installed Codex for the real schema probe.

**Setup**: Codex executable at `C:\Users\KrabsXD\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`.

**Steps**:

1. Run `codex --version`.
2. Generate the schema into a new temporary directory with `codex app-server generate-json-schema --experimental --out <temporary-directory>`.
3. Run the capability-gate test with `npm test -- --run tests/adapters/codex/app-server-client.test.ts`.
4. Confirm the incompatible fake schema raises `CODEX_CAPABILITY_INCOMPATIBLE` before the injected spawn seam is called.

**Expected**: The real schema includes `initialize`, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `turn/steer`, `dynamicTools`, and `item/tool/call`. The dynamic call requires `threadId`, `turnId`, `callId`, `tool`, and `arguments`. A changed executable, version, or schema produces a different fingerprint and is revalidated.

**Last verified**: 2026-08-07 on Codex CLI 0.146.1, M4 commit placeholder. Schema fingerprint: `fd55f76cc8eba025b64d79aaea1d0bc48a115069604f716b326926b36c407eb4`.

## TC-CODEX-002: Disposable real App Server turn and resume

**Goal**: Verify a broker-style controller can create a disposable thread, receive and answer a dynamic Lane Router tool call using authoritative App Server identifiers, detach, and recover history on a new connection without a TUI.

**Fixture**: `tests/fixtures/codex/real-app-server-smoke.mjs`.

**Setup**: Set `CODEX_EXE` to the installed executable and `CODEX_AUTH_FILE` to an existing authentication file. The fixture copies the file without reading or logging its contents.

**Steps**:

1. Run `$env:CODEX_EXE='C:\Users\KrabsXD\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe'`.
2. Run `$env:CODEX_AUTH_FILE='C:\Users\KrabsXD\.codex\auth.json'`.
3. Run `node tests/fixtures/codex/real-app-server-smoke.mjs`.
4. Confirm the JSON result contains only `endpointHost`, `threadId`, `turnId`, `callId`, and `resumedTurnCount`.
5. Confirm no Codex App Server child remains and the printed loopback port is closed.

**Expected**: The controller initializes over `127.0.0.1`, starts a thread containing the strict `lane_whoami` dynamic tool, receives one `item/tool/call` whose `threadId` and `turnId` match the active conversation, answers it, observes `turn/completed`, disconnects, and resumes the same thread with at least one persisted turn. The fixture removes its temporary `CODEX_HOME`, copied authentication file, workspace, thread data, child process, and port.

**Last verified**: 2026-08-07 on Codex CLI 0.146.1, M4 commit placeholder.

**Evidence**: Thread `019fdb0b-8d4c-76f0-9074-eee7e9c0df3b`; turn `019fdb0b-8da6-70f3-98bd-57ff7d1596f5`; dynamic call `exec-57791eec-f999-4a5c-9d97-52de64c7ab3b`; resumed turn count `1`. The first run reached a real turn but model streaming timed out five times before HTTP fallback; the second run used a 300-second fixture deadline and completed in 155 seconds.

**Optional observer**: A remote Codex TUI subscription was not automated in this environment. The App Server listener supports an additional observer connection; controller ownership of `item/tool/call` responses remains enforced by the single dispatcher instance and duplicate-call operation key.
