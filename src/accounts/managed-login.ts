import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { AccountError, safeError, type AccessGrant, type AccountIdentity, type AccountSource, type PublicIdentity } from "./contracts.js";
import { identityFromToken, publicIdentity, sameIdentity } from "./identity.js";
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson } from "./private-storage.js";
import { CodexStdioClient, type AccountRpcClient } from "./stdio-client.js";
import { openOfficialUrl, validateOfficialUrl } from "./open-official-url.js";

export interface ManagedAccountsOptions {
  root: string;
  executable: string;
  openUrl?: (url: string) => Promise<void>;
  loginTimeoutMs?: number;
  createClient?: (options: { executable: string; home: string }) => Promise<AccountRpcClient>;
}
export interface LoginStatus { state: "idle" | "starting" | "waiting" | "complete" | "failed" | "cancelled"; error?: string }
interface StoredProfile { id: string; slot: string; identity: AccountIdentity }
interface Profile extends StoredProfile {
  owner?: AccountRpcClient;
  cache?: AccessGrant;
  pending?: Promise<AccessGrant>;
  queue: Promise<void>;
}
interface LoginOperation {
  profileId?: string;
  abort: AbortController;
  cancelled: boolean;
  committing: boolean;
  owner?: AccountRpcClient;
  task?: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function storedIdentity(value: unknown): value is AccountIdentity {
  return isRecord(value) && typeof value.userId === "string" && value.userId.length > 0 && typeof value.accountId === "string" && value.accountId.length > 0 && typeof value.email === "string" && typeof value.plan === "string";
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const copyGrant = (grant: AccessGrant): AccessGrant => ({ accessToken: grant.accessToken, identity: { ...grant.identity } });

/** Owns managed credential refresh; consumers receive access tokens only. */
export class ManagedAccounts implements AccountSource {
  private readonly root: string;
  private readonly profiles = new Map<string, Profile>();
  private desired?: string;
  private initialized = false;
  private closed = false;
  private status: LoginStatus = { state: "idle" };
  private operation?: LoginOperation;
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagedAccountsOptions) {
    if (!isAbsolute(options.root)) throw new AccountError("STORAGE_UNAVAILABLE");
    this.root = resolve(options.root);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new AccountError("RUNTIME_UNAVAILABLE");
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(join(this.root, "slots"));
    const data = await readPrivateJson(join(this.root, "profiles.json"));
    if (data !== undefined) {
      if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.profiles)) throw new AccountError("STORAGE_UNAVAILABLE");
      const loaded = new Map<string, Profile>();
      for (const value of data.profiles) {
        if (!isRecord(value) || !validId(value.id) || !validId(value.slot) || !storedIdentity(value.identity)) throw new AccountError("STORAGE_UNAVAILABLE");
        if (loaded.has(value.id) || [...loaded.values()].some(profile => profile.slot === value.slot || sameIdentity(profile.identity, value.identity as AccountIdentity))) throw new AccountError("STORAGE_UNAVAILABLE");
        loaded.set(value.id, { id: value.id, slot: value.slot, identity: { ...value.identity }, queue: Promise.resolve() });
      }
      if (data.desiredProfileId !== undefined && (!validId(data.desiredProfileId) || !loaded.has(data.desiredProfileId))) throw new AccountError("STORAGE_UNAVAILABLE");
      for (const [id, profile] of loaded) this.profiles.set(id, profile);
      this.desired = data.desiredProfileId as string | undefined;
    }
    this.initialized = true;
  }

  get desiredProfileId(): string | undefined { return this.desired; }
  listPublic(): Array<PublicIdentity & { id: string }> { return [...this.profiles.values()].map(profile => ({ id: profile.id, ...publicIdentity(profile.identity) })); }
  findProfile(identity: AccountIdentity): string | undefined { return [...this.profiles.values()].find(profile => sameIdentity(profile.identity, identity))?.id; }
  loginStatus(): LoginStatus { return { ...this.status }; }

  async saveDesired(profileId: string): Promise<void> {
    this.requireReady();
    await this.mutate(async () => {
      if (!this.profiles.has(profileId)) throw new AccountError("INVALID_PROFILE");
      await this.persist([...this.profiles.values()], profileId);
      this.desired = profileId;
    });
  }

  async startLogin(profileId?: string): Promise<void> {
    this.requireReady();
    if (this.operation) throw new AccountError("LOGIN_BUSY");
    if (profileId !== undefined && !this.profiles.has(profileId)) throw new AccountError("INVALID_PROFILE");
    const operation: LoginOperation = { profileId, abort: new AbortController(), cancelled: false, committing: false };
    this.operation = operation; this.status = { state: "starting" };
    operation.task = this.runLogin(operation);
  }

  async cancelLogin(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;
    // Once the metadata transaction starts, complete it before reporting its outcome.
    if (!operation.committing) { operation.cancelled = true; operation.abort.abort(); await operation.owner?.close(); }
    await operation.task;
  }

  private async runLogin(operation: LoginOperation): Promise<void> {
    const slot = `slot-${randomUUID()}`;
    let accepted = false;
    const timer = setTimeout(() => { if (!operation.committing) operation.abort.abort(); }, this.options.loginTimeoutMs ?? 10 * 60_000);
    let removeNotification = () => {}; let removeClose = () => {};
    try {
      const home = join(this.root, "slots", slot);
      await ensurePrivateDirectory(home); this.checkLogin(operation);
      const owner = await this.createClient(home); operation.owner = owner; this.checkLogin(operation);
      let loginId: string | undefined;
      const early: Array<{ loginId: string; success: boolean }> = [];
      let finish!: (success: boolean) => void;
      let fail!: (error: Error) => void;
      const completed = new Promise<boolean>((resolvePromise, reject) => { finish = resolvePromise; fail = reject; });
      // The notification may arrive before the login/start response.
      void completed.catch(() => undefined);
      removeNotification = owner.onNotification(message => {
        if (message.method !== "account/login/completed" || !isRecord(message.params) || typeof message.params.loginId !== "string" || typeof message.params.success !== "boolean") return;
        if (message.params.loginId === loginId) finish(message.params.success);
        else if (!loginId && early.length < 16) early.push({ loginId: message.params.loginId, success: message.params.success });
      });
      removeClose = owner.onClose(() => fail(new AccountError("LOGIN_FAILED")));
      const response = await this.abortable(owner.request("account/login/start", { type: "chatgpt" }), operation);
      this.checkLogin(operation);
      if (!isRecord(response) || response.type !== "chatgpt" || typeof response.loginId !== "string" || !response.loginId || typeof response.authUrl !== "string") throw new AccountError("LOGIN_FAILED");
      validateOfficialUrl(response.authUrl);
      loginId = response.loginId;
      const received = early.find(event => event.loginId === loginId); if (received) finish(received.success);
      await this.abortable((this.options.openUrl ?? openOfficialUrl)(response.authUrl), operation);
      this.checkLogin(operation); this.status = { state: "waiting" };
      if (!await this.abortable(completed, operation)) throw new AccountError("LOGIN_FAILED");
      removeNotification(); removeClose();
      const grant = await this.abortable(this.readGrant(owner, false), operation); this.checkLogin(operation);
      await this.mutate(async () => {
        this.checkLogin(operation);
        const requested = operation.profileId ? this.profiles.get(operation.profileId) : undefined;
        if (requested && !sameIdentity(requested.identity, grant.identity)) throw new AccountError("IDENTITY_MISMATCH");
        const previous = requested ?? [...this.profiles.values()].find(profile => sameIdentity(profile.identity, grant.identity));
        const install = async () => {
          this.checkLogin(operation); operation.committing = true;
          const replacement: Profile = { id: previous?.id ?? `profile-${randomUUID()}`, slot, identity: { ...grant.identity }, owner, cache: copyGrant(grant), queue: Promise.resolve() };
          await this.persist([...this.profiles.values()].filter(profile => profile !== previous).concat(replacement), this.desired);
          // account/logout can revoke managed OAuth tokens. Retire the owner only;
          // inactive keyring slots remain until a verified local-only cleanup exists.
          await previous?.owner?.close();
          this.watchOwner(replacement, owner);
          this.profiles.set(replacement.id, replacement); accepted = true;
        };
        if (previous) await this.serial(previous, install); else await install();
      });
      this.status = { state: "complete" };
    } catch (error) {
      this.status = operation.cancelled ? { state: "cancelled", error: "LOGIN_CANCELLED" } : { state: "failed", error: safeError(error, "LOGIN_FAILED") };
    } finally {
      clearTimeout(timer); removeNotification(); removeClose();
      if (!accepted) await operation.owner?.close();
      if (this.operation === operation) this.operation = undefined;
    }
  }

  async grant(profileId: string, refresh = false): Promise<AccessGrant> {
    this.requireReady();
    const profile = this.profiles.get(profileId);
    if (!profile) throw new AccountError("INVALID_PROFILE");
    if (profile.pending) return copyGrant(await profile.pending);
    if (!refresh && profile.cache && this.cacheValid(profile.cache)) return copyGrant(profile.cache);
    const promise = this.serial(profile, async () => {
      // A login replacement can have acquired the same profile queue first.
      if (this.profiles.get(profileId) !== profile) return this.grant(profileId, refresh);
      try {
        this.requireReady();
        if (!profile.owner) {
          const home = join(this.root, "slots", profile.slot);
          await ensurePrivateDirectory(home);
          profile.owner = await this.createClient(home);
          if (this.closed) { await profile.owner.close(); throw new AccountError("RUNTIME_UNAVAILABLE"); }
          this.watchOwner(profile, profile.owner);
        }
        if (!profile.owner) throw new AccountError("AUTH_REQUIRED");
        // With no usable in-memory access token (including after restart), let
        // the sole official owner renew its managed credentials.
        const grant = await this.readGrant(profile.owner, true);
        if (!sameIdentity(grant.identity, profile.identity)) throw new AccountError("IDENTITY_MISMATCH");
        profile.cache = copyGrant(grant); return grant;
      } catch (error) {
        profile.cache = undefined;
        throw new AccountError(error instanceof AccountError && error.code === "IDENTITY_MISMATCH" ? "IDENTITY_MISMATCH" : "AUTH_REQUIRED");
      }
    });
    profile.pending = promise;
    try { return copyGrant(await promise); }
    finally { if (profile.pending === promise) profile.pending = undefined; }
  }

  private async readGrant(owner: AccountRpcClient, refresh: boolean): Promise<AccessGrant> {
    const result = await owner.request("getAuthStatus", { includeToken: true, refreshToken: refresh });
    if (!isRecord(result) || result.authMethod !== "chatgpt" || typeof result.authToken !== "string" || !result.authToken) throw new AccountError("AUTH_REQUIRED");
    const identity = identityFromToken(result.authToken);
    if (!identity.email) {
      const account = await owner.request("account/read", { refreshToken: false });
      if (isRecord(account) && isRecord(account.account) && account.account.type === "chatgpt" && typeof account.account.email === "string") identity.email = account.account.email;
    }
    return { accessToken: result.authToken, identity };
  }

  private cacheValid(grant: AccessGrant): boolean {
    try { const payload = JSON.parse(Buffer.from(grant.accessToken.split(".")[1]!, "base64url").toString("utf8")); return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 60_000; }
    catch { return false; }
  }
  private createClient(home: string): Promise<AccountRpcClient> { return (this.options.createClient ?? CodexStdioClient.connect)({ executable: this.options.executable, home }); }
  private watchOwner(profile: Profile, owner: AccountRpcClient): void {
    owner.onClose(() => { if (profile.owner === owner) { profile.owner = undefined; profile.cache = undefined; } });
  }
  private requireReady(): void { if (!this.initialized || this.closed) throw new AccountError("RUNTIME_UNAVAILABLE"); }
  private checkLogin(operation: LoginOperation): void { if (operation.abort.signal.aborted || this.closed) throw new AccountError(operation.cancelled ? "LOGIN_CANCELLED" : "LOGIN_FAILED"); }
  private async abortable<T>(promise: Promise<T>, operation: LoginOperation): Promise<T> {
    this.checkLogin(operation);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new AccountError(operation.cancelled ? "LOGIN_CANCELLED" : "LOGIN_FAILED")); operation.abort.signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([promise, cancelled]); }
    finally { operation.abort.signal.removeEventListener("abort", abort); }
  }
  private serial<T>(profile: Profile, action: () => Promise<T>): Promise<T> {
    const result = profile.queue.then(action); profile.queue = result.then(() => undefined, () => undefined); return result;
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action); this.mutations = result.then(() => undefined, () => undefined); return result;
  }
  private persist(profiles: StoredProfile[], desiredProfileId?: string): Promise<void> {
    return atomicPrivateJson(join(this.root, "profiles.json"), { version: 1, desiredProfileId, profiles: profiles.map(({ id, slot, identity }) => ({ id, slot, identity: { ...identity } })) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cancelled = this.cancelLogin();
    // Kill owned processes first, so outstanding RPCs cannot block shutdown.
    await Promise.all([...this.profiles.values()].map(async profile => { profile.cache = undefined; await profile.owner?.close(); }));
    await cancelled;
    await this.mutations;
    // A transaction already committing at shutdown may have installed its owner
    // after the first pass; include that newly adopted process as well.
    await Promise.all([...this.profiles.values()].map(async profile => { profile.cache = undefined; await profile.owner?.close(); }));
    await Promise.all([...this.profiles.values()].map(profile => profile.queue));
  }
}
