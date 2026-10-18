import { createHash } from "node:crypto";
import { AccountError, type AccountIdentity, type PublicIdentity } from "./contracts.js";

export function identityFromToken(token: string, options: { allowExpired?: boolean } = {}): AccountIdentity {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"];
    const userId = auth?.chatgpt_user_id ?? auth?.user_id;
    const accountId = auth?.chatgpt_account_id;
    if (typeof userId !== "string" || !userId || typeof accountId !== "string" || !accountId) throw new Error();
    if (!options.allowExpired && typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) throw new Error();
    return { userId, accountId, email: typeof payload.email === "string" ? payload.email : "", plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : "unknown" };
  } catch { throw new AccountError("INVALID_IDENTITY"); }
}

export function sameIdentity(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.userId === b.userId && a.accountId === b.accountId;
}

export function publicIdentity(identity: AccountIdentity): PublicIdentity {
  return {
    email: identity.email || "已授权账号",
    workspace: createHash("sha256").update(identity.accountId).digest("hex").slice(0, 10),
    plan: identity.plan,
  };
}
