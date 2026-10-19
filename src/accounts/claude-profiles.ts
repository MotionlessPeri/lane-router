import { randomUUID } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readClaudeUsage, type ClaudeCommand, type ClaudeUsage } from "./claude-usage.js";
import { AccountError } from "./contracts.js";
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson } from "./private-storage.js";

export const CLAUDE_PROFILES_FILE = "claude-profiles.json";
/** Per-account Claude config directories, one per account id, inside this service's private root. */
const CONFIG_DIRECTORY = "claude-config";
/** Written by the build that switched new lanes to a selected account; only ever removed now. */
const LEGACY_LAUNCH_FILE = "claude-launch.json";

/**
 * What `claude setup-token` prints: a long-lived OAuth token, which Claude Code never rotates. A
 * console API key (`sk-ant-api…`) would also start a session, but billed to the API rather than
 * the subscription whose limits this page shows, so it is refused rather than quietly accepted.
 */
const SETUP_TOKEN = /^sk-ant-oat[A-Za-z0-9_-]{10,400}$/;
const PROFILE_ID = /^claude-[a-z0-9-]{1,72}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

interface UsageReading extends ClaudeUsage { checkedAt: number }
interface UsageFailure { at: number; code: string }
interface StoredClaudeProfile {
  id: string; email: string; token: string; createdAt: number;
  usage?: UsageReading; usageError?: UsageFailure;
}

/** What leaves this module for the page: everything but the token. */
export interface PublicClaudeProfiles {
  profiles: Array<{
    id: string; email: string; createdAt: number;
    /** The last successful reading, kept when a later refresh fails. */
    usage: UsageReading | null;
    /** The last refresh, when it failed and nothing has succeeded since. */
    usageError: UsageFailure | null;
    refreshing: boolean;
  }>;
}

/**
 * Claude accounts whose remaining limits the account page shows. Claude Code has no way to switch a
 * running session's account from outside, so the page does not switch anything: it shows how much
 * of each account is left, and the user moves a lane with `/login` in its window.
 *
 * An account is a setup token: the one Claude credential that does not rotate, so it can be kept
 * and used again. The tokens sit in this service's private directory, under the same
 * owner-and-SYSTEM ACL as Claude's own `~/.claude/.credentials.json`; Claude Code reads no keyring
 * this service could use instead. A reading costs one tiny turn on that account, which is why it is
 * taken only when asked for.
 */
export class ClaudeProfiles {
  private profiles: StoredClaudeProfile[] = [];
  private mutations: Promise<void> = Promise.resolve();
  private readonly refreshing = new Map<string, Promise<PublicClaudeProfiles>>();
  private initialized = false;

  constructor(private readonly options: {
    root: string;
    now?: () => number;
    usage?: { command?: ClaudeCommand; environment?: NodeJS.ProcessEnv; timeoutMs?: number };
  }) {}

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.options.root);
    const data = await readPrivateJson(join(this.options.root, CLAUDE_PROFILES_FILE));
    if (data !== undefined) {
      const stored = parseStored(data);
      if (!stored) throw new AccountError("STORAGE_UNAVAILABLE");
      this.profiles = stored;
    }
    // Nothing reads the launch file any more, and it still holds the token of whichever account
    // was selected when it was written.
    try { await unlink(join(this.options.root, LEGACY_LAUNCH_FILE)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AccountError("STORAGE_UNAVAILABLE"); }
    this.initialized = true;
  }

  listPublic(): PublicClaudeProfiles {
    return {
      profiles: this.profiles.map(({ id, email, createdAt, usage, usageError }) => ({
        id, email, createdAt, usage: usage ?? null, usageError: usageError ?? null, refreshing: this.refreshing.has(id),
      })),
    };
  }

  /** The email is the user's own label for the account; nothing here checks it against the token. */
  add(email: string, token: string): Promise<PublicClaudeProfiles> {
    return this.mutate(async () => {
      const label = email.trim();
      const secret = token.trim();
      if (!SETUP_TOKEN.test(secret)) throw new AccountError("INVALID_CLAUDE_TOKEN");
      if (!validEmail(label)) throw new AccountError("INVALID_CLAUDE_EMAIL");
      const next = [...this.profiles, { id: `claude-${randomUUID()}`, email: label, token: secret, createdAt: this.now() }];
      await this.persist(next);
      this.profiles = next;
    });
  }

  /** The account's config directory goes too: it holds what Claude kept of that login. */
  remove(profileId: string): Promise<PublicClaudeProfiles> {
    return this.mutate(async () => {
      if (!this.profiles.some(profile => profile.id === profileId)) throw new AccountError("INVALID_PROFILE");
      const next = this.profiles.filter(profile => profile.id !== profileId);
      await this.persist(next);
      this.profiles = next;
      // Best effort: a reading still running for this account may hold a file open for a moment.
      await rm(this.configDirectory(profileId), { recursive: true, force: true }).catch(() => undefined);
    });
  }

  /**
   * Take a fresh reading of one account. A second request for the same account while one is
   * running gets that one's result rather than spending another turn. A failure is recorded on that
   * account alone and keeps its last good reading; an account deleted meanwhile is left deleted.
   */
  refreshUsage(profileId: string): Promise<PublicClaudeProfiles> {
    if (!this.initialized) return Promise.reject(new AccountError("RUNTIME_UNAVAILABLE"));
    const running = this.refreshing.get(profileId);
    if (running) return running;
    const profile = this.profiles.find(current => current.id === profileId);
    if (!profile) return Promise.reject(new AccountError("INVALID_PROFILE"));
    const refresh = (async () => {
      const configDir = this.configDirectory(profileId);
      let outcome: { usage: ClaudeUsage } | { code: string };
      try {
        await ensurePrivateDirectory(configDir);
        outcome = { usage: await readClaudeUsage({ ...this.options.usage, token: profile.token, configDir }) };
      } catch (error) {
        outcome = { code: error instanceof AccountError ? error.code : "USAGE_FAILED" };
      }
      return this.mutate(async () => {
        // No longer running once its outcome is being written, so the state answered says so.
        if (this.refreshing.get(profileId) === refresh) this.refreshing.delete(profileId);
        if (!this.profiles.some(current => current.id === profileId)) return;
        const at = this.now();
        const next = this.profiles.map(current => {
          if (current.id !== profileId) return current;
          if ("usage" in outcome) { const { usageError: _cleared, ...rest } = current; return { ...rest, usage: { checkedAt: at, ...outcome.usage } }; }
          return { ...current, usageError: { at, code: outcome.code } };
        });
        await this.persist(next);
        this.profiles = next;
      });
    })();
    this.refreshing.set(profileId, refresh);
    const settle = () => { if (this.refreshing.get(profileId) === refresh) this.refreshing.delete(profileId); };
    refresh.then(settle, settle);
    return refresh;
  }

  private configDirectory(profileId: string): string {
    return join(this.options.root, CONFIG_DIRECTORY, profileId);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private mutate(action: () => Promise<void>): Promise<PublicClaudeProfiles> {
    if (!this.initialized) return Promise.reject(new AccountError("RUNTIME_UNAVAILABLE"));
    const result = this.mutations.then(action).then(() => this.listPublic());
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  /** `selectedId: null` keeps the file readable by the build that still expects a selection. */
  private persist(profiles: StoredClaudeProfile[]): Promise<void> {
    return atomicPrivateJson(join(this.options.root, CLAUDE_PROFILES_FILE), { version: 1, selectedId: null, profiles });
  }
}

function validEmail(value: string): boolean {
  return value.length > 0 && value.length <= 254 && !CONTROL.test(value);
}

/** A saved selection is accepted and dropped: accounts are no longer selected. */
function parseStored(data: unknown): StoredClaudeProfile[] | undefined {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.profiles)) return undefined;
  const profiles: StoredClaudeProfile[] = [];
  for (const value of data.profiles) {
    if (!isRecord(value) || typeof value.id !== "string" || !PROFILE_ID.test(value.id)
      || typeof value.email !== "string" || !validEmail(value.email)
      || typeof value.token !== "string" || !SETUP_TOKEN.test(value.token)
      || !Number.isSafeInteger(value.createdAt)) return undefined;
    if (profiles.some(profile => profile.id === value.id)) return undefined;
    const usage = value.usage === undefined ? undefined : parseReading(value.usage);
    const usageError = value.usageError === undefined ? undefined : parseFailure(value.usageError);
    if (usage === null || usageError === null) return undefined;
    profiles.push({
      id: value.id, email: value.email, token: value.token, createdAt: value.createdAt as number,
      ...(usage === undefined ? {} : { usage }), ...(usageError === undefined ? {} : { usageError }),
    });
  }
  return profiles;
}

function parseReading(value: unknown): UsageReading | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.checkedAt)) return null;
  const fiveHour = parseWindow(value.fiveHour), sevenDay = parseWindow(value.sevenDay);
  if (fiveHour === undefined || sevenDay === undefined) return null;
  return { checkedAt: value.checkedAt as number, fiveHour, sevenDay };
}

function parseWindow(value: unknown): ClaudeUsage["fiveHour"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.utilization !== "number" || typeof value.resetsAt !== "number") return undefined;
  return { utilization: value.utilization, resetsAt: value.resetsAt };
}

function parseFailure(value: unknown): UsageFailure | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.at) || typeof value.code !== "string" || !/^[A-Z_]{1,64}$/u.test(value.code)) return null;
  return { at: value.at as number, code: value.code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
