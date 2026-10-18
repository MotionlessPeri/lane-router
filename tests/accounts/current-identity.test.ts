import { afterEach, expect, test, vi } from "vitest";
import { AccountError, type AccountIdentity } from "../../src/accounts/contracts.js";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const alice: AccountIdentity = { userId: "user-a", accountId: "workspace-a", email: "alice@example.invalid", plan: "plus" };
const bob: AccountIdentity = { userId: "user-b", accountId: "workspace-b", email: "bob@example.invalid", plan: "pro" };
function runtime(id: string, initial = alice) {
  let current = initial;
  return { id, prepare: vi.fn(async () => {}), release: vi.fn(async () => {}),
    apply: vi.fn(async (_operation: string, grant: { identity: AccountIdentity }) => { current = grant.identity; }),
    readIdentity: vi.fn(async () => current) };
}
async function fixture() {
  const source = { grant: vi.fn(async () => ({ accessToken: "backend-only", identity: bob })),
    findProfile: (identity: AccountIdentity) => identity.userId === alice.userId ? "profile-a" : identity.userId === bob.userId ? "profile-b" : undefined };
  const save = vi.fn(async () => {});
  const service = new AccountSwitchService({ source, saveDesired: save, expected: ["router", "company"] });
  const accounts = { listPublic: () => [], loginStatus: () => ({ state: "idle" }), startLogin: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}) };
  const http = new AccountHttpServer({ service, accounts, token: "x".repeat(43) });
  const url = await http.start(); closes.push(() => http.close());
  const state = async () => await (await fetch(`${url}/api/state`)).json() as any;
  return { service, source, save, state };
}

test("connected runtimes report their actual accounts before the first user switch", async () => {
  const f = await fixture(); const router = runtime("router"), company = runtime("company", bob);
  f.service.connect(router); f.service.connect(company); await f.service.reconcile();
  await vi.waitFor(async () => {
    const state = await f.state();
    expect(state.consumers[0]).toMatchObject({ identity: { email: alice.email }, profileId: "profile-a" });
    expect(state.consumers[1]).toMatchObject({ identity: { email: bob.email }, profileId: "profile-b" });
    expect(state.desiredProfileId).toBeNull(); expect(state.operation).toBeNull();
    expect(JSON.stringify(state)).not.toContain("backend-only");
  });
  for (const participant of [router, company]) {
    expect(participant.prepare).not.toHaveBeenCalled(); expect(participant.apply).not.toHaveBeenCalled();
  }
  expect(f.save).not.toHaveBeenCalled(); expect(f.source.grant).not.toHaveBeenCalled();
});

test("current native account remains visible even when it has not been saved in the account page", async () => {
  const f = await fixture(); const native = { ...alice, userId: "unmanaged", email: "native@example.invalid" };
  f.service.connect(runtime("router", native));
  await vi.waitFor(async () => expect((await f.state()).consumers[0]).toMatchObject({ identity: { email: native.email }, profileId: null }));
  await expect(f.service.refresh("router", native.accountId)).rejects.toThrow("AUTH_REQUIRED");
  expect(f.source.grant).not.toHaveBeenCalled();
});

test("slow identity observation never blocks page state and overlapping polls share one read", async () => {
  const f = await fixture(); const router = runtime("router"); let finish!: (identity: AccountIdentity) => void;
  router.readIdentity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.service.connect(router);
  const initial = await f.state(); await f.state(); await f.state();
  expect(initial.consumers[0].identity).toBeNull(); expect(router.readIdentity).toHaveBeenCalledTimes(1);
  finish(alice);
  await vi.waitFor(() => expect(f.service.snapshot().consumers[0]?.identity?.email).toBe(alice.email));
});

test("a failed read clears the previous account and exposes only a safe error, then recovers", async () => {
  const f = await fixture(); const router = runtime("router"); f.service.connect(router);
  await vi.waitFor(async () => expect((await f.state()).consumers[0].identity?.email).toBe(alice.email));
  router.readIdentity.mockRejectedValue(new Error("backend-only"));
  await vi.waitFor(async () => {
    const state = await f.state();
    expect(state.consumers[0]).toMatchObject({ identity: null, profileId: null, identityError: "OPERATION_FAILED" });
    expect(JSON.stringify(state)).not.toContain("backend-only");
  });
  router.readIdentity.mockResolvedValue(bob);
  await vi.waitFor(async () => expect((await f.state()).consumers[0]).toMatchObject({ identity: { email: bob.email }, identityError: null }));
});

test("a late observation cannot replace the identity established by an actual switch", async () => {
  const f = await fixture(); const router = runtime("router"), company = runtime("company");
  let finish!: (identity: AccountIdentity) => void;
  router.readIdentity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.service.connect(router); f.service.connect(company); await f.state();
  await f.service.start("profile-b"); finish(alice);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.service.snapshot().operation?.phase).toBe("complete");
  expect(f.service.snapshot().consumers[0]).toMatchObject({ identity: { email: bob.email }, profileId: "profile-b", identityError: null });
});

test("a disconnected runtime's late failure cannot clear its replacement's identity", async () => {
  const f = await fixture(); const old = runtime("router"); let fail!: (error: Error) => void;
  old.readIdentity.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  f.service.connect(old); await f.state(); f.service.disconnect(old);
  f.service.connect(runtime("router", bob));
  await vi.waitFor(async () => expect((await f.state()).consumers[0].identity?.email).toBe(bob.email));
  fail(new AccountError("AUTH_REQUIRED")); await new Promise(resolve => setImmediate(resolve));
  expect(f.service.snapshot().consumers[0]).toMatchObject({ identity: { email: bob.email }, identityError: null });
});
