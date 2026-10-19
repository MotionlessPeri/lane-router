import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AccountError } from "./contracts.js";
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson } from "./private-storage.js";

export const CLAUDE_PROFILES_FILE = "claude-profiles.json";
/** The one file a Claude lane window reads at launch; its reader is `src/process/terminal-child.ts`. */
export const CLAUDE_LAUNCH_FILE = "claude-launch.json";

/**
 * What `claude setup-token` prints: a long-lived OAuth token, which Claude Code never rotates. A
 * console API key (`sk-ant-api…`) would also start a session, but billed to the API rather than
 * the subscription the account page is about, so it is refused rather than quietly accepted.
 */
const SETUP_TOKEN = /^sk-ant-oat[A-Za-z0-9_-]{10,400}$/;
const PROFILE_ID = /^claude-[a-z0-9-]{1,72}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

interface StoredClaudeProfile { id: string; email: string; token: string; createdAt: number }

/** What leaves this module for the page: everything but the token. */
export interface PublicClaudeProfiles {
  profiles: Array<{ id: string; email: string; createdAt: number }>;
  selectedId: string | null;
}

/**
 * Claude accounts for lanes that have not been opened yet. Claude refreshes its own OAuth login by
 * rotating the refresh token, so a saved copy of `~/.claude/.credentials.json` goes stale the first
 * time any session refreshes, and putting a stale one back logs that session out and empties the
 * file. A setup token does not rotate; handed to a session through `CLAUDE_CODE_OAUTH_TOKEN`, which
 * Claude reads only when it starts, it switches the account of the next window opened and of no
 * window already open.
 *
 * The tokens sit in this service's private directory, under the same owner-and-SYSTEM ACL as
 * Claude's own credentials file: there is no keyring Claude Code would read them from.
 *
 * The saved selection is the authority and the launch file follows it. The launch file is written
 * after the selection is saved, so a write that stops between the two leaves the file behind; the
 * next selection, or the next start, rewrites it from the saved state.
 */
export class ClaudeProfiles {
  private profiles: StoredClaudeProfile[] = [];
  private selectedId: string | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: { root: string; now?: () => number }) {}

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.options.root);
    const data = await readPrivateJson(join(this.options.root, CLAUDE_PROFILES_FILE));
    if (data !== undefined) {
      const stored = parseStored(data);
      if (!stored) throw new AccountError("STORAGE_UNAVAILABLE");
      this.profiles = stored.profiles;
      this.selectedId = stored.selectedId;
    }
    await this.writeLaunchFile();
    this.initialized = true;
  }

  listPublic(): PublicClaudeProfiles {
    return {
      profiles: this.profiles.map(({ id, email, createdAt }) => ({ id, email, createdAt })),
      selectedId: this.selectedId,
    };
  }

  /** The email is the user's own label for the account; nothing here checks it against the token. */
  add(email: string, token: string): Promise<PublicClaudeProfiles> {
    return this.mutate(async () => {
      const label = email.trim();
      const secret = token.trim();
      if (!SETUP_TOKEN.test(secret)) throw new AccountError("INVALID_CLAUDE_TOKEN");
      if (!validEmail(label)) throw new AccountError("INVALID_CLAUDE_EMAIL");
      const next = [...this.profiles, { id: `claude-${randomUUID()}`, email: label, token: secret, createdAt: (this.options.now ?? Date.now)() }];
      await this.persist(next, this.selectedId);
      this.profiles = next;
    });
  }

  /** `null` unselects: new Claude lanes then go back to whatever `/login` left in `~/.claude`. */
  select(profileId: string | null): Promise<PublicClaudeProfiles> {
    return this.mutate(async () => {
      if (profileId !== null && !this.profiles.some(profile => profile.id === profileId)) throw new AccountError("INVALID_PROFILE");
      await this.persist(this.profiles, profileId);
      this.selectedId = profileId;
      await this.writeLaunchFile();
    });
  }

  remove(profileId: string): Promise<PublicClaudeProfiles> {
    return this.mutate(async () => {
      if (!this.profiles.some(profile => profile.id === profileId)) throw new AccountError("INVALID_PROFILE");
      const next = this.profiles.filter(profile => profile.id !== profileId);
      const selected = this.selectedId === profileId ? null : this.selectedId;
      await this.persist(next, selected);
      this.profiles = next;
      this.selectedId = selected;
      await this.writeLaunchFile();
    });
  }

  private mutate(action: () => Promise<void>): Promise<PublicClaudeProfiles> {
    if (!this.initialized) return Promise.reject(new AccountError("RUNTIME_UNAVAILABLE"));
    const result = this.mutations.then(action).then(() => this.listPublic());
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist(profiles: StoredClaudeProfile[], selectedId: string | null): Promise<void> {
    return atomicPrivateJson(join(this.options.root, CLAUDE_PROFILES_FILE), { version: 1, selectedId, profiles });
  }

  private async writeLaunchFile(): Promise<void> {
    const path = join(this.options.root, CLAUDE_LAUNCH_FILE);
    const selected = this.profiles.find(profile => profile.id === this.selectedId);
    if (selected) { await atomicPrivateJson(path, { version: 1, email: selected.email, token: selected.token }); return; }
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AccountError("STORAGE_UNAVAILABLE"); }
  }
}

function validEmail(value: string): boolean {
  return value.length > 0 && value.length <= 254 && !CONTROL.test(value);
}

function parseStored(data: unknown): { profiles: StoredClaudeProfile[]; selectedId: string | null } | undefined {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.profiles)) return undefined;
  const profiles: StoredClaudeProfile[] = [];
  for (const value of data.profiles) {
    if (!isRecord(value) || typeof value.id !== "string" || !PROFILE_ID.test(value.id)
      || typeof value.email !== "string" || !validEmail(value.email)
      || typeof value.token !== "string" || !SETUP_TOKEN.test(value.token)
      || !Number.isSafeInteger(value.createdAt)) return undefined;
    if (profiles.some(profile => profile.id === value.id)) return undefined;
    profiles.push({ id: value.id, email: value.email, token: value.token, createdAt: value.createdAt as number });
  }
  const selectedId = data.selectedId;
  if (selectedId !== null && (typeof selectedId !== "string" || !profiles.some(profile => profile.id === selectedId))) return undefined;
  return { profiles, selectedId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
