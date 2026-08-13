import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlatformBackend } from "../router/backend.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { BindingRecord } from "../router/types.js";
import { ClaudeSessionLookupError, type ClaudeSessionLocator } from "./claude-session-locator.js";
import { launchVisibleTerminal } from "./visible-terminal.js";

export interface RestoreRequest {
  readonly backend: "codex" | "claude";
  readonly conversationId: string;
  readonly cwd: string;
}

export type RestoreResult =
  | { readonly status: "launch_requested" | "skipped_online" | "skipped_launching" }
  | { readonly status: "failed"; readonly reason: "session_not_found" | "invalid_startup_cwd" | "backend_unavailable" | "terminal_launch_failed"; readonly message: string };

interface RestorerDependencies {
  readonly state: RouterStateStore;
  readonly backends: { require(name: "codex" | "claude"): Pick<PlatformBackend, "restorePresence"> };
  readonly claudeSessions: Pick<ClaudeSessionLocator, "locate">;
  readonly fallbackCwd: string;
  readonly launch?: (request: RestoreRequest) => Promise<void>;
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
      const request = { backend: binding.backend, conversationId: binding.conversationId, cwd } satisfies RestoreRequest;
      await (this.dependencies.launch ?? launchRestoreTerminal)(request);
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

export function restoreClientCommand(request: RestoreRequest, paths: { nodePath: string; codexLauncherPath: string; claudeExe: string }) {
  return request.backend === "codex"
    ? { executable: paths.nodePath, args: [paths.codexLauncherPath, "resume", request.conversationId] }
    : { executable: paths.claudeExe, args: ["--resume", request.conversationId, "--dangerously-load-development-channels", "server:lane"] };
}

async function launchRestoreTerminal(request: RestoreRequest): Promise<void> {
  const childPath = resolve(dirname(fileURLToPath(import.meta.url)), "restore-terminal-child.js");
  await launchVisibleTerminal({ cwd: request.cwd, childPath, requestName: "LANE_ROUTER_RESTORE_REQUEST", request });
}
