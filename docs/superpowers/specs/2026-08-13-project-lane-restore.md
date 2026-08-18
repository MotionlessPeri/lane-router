# Project Lane Restore Design

## Purpose

After a machine restart, the user manually resumes one primary lane and asks it to reopen the other lanes in the same project. Lane Router must restore those lanes' existing Codex threads or Claude sessions in visible terminal windows. It must not create replacement conversations, change lane generations, or require the user to reopen every lane manually.

## Public contract

Lane Router adds a fifth agent-facing tool:

```text
lane_restore_project({ lanes?: string[] })
```

Codex 0.147 cannot add a new dynamic tool when resuming a thread that was created with the original four-tool list. For those existing coordinator threads, the package also exposes a thin compatibility CLI:

```text
lane-router-restore-project [lane-address ...]
```

The CLI accepts no project or caller identity argument. It requires the authoritative `CODEX_THREAD_ID` exported to the current Codex shell, ensures the Router, and calls the same `lane_restore_project` operation with `backend=codex`. No lane arguments means all peers; positional lane addresses mean the optional subset. A shell without `CODEX_THREAD_ID`, or a thread without an active binding, fails without launching anything. New Codex threads and Claude continue to use the agent-facing tool.

The caller must already be attached. The Router derives the project from that binding; the caller cannot name another project. With no `lanes`, the tool considers every other lane in the project. With `lanes`, every address must belong to the caller's project and the Router considers only that deduplicated subset.

The response contains one result per considered lane in directory order:

```json
{
  "project": "slay_the_spire_ai",
  "results": [
    { "address": "slay_the_spire_ai/research", "status": "launch_requested" },
    { "address": "slay_the_spire_ai/tests", "status": "skipped_online" }
  ]
}
```

Statuses are `launch_requested`, `skipped_current`, `skipped_online`, `skipped_launching`, `skipped_inactive`, or `failed`. A failed result also contains a stable reason (`session_not_found`, `invalid_startup_cwd`, `backend_unavailable`, or `terminal_launch_failed`) and a human-readable message. `launch_requested` means Windows accepted the visible-terminal creation request; it does not claim that the restored client finished starting or attached its lifecycle channel.

Restoration opens terminal windows and therefore remains an explicit tool call. Its description tells agents to call it only after the user asks to reopen lanes. It is not a topology change and does not require the confirmation used by `lane_attach_current`.

## Selection and online checks

`RouterCore` resolves the caller's active binding before doing anything else. It rejects an address outside the caller's project and an unknown explicitly requested address. Default selection includes inactive lane records so the result can say `skipped_inactive`; it always skips the caller itself.

The existing synchronous `reach` snapshot is diagnostic rather than a sufficient launch predicate. Each backend therefore gains an explicit restore-readiness operation:

- Claude reports loaded whenever the bound conversation has an open lifecycle channel. `live` and `unconfirmed` channels both count as loaded, because both already have a client process and reopening either would duplicate a window.
- Codex uses the TUI bridge's connection registry, not App Server thread status. The bridge associates each successful `thread/start` or `thread/resume` response with the downstream WebSocket that requested it and removes that association when the socket closes. This distinguishes an open visible client from a thread that remains loaded in the shared App Server after its terminal closed or because Router notifications loaded it.
- A disconnected Codex App Server produces `failed/backend_unavailable`; the Router does not request a terminal that cannot connect to its adapter. When the App Server is connected and no TUI owns the thread, the conversation is offline and restorable.

The Router processes lanes independently. A failure for one lane does not prevent requests for the rest.

## Startup metadata

The existing `bindings.startup_json` column stores the working directory; no schema change is needed:

```json
{ "cwd": "D:\\my_projects\\slay_the_spire_ai" }
```

`CallerContext` carries an optional `cwd` supplied only by trusted local adapters:

- Claude MCP supplies its process working directory on every tool call.
- The Codex TUI bridge remembers the `cwd` from `thread/start`, associates it with the returned thread ID, and supplies it on dynamic tool calls in that Router lifetime.

Creating a binding stores the available cwd. A later call from the same bound conversation refreshes missing or changed startup metadata without changing the binding ID or generation.

Codex resume restores the thread's recorded cwd, so an old Codex binding with empty startup metadata may use the Lane Router package directory merely as the terminal process's launch directory.

For an old Claude binding with empty startup metadata, a `ClaudeSessionLocator` performs an on-demand migration from Claude Code's local session archive. It looks only for the exact top-level file `~/.claude/projects/*/<session-id>.jsonl`, reads JSON records until it finds that session's recorded absolute `cwd`, validates that the directory still exists, and writes the recovered value into the binding's existing `startup_json`. No project-directory name is decoded and subagent transcripts are ignored. No match or multiple matches returns `failed/session_not_found`; a missing, relative, or nonexistent recorded directory returns `failed/invalid_startup_cwd`. Thus existing Claude lanes remain one-click restorable without guessing the primary lane's directory.

Before every launch, a stored cwd must be an absolute existing directory. Invalid metadata fails that lane rather than falling back to another conversation's directory.

## Terminal launch

A focused `ConversationRestorer` owns process launch. The Router passes it only a binding and validated cwd. On Windows it uses the already proven two-stage path:

```powershell
Start-Process -FilePath powershell.exe -WindowStyle Normal
```

The fixed PowerShell command contains no lane address, session ID, or working directory. Structured data travels through a dedicated environment variable to a small terminal-child module, which deletes the variable before spawning the client with an argument array.

The child runs:

```text
node <codex-launcher.js> resume <thread-id>
claude --resume <session-id> --dangerously-load-development-channels server:lane
```

No initial prompt is sent because these are existing conversations. The operation does not call `lane_attach_current`, modify binding generation, write a handoff, or rename a conversation.

## Duplicate-launch protection

`ConversationRestorer` keeps a Router-process-local reservation keyed by binding ID. Reservation occurs synchronously before the asynchronous online check. It is released when the lane proves online or launch fails, and retained for 30 seconds after Windows accepts a launch request. A second request during that interval returns `skipped_launching`.

This guard deliberately is not durable. It prevents ordinary concurrent clicks without adding a database table, recovery queue, retry daemon, or process supervisor. A user may retry after the short interval if a client failed after terminal creation.

## Scope exclusions

This feature does not add automatic startup at login, cross-project restore, background retries, terminal closure, binding replacement, a new conversation, a handoff protocol, or durable process state. It does not update the global npm link or commit user-owned untracked files.

## Verification

Automated tests cover tool schema exposure, project scoping, default and explicit selection, current/online/inactive/launching results, per-lane failure isolation, startup metadata persistence, exact Codex and Claude resume argument arrays, the fixed `Start-Process -WindowStyle Normal` command, and preservation of binding generation.

A manual Windows case extends `docs/manual-tests.md`: resume a primary lane after all peer clients are closed, call `lane_restore_project`, observe one visible PowerShell per offline peer, and verify each terminal shows the original conversation history and remains attached to its original lane. This human-visible end-to-end case is not claimed verified until it is actually run.
