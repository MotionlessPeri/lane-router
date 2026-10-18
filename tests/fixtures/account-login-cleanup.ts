import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { AccountError } from "../../src/accounts/contracts.js";
import type { AccountRpcClient, RpcNotification } from "../../src/accounts/stdio-client.js";

// A real Node process exercises the fire-and-forget login boundary. All identity data is synthetic.
class Owner implements AccountRpcClient {
  listeners = new Set<(message: RpcNotification) => void>();
  constructor(readonly second: boolean) {}
  async request(method: string) {
    if (method === "account/login/start") return { type: "chatgpt", loginId: "fixture", authUrl: "https://auth.openai.com/fixture" };
    if (method === "getAuthStatus") return { authMethod: "chatgpt", authToken: `fixture.${Buffer.from(JSON.stringify({ exp: 9999999999, email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_user_id: "fixture", chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture` };
    throw new AccountError("LOGIN_FAILED");
  }
  onNotification(listener: (message: RpcNotification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose() { return () => {}; }
  async close() { if (this.second) throw new AccountError("RUNTIME_UNAVAILABLE"); }
  complete() { for (const listener of this.listeners) listener({ method: "account/login/completed", params: { loginId: "fixture", success: true } }); }
}
let current!: Owner;
let count = 0;
const { ManagedAccounts } = await import(process.argv[3] ? pathToFileURL(process.argv[3]).href : "../../src/accounts/managed-login.js");
const accounts = new ManagedAccounts({ root: process.argv[2]!, executable: "unused-fixture",
  createClient: async () => { current = new Owner(++count === 2); return current; },
  openUrl: async () => { if (current.second) throw new AccountError("LOGIN_FAILED"); current.complete(); },
});
await accounts.initialize();
await accounts.startLogin();
while (accounts.loginStatus().state !== "complete") await delay(20);
await accounts.startLogin();
while (accounts.loginStatus().state !== "failed") await delay(20);
await delay(50);
await accounts.close();
process.stdout.write("survived-second-login-failure profiles=1\n");
