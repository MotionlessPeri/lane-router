# Dashboard Lane Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Router-served dashboard reopen selected lanes across multiple projects, with strict one-launch `model`, `profile`, and `modelProvider` overrides.

**Architecture:** Extend the existing loopback dashboard and `ConversationRestorer` rather than adding a second local service. The dashboard sends one token-protected same-origin request; a small process-layer orchestrator validates the whole selection before restoring any lane. Codex provider bridges carry a process-local `transient` startup marker so `lane_attach_current` preserves the previous binding startup instead of persisting the temporary override.

**Tech Stack:** TypeScript, Node HTTP/WebSocket server, SQLite-backed `RouterStateStore`, Vitest, happy-dom for dashboard rendering.

---

### Task 0: Isolate the provider prerequisite

**Files:**
- Carry forward: the validated GLM provider/profile changes currently uncommitted in `D:\my_projects\lane-router`
- Carry forward: `src/process/codex-profiles.ts`
- Carry forward: `tests/process/codex-profiles.test.ts`

- [x] Create the feature worktree from `master`.
- [x] Copy the provider/profile slice into the worktree without modifying the source worktree.
- [x] Run `npm run typecheck`; expect PASS.
- [x] Run `npm test`; expect 35 files / 329 tests PASS.
- [ ] Keep this prerequisite in a separate commit before dashboard work.

### Task 1: Publish launcher facts in the dashboard snapshot

**Files:**
- Modify: `src/router/dashboard.ts`
- Test: `tests/router/dashboard-state.test.ts`

- [x] Write a failing assertion that a bound lane exposes `restorePresence` and its saved Codex `profile` / `modelProvider`.
- [x] Run `npx vitest run tests/router/dashboard-state.test.ts`; expect the new field assertions to FAIL.
- [x] Extend `DashboardBinding` and `dashboardSnapshot` to read those facts from the backend and binding startup.
- [x] Re-run the focused test; expect PASS.

### Task 2: Add one-launch overrides to `ConversationRestorer`

**Files:**
- Modify: `src/process/conversation-restorer.ts`
- Modify: `src/process/terminal-spawn.ts`
- Test: `tests/process/conversation-restorer.test.ts`
- Test: `tests/process/terminal-spawn.test.ts`

- [x] Write failing tests proving an override replaces only the outgoing request's `model`, `profile`, and `modelProvider`, marks the request `transientStartup`, and leaves `lane.model` and the stored binding unchanged.
- [x] Run the focused restorer test; expect FAIL because `restore(binding, override)` does not exist.
- [x] Add a validated `RestoreOverride` argument and pass `transientStartup: true` only when profile/provider is overridden.
- [x] Re-run the focused test; expect PASS.

### Task 3: Orchestrate multi-project opening

**Files:**
- Create: `src/process/dashboard-lane-opener.ts`
- Create: `tests/process/dashboard-lane-opener.test.ts`

- [x] Write failing tests for: canonical address deduplication, empty selection rejection, missing/unbound lane rejection, Claude-plus-provider rejection, all-before-any-launch validation, and sequential restore results.
- [x] Run the new test file; expect import/type FAIL because the opener does not exist.
- [x] Implement a small dependency-injected orchestrator over `RouterStateStore` and `ConversationRestorer`.
- [x] Re-run the focused test; expect PASS.

### Task 4: Protect and expose the HTTP action

**Files:**
- Modify: `src/process/local-server.ts`
- Modify: `src/process/main.ts`
- Test: `tests/process/dashboard-endpoints.test.ts`
- Test: `tests/process/local-transport.test.ts`

- [x] Write failing endpoint tests for same-origin `Origin`, `X-Lane-Router-Action`, JSON content type, action-token equality, optional-endpoint 404, and no invocation on any failed gate.
- [x] Run focused endpoint tests; expect FAIL.
- [x] Generate a per-Router action token, expose it only when the opener is wired, validate the whole request before invoking the opener, and return per-lane results.
- [x] Re-run focused endpoint tests; expect PASS.

### Task 5: Render selection and overrides safely

**Files:**
- Modify: `src/process/dashboard.html`
- Test: `tests/process/dashboard-render.test.ts`

- [x] Write failing happy-dom tests for project grouping, default offline selection, per-lane and per-project selection, override controls, disabled action without a token, and a POST using DOM-created values rather than `innerHTML`.
- [x] Run the render test; expect FAIL.
- [x] Extend the self-contained page with a launcher panel and result list.
- [x] Re-run the render test; expect PASS.

### Task 6: Preserve transient Codex startup metadata

**Files:**
- Modify: `src/adapters/codex/tui-bridge.ts`
- Modify: `src/adapters/codex/codex-runtime.ts`
- Modify: `src/process/codex-launcher.ts`
- Modify: `src/router/router-core.ts`
- Modify: `src/router/types.ts`
- Test: `tests/process/local-transport.test.ts`
- Test: `tests/process/codex-launcher.test.ts`
- Test: `tests/router/router-core.test.ts`

- [x] Write failing tests proving a transient provider endpoint sends `persistStartup: false`, reports `{ transient: true, ... }` to `claimThread`, and makes `attachCurrent` reuse the previous binding startup.
- [x] Run focused tests; expect FAIL.
- [x] Carry the transient flag through terminal environment, provider endpoint creation, runtime startup metadata, and binding replacement.
- [x] Re-run focused tests; expect PASS.

### Task 7: Full regression and manual evidence

**Files:**
- Modify: `docs/manual-tests.md`

- [x] Run `npm run typecheck`; expect PASS.
- [x] Run `npm run build`; expect PASS.
- [x] Run `npm test`; expect all tests PASS.
- [x] Add a manual case for a real isolated Codex lane reopened once with `glm-5.3` / `glm` / `ZAI`, then reopened normally with the old declaration and startup metadata.
- [ ] Run the isolated real-CLI case only after automated tests are green.

### Task 8: Commit boundaries

- [ ] Commit the provider prerequisite separately.
- [ ] Commit launcher behavior and tests.
- [ ] Commit dashboard UI and documentation.
- [ ] Do not push unless the user explicitly asks.
