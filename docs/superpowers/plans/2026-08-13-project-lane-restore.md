# Project Lane Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an attached lane reopen the existing offline conversations for the other lanes in its own project with one explicit tool call.

**Architecture:** `RouterCore` owns project-scoped selection and delegates each active binding to a process-layer `ConversationRestorer`. Backends report actual client presence, while a focused Claude archive locator recovers legacy working directories and a shared Windows launcher opens visible PowerShell windows. Existing binding rows remain authoritative and keep their generation.

**Tech Stack:** TypeScript 7, Node.js 22, Zod, Vitest, SQLite (`better-sqlite3`), PowerShell `Start-Process`.

---

### Task 1: Startup metadata persistence

**Files:**
- Modify: `src/router/types.ts`
- Modify: `src/router/state-store.ts`
- Modify: `src/router/router-core.ts`
- Test: `tests/router/state-store.test.ts`
- Test: `tests/router/router-core.test.ts`

- [ ] Add a failing state-store test proving startup JSON can be updated without changing binding identity or generation.
- [ ] Add failing Router tests proving an optional trusted caller cwd is stored on attach and refreshed on later calls without changing generation.
- [ ] Run focused tests and confirm the missing API/behavior fails.
- [ ] Add optional trusted `cwd` to `CallerContext`, implement `updateBindingStartup`, and refresh metadata in existing caller-binding resolution.
- [ ] Run focused tests to green and refactor duplicated caller-binding/startup refresh logic.

### Task 2: Accurate backend presence

**Files:**
- Modify: `src/router/backend.ts`
- Modify: `src/backends/claude-backend.ts`
- Modify: `src/backends/codex-backend.ts`
- Modify: `src/adapters/codex/tui-bridge.ts`
- Modify: `src/adapters/codex/codex-runtime.ts`
- Test: `tests/backends/claude-backend.test.ts`
- Test: `tests/backends/codex-backend.test.ts`
- Test: `tests/process/local-transport.test.ts`
- Test: `tests/router/router-core.test.ts`
- Test: `tests/router/notification-pump.test.ts`
- Test: `tests/e2e/router-v1.test.ts`

- [ ] Add failing tests showing an open Claude channel is online, a closed channel is offline, disconnected Codex is unavailable, and Codex presence follows per-thread downstream TUI sockets rather than App Server thread status.
- [ ] Run the focused tests and confirm the new expectations fail.
- [ ] Add `restorePresence(binding)` to the backend contract and implement it for both backends.
- [ ] Track successful Codex `thread/start` and `thread/resume` ownership per downstream client; remove only that client's ownership on close.
- [ ] Run focused tests to green, including the duplicate-client close case.

### Task 3: Legacy Claude cwd recovery

**Files:**
- Create: `src/process/claude-session-locator.ts`
- Test: `tests/process/claude-session-locator.test.ts`

- [ ] Add failing locator tests for exact top-level session files, subagent exclusion, zero/multiple matches, invalid/nonexistent cwd, successful lookup, and Unicode paths.
- [ ] Run the tests and confirm the missing API fails.
- [ ] Implement exact UUID archive lookup and bounded line-by-line JSONL cwd extraction.
- [ ] Run focused tests to green.

### Task 4: Visible restore launcher and duplicate guard

**Files:**
- Create: `src/process/visible-terminal.ts`
- Create: `src/process/restore-terminal-child.ts`
- Create: `src/process/conversation-restorer.ts`
- Modify: `src/process/rotation-launcher.ts`
- Test: `tests/process/visible-terminal.test.ts`
- Test: `tests/process/conversation-restorer.test.ts`
- Test: `tests/process/rotation-launcher.test.ts`

- [ ] Add failing tests for the fixed `Start-Process -WindowStyle Normal` command and environment-only structured input.
- [ ] Add failing restorer tests for online/unavailable/launch success, exact Codex and Claude resume requests, legacy Claude backfill, invalid cwd, per-lane launch failure, and the 30-second in-memory reservation.
- [ ] Run focused tests and confirm failures.
- [ ] Extract the proven visible-terminal helper from rotation and implement the restore child argument arrays.
- [ ] Implement `ConversationRestorer` with presence checks, cwd validation/recovery, exact status reasons, and reservation cleanup/expiry.
- [ ] Run focused tests to green and confirm rotation tests still pass.

### Task 5: Public tool and project-scoped orchestration

**Files:**
- Modify: `src/tools/tool-contract.ts`
- Modify: `src/tools/tool-schema.ts`
- Modify: `src/tools/tool-service.ts`
- Modify: `src/router/router-core.ts`
- Modify: `src/process/main.ts`
- Test: `tests/tools/tool-service.test.ts`
- Test: `tests/router/router-core.test.ts`
- Test: `tests/process/router-start.test.ts`

- [ ] Add failing tests exposing `lane_restore_project`, validating its optional `lanes`, deriving the project from the attached caller, fully rejecting foreign/unknown subsets before any launch, returning current/inactive/per-binding results, and isolating one lane's failure from the rest.
- [ ] Run focused tests and confirm failures are caused by the missing tool and method.
- [ ] Add the fifth contract/schema/service case, add a compile-safe `LaneRestorePort` dependency to `RouterCore`, and wire the concrete restorer in `main.ts` plus test constructors.
- [ ] Run focused tests and `npm run typecheck` to green.

### Task 6: Adapter metadata, documentation, and regression

**Files:**
- Modify: `src/adapters/codex/dynamic-tools.ts`
- Modify: `src/adapters/codex/codex-runtime.ts`
- Modify: `src/mcp/lane-mcp-server.ts`
- Modify: `docs/manual-tests.md`
- Test: `tests/adapters/codex/dynamic-tools.test.ts`
- Test: `tests/mcp/lane-mcp-server.test.ts`
- Test: `tests/e2e/router-v1.test.ts`

- [ ] Add failing tests that trusted adapters forward cwd, the fifth tool appears in both Codex and Claude, and a restore call preserves binding generation.
- [ ] Run focused tests and confirm failures.
- [ ] Wire caller cwd capture; update instructions and the manual Windows acceptance case.
- [ ] Run focused tests to green.
- [ ] Run `npm run build` and the complete `npm test`; inspect `git diff --check` and preserve the two user-owned untracked files.
- [ ] Run the archived Windows manual acceptance case if the current environment permits interactive observation. If it cannot be observed end to end, report exactly which live claims remain unverified; do not call the feature live-accepted.

### Task 7: Existing Codex thread compatibility CLI

**Files:**
- Create: `src/process/project-restore-cli.ts`
- Modify: `package.json`
- Modify: `docs/manual-tests.md`
- Test: `tests/process/project-restore-cli.test.ts`

- [ ] Add failing tests for no-argument restore, explicit peer subset, missing `CODEX_THREAD_ID`, Router errors, and JSON output.
- [ ] Run the focused test and confirm the CLI is missing.
- [ ] Implement the thin CLI over `ensureRouter` and `LocalRouterClient.call`; do not duplicate restore selection or launch logic.
- [ ] Add the bin entry and document that old Codex coordinators use the CLI because `thread/resume` cannot refresh dynamic tools.
- [ ] Run focused tests, typecheck, build, complete tests, and `git diff --check`.
