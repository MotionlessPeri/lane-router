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

**Last verified**: 2026-08-07 on Codex CLI 0.146.1 and production-runtime commit `0569261f947c5cfeff4471c88c60353f21e33e66`. Two consecutive probes produced executable/version/schema fingerprint `5bbc27ab20a514a3bd49c4f38a83989d0950c1b07c2d848b2607d51335eb38d1`; the second was a cache hit. Canonical schema fingerprint: `8aac2cf925bc06a6ac4b71095115e201691aa629aa965eab39ecb219acd44b17`.

## TC-CODEX-002: Disposable real App Server turn and resume

**Goal**: Verify a broker-style controller can create a disposable thread, receive and answer a dynamic Lane Router tool call using authoritative App Server identifiers, detach, and recover history on a new connection without a TUI.

**Fixture**: `tests/fixtures/codex/real-app-server-smoke.mjs`.

**Setup**: Set `CODEX_EXE` to the installed executable and `CODEX_AUTH_FILE` to an existing authentication file. The fixture copies the file without reading or logging its contents.

**Steps**:

1. Run `npm run build` so the fixture imports the committed production modules from `dist`.
2. Run `$env:CODEX_EXE='C:\Users\KrabsXD\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe'`.
3. Run `$env:CODEX_AUTH_FILE='C:\Users\KrabsXD\.codex\auth.json'` and `$env:CODEX_VERSION='0.146.1'`.
4. Run `node tests/fixtures/codex/real-app-server-smoke.mjs`.
5. Confirm the JSON result contains only the sanitized stage, version, production-runtime commit, anonymous IDs, counts, and `tuiAttached` flag.
6. Confirm no Codex App Server child remains and no fixture temporary directory remains.

**Expected**: The production runtime initializes over `127.0.0.1`, starts a thread containing all eight strict Lane Router tools, and the production scheduler sends a wake containing ordered IDs but no message body. The model fetches the message through `lane_message_get`, identifies itself through `lane_whoami`, and performs one `lane_send`; the real broker database contains exactly one expected effect. After the first runtime stops, a fresh production runtime resumes the same thread with at least one persisted turn. The fixture removes its SQLite database, temporary `CODEX_HOME`, copied authentication file, workspace, thread data, child processes, and ports.

**Last verified**: 2026-08-07 on Codex CLI 0.146.1 and production-runtime commit `0569261f947c5cfeff4471c88c60353f21e33e66`.

**Evidence**: Thread `019fdb32-b7b6-7412-9731-9835ae631086`; turn `019fdb32-b81b-7370-8bb5-e067f0d0f8ad`; dynamic calls `exec-89d70ee8-8f36-42ea-9543-d23f9ff516e0`, `exec-1476d87b-9085-4b92-b7a6-ca7d78d0e109`, and `exec-4d317d2e-e4d4-4471-9947-d4ee0fa4ce80`; advertised tool count `8`; observed tool count `3`; verified broker effect count `1`; resumed turn count `1`; TUI attached `false`. The production run completed in 169 seconds. During the earlier M4 characterization, the first sampling run timed out five times before HTTP fallback and the bounded retry completed in 155 seconds; the production fixture therefore retains one 300-second deadline and performs no infinite retry.

**Optional observer**: A remote Codex TUI subscription was not automated or claimed as verified. No TUI was attached during the broker-driven turn. Controller ownership of `item/tool/call` responses is enforced by the production runtime's single dispatcher and deterministic duplicate-call operation key.
