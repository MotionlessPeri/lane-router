import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { PlatformBackend } from "../router/backend.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { BindingRecord } from "../router/types.js";
import { ClaudeSessionLookupError, type ClaudeSessionLocator } from "./claude-session-locator.js";
import {
  childEnvironment, newStatusPath, resolveTerminal, spawnTerminal, terminalLaunchScript, wtOnPath,
  type TerminalChildRequest,
} from "./terminal-spawn.js";

export type RestoreResult =
  | { readonly status: "launch_requested" | "skipped_online" | "skipped_launching" }
  | { readonly status: "failed"; readonly reason: "session_not_found" | "invalid_startup_cwd" | "backend_unavailable" | "terminal_launch_failed"; readonly message: string };

interface RestorerDependencies {
  readonly state: RouterStateStore;
  readonly backends: { require(name: "codex" | "claude"): Pick<PlatformBackend, "restorePresence"> };
  readonly claudeSessions: Pick<ClaudeSessionLocator, "locate">;
  readonly fallbackCwd: string;
  readonly dataRoot: string;
  readonly launch?: (request: TerminalChildRequest, title: string) => Promise<void>;
  readonly now?: () => number;
}

const RESERVATION_MS = 30_000;

export class ConversationRestorer {
  private readonly reservations = new Map<string, number>();
  constructor(private readonly dependencies: RestorerDependencies) {}

  async restore(binding: BindingRecord): Promise<RestoreResult> {
    const now = (this.dependencies.now ?? Date.now)();
    const reservedUntil = this.reservations.get(binding.id) ?? 0;
    if (reservedUntil > now) return { status: "skipped_launching" };
    this.reservations.set(binding.id, Number.POSITIVE_INFINITY);
    let presence;
    try {
      presence = this.dependencies.backends.require(binding.backend).restorePresence(binding);
    } catch (error) {
      return this.release(binding.id, failure("backend_unavailable", error instanceof Error ? error.message : `${binding.backend} backend is unavailable`));
    }
    try {
      if (presence === "online") return this.release(binding.id, { status: "skipped_online" });
      if (presence === "unavailable") return this.release(binding.id, failure("backend_unavailable", `${binding.backend} backend is unavailable`));
      const cwd = await this.resolveCwd(binding);
      const request = {
        mode: "resume", backend: binding.backend, conversationId: binding.conversationId, cwd,
        statusPath: newStatusPath(this.dependencies.dataRoot),
      } satisfies TerminalChildRequest;
      await (this.dependencies.launch ?? launchRestoreTerminal)(request, `${binding.laneAddress} gen${binding.generation}`);
      this.reservations.set(binding.id, (this.dependencies.now ?? Date.now)() + RESERVATION_MS);
      return { status: "launch_requested" };
    } catch (error) {
      this.reservations.delete(binding.id);
      if (error instanceof ClaudeSessionLookupError) {
        return failure(error.code === "SESSION_NOT_FOUND" ? "session_not_found" : "invalid_startup_cwd", error.message);
      }
      if (error instanceof InvalidStartupCwdError) return failure("invalid_startup_cwd", error.message);
      return failure("terminal_launch_failed", error instanceof Error ? error.message : "Terminal launch failed");
    }
  }

  private async resolveCwd(binding: BindingRecord): Promise<string> {
    const stored = binding.startup.cwd;
    if (stored !== undefined) return requireDirectory(stored, binding.laneAddress);
    if (binding.backend === "codex") return requireDirectory(this.dependencies.fallbackCwd, binding.laneAddress);
    const cwd = await this.dependencies.claudeSessions.locate(binding.conversationId);
    this.dependencies.state.updateBindingStartup(binding.id, { ...binding.startup, cwd });
    return cwd;
  }

  private release<T extends RestoreResult>(bindingId: string, result: T): T {
    this.reservations.delete(bindingId);
    return result;
  }
}

class InvalidStartupCwdError extends Error {}

function requireDirectory(value: unknown, laneAddress: string): string {
  try {
    if (typeof value === "string" && isAbsolute(value) && existsSync(value) && statSync(value).isDirectory()) return value;
  } catch { /* a path that disappears or becomes unreadable is not safe launch metadata */ }
  throw new InvalidStartupCwdError(`Lane ${laneAddress} has no existing absolute startup cwd`);
}

function failure(reason: Extract<RestoreResult, { status: "failed" }>["reason"], message: string): RestoreResult {
  return { status: "failed", reason, message };
}

/**
 * The shared terminal machinery carries three things this path used to lack: the vendor-env
 * scrub (the Router inherits CLAUDE_* from whichever session first ensured it, and an unscrubbed
 * restored client resolves to that conversation instead of its own), the verified cmd/wt quoting,
 * and a window title. The status file is written for later diagnosis but deliberately not
 * awaited: `launch_requested` stays the weak claim the restore contract documents, and a batch
 * restore must not serialise on thirty-second waits.
 */
async function launchRestoreTerminal(request: TerminalChildRequest, title: string): Promise<void> {
  const resolved = resolveTerminal(undefined, wtOnPath(process.env));
  await spawnTerminal(request, childEnvironment(request, process.env, title, resolved.shell), terminalLaunchScript(resolved));
}
