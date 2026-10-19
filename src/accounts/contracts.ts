/** Internal identity: email is display information, never an account key. */
export interface AccountIdentity {
  userId: string;
  accountId: string;
  email: string;
  plan: string;
}

/** Backend-only value. Never spread this object into HTTP results or errors. */
export interface AccessGrant { accessToken: string; identity: AccountIdentity }
export interface AccountSource {
  grant(profileId: string, refresh?: boolean): Promise<AccessGrant>;
  findProfile?(identity: AccountIdentity): string | undefined;
}
export interface SwitchParticipant {
  readonly id: string;
  prepare(operationId: string): Promise<void>;
  apply(operationId: string, grant: AccessGrant): Promise<void>;
  readIdentity(): Promise<AccountIdentity>;
  release(operationId: string): Promise<void>;
}
export interface PublicIdentity { email: string; workspace: string; plan: string }
export type SwitchPhase = "validating" | "waiting" | "applying" | "complete" | "cancelled" | "failed";
export interface SwitchOperation { id: string; profileId: string; phase: SwitchPhase; cancellable: boolean; error?: string }

export class AccountError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AccountError"; }
}

const safeCodes = new Set(["CONSUMER_OFFLINE", "IDENTITY_MISMATCH", "AUTH_REQUIRED", "QUEUED_WORK_PENDING", "ACTIVE_GOAL_PENDING", "RUNTIME_UNAVAILABLE", "SWITCH_CANCELLED", "INVALID_IDENTITY", "INVALID_PROFILE", "SWITCH_BUSY", "LOGIN_BUSY", "LOGIN_FAILED", "LOGIN_CANCELLED", "INVALID_REQUEST", "STORAGE_UNAVAILABLE", "SWITCH_ALREADY_APPLYING", "INVALID_CLAUDE_TOKEN", "INVALID_CLAUDE_EMAIL"]);
export function safeError(error: unknown, fallback = "OPERATION_FAILED"): string {
  return error instanceof AccountError && safeCodes.has(error.code) ? error.code : fallback;
}
