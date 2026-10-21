import { coreResolver } from "../process/codex-host-link.js";
import { AccountError } from "./contracts.js";

/** What the account page's 继续 buttons need from the Router: the result is the Router's own answer. */
export interface LaneContinuePort {
  continueAfterSwitch(backend: "claude" | "codex"): Promise<unknown>;
}

/**
 * The account page has its own origin and none of the board's token, so its press goes through
 * this backend, which calls the Router's loopback entry as any local program would. The Router is
 * looked up in its discovery file on every press and answers health as that instance, so a Router
 * restarted on another port since this backend started is still the one reached.
 */
export function routerContinueClient(dataRoot: string, fetchImpl: typeof fetch = fetch): LaneContinuePort {
  const resolve = coreResolver(dataRoot);
  return {
    async continueAfterSwitch(backend) {
      const url = await resolve();
      if (url === undefined) throw new AccountError("ROUTER_UNAVAILABLE");
      let response: Response;
      try {
        response = await fetchImpl(`${url}/lanes/continue-after-switch`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend }), signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new AccountError("ROUTER_UNAVAILABLE"); }
      if (!response.ok) throw new AccountError("ROUTER_REFUSED");
      return (await response.json() as { result: unknown }).result;
    },
  };
}
