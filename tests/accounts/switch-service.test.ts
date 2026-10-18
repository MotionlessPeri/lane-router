import { expect, test, vi } from "vitest";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";
import type { AccessGrant, SwitchParticipant } from "../../src/accounts/contracts.js";

const grant: AccessGrant = { accessToken: "only-backend-secret", identity: { userId: "u", accountId: "b", email: "person@example.invalid", plan: "plus" } };
function participant(id: string, options: { prepare?: () => Promise<void>; fail?: boolean } = {}): SwitchParticipant {
  let identity = { ...grant.identity, accountId: "a" };
  return { id, prepare: vi.fn(options.prepare ?? (async () => {})), apply: vi.fn(async () => { if (options.fail) throw new Error("only-backend-secret"); identity = grant.identity; }), readIdentity: vi.fn(async () => identity), release: vi.fn(async () => {}) };
}
function service() {
  const save = vi.fn(async () => {});
  const source = { grant: vi.fn(async () => grant) };
  return { sut: new AccountSwitchService({ source, saveDesired: save, expected: ["router", "company"] }), source, save };
}
test("waits for both consumers before applying, verifies both, publishes only metadata", async () => {
  const { sut, save } = service();
  let idle!: () => void;
  const router = participant("router", { prepare: () => new Promise(resolve => { idle = resolve; }) });
  const company = participant("company");
  sut.connect(router); sut.connect(company);
  const operation = sut.start("profile-b");
  await vi.waitFor(() => expect(idle).toBeTypeOf("function"));
  expect(company.apply).not.toHaveBeenCalled();
  expect(sut.snapshot().operation?.phase).toBe("waiting");
  expect(() => sut.start("profile-c")).toThrow("SWITCH_BUSY");
  idle(); await operation;
  expect(save).toHaveBeenCalledWith("profile-b");
  expect(sut.snapshot().operation?.phase).toBe("complete");
  expect(router.readIdentity).toHaveBeenCalled();
  expect(JSON.stringify(sut.snapshot())).not.toContain("only-backend-secret");
});
test("missing consumer does not mutate any account", async () => {
  const { sut, save } = service(); const router = participant("router"); sut.connect(router);
  await sut.start("profile-b");
  expect(sut.snapshot().operation?.error).toBe("CONSUMER_OFFLINE");
  expect(router.apply).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
test("cancel while waiting releases gates and never applies", async () => {
  const { sut } = service(); let idle!: () => void;
  const router = participant("router", { prepare: () => new Promise(resolve => { idle = resolve; }) });
  const company = participant("company"); sut.connect(router); sut.connect(company);
  const operation = sut.start("profile-b");
  await vi.waitFor(() => expect(idle).toBeTypeOf("function"));
  await sut.cancel(); idle(); await operation;
  expect(sut.snapshot().operation?.phase).toBe("cancelled");
  expect(company.apply).not.toHaveBeenCalled(); expect(router.release).toHaveBeenCalled();
});
test("partial failure preserves desired account and exposes safe pending result", async () => {
  const { sut, save } = service(); const router = participant("router");
  sut.connect(router); sut.connect(participant("company", { fail: true }));
  await sut.start("profile-b");
  expect(save).toHaveBeenCalledWith("profile-b");
  expect(sut.snapshot().operation?.phase).toBe("failed");
  expect(sut.snapshot().consumers.find(c => c.id === "company")?.state).toBe("failed");
  expect(router.release).not.toHaveBeenCalled();
  expect(JSON.stringify(sut.snapshot())).not.toContain("only-backend-secret");
});
test("identity mismatch and lost connection cannot be mistaken for completion", async () => {
  const { sut } = service(); const router = participant("router"); const company = participant("company");
  company.readIdentity = async () => ({ ...grant.identity, userId: "wrong" });
  sut.connect(router); sut.connect(company); await sut.start("profile-b");
  expect(sut.snapshot().operation?.phase).toBe("failed");
});
test("a retry after partial apply cannot cancel and reopen unsynchronized consumers", async () => {
  const { sut } = service(); const router = participant("router"); const company = participant("company", { fail: true });
  sut.connect(router); sut.connect(company); await sut.start("profile-b");
  let idle!: () => void; company.prepare = () => new Promise(resolve => { idle = resolve; });
  const retry = sut.start("profile-b"); await vi.waitFor(() => expect(idle).toBeTypeOf("function"));
  await expect(sut.cancel()).rejects.toThrow("SWITCH_ALREADY_APPLYING");
  expect(router.release).not.toHaveBeenCalled(); idle(); await retry;
});
test("reconnected old turn refresh resolves the actual user, not the desired workspace alone", async () => {
  const actual = { ...grant.identity, userId: "other-user" };
  const source = { findProfile: (identity: any) => identity.userId === actual.userId ? "profile-old" : "profile-b", grant: vi.fn(async (id: string) => ({ ...grant, identity: id === "profile-old" ? actual : grant.identity })) };
  const sut = new AccountSwitchService({ source, expected: ["router", "company"], desired: "profile-b", saveDesired: async () => {} });
  const company = participant("company"); company.readIdentity = async () => actual;
  sut.connect(company);
  await sut.refresh("company", actual.accountId);
  expect(source.grant).toHaveBeenCalledWith("profile-old", true);
});
test("failed verification after an effective apply does not retain the prior user's refresh binding", async () => {
  let current = { ...grant.identity, userId: "user-a" }; let failRead = false;
  const source = { findProfile: (id: any) => id.userId, grant: vi.fn(async (id: string) => ({ ...grant, identity: { ...grant.identity, userId: id } })) };
  const sut = new AccountSwitchService({ source, expected: ["company"], saveDesired: async () => {} });
  sut.connect({ id: "company", prepare: async () => {}, release: async () => {}, apply: async (_op, value) => { current = value.identity; }, readIdentity: async () => { if (failRead) throw Error("secret"); return current; } });
  await sut.start("user-a"); failRead = true; await sut.start("user-b");
  expect(sut.snapshot().operation?.phase).toBe("failed");
  await expect(sut.refresh("company", grant.identity.accountId)).rejects.toThrow();
  failRead = false; await sut.refresh("company", grant.identity.accountId);
  expect(source.grant).toHaveBeenLastCalledWith("user-b", true);
});
test("refresh during an unresolved apply cannot rebind the old user before that apply takes effect", async () => {
  let current = { ...grant.identity, userId: "user-a" }; let finishApply!: () => void;
  let changing = false, failedRead = false;
  const source = { findProfile: (id: any) => id.userId, grant: vi.fn(async (id: string) => ({ ...grant, identity: { ...grant.identity, userId: id } })) };
  const sut = new AccountSwitchService({ source, expected: ["company"], saveDesired: async () => {} });
  sut.connect({ id: "company", prepare: async () => {}, release: async () => {}, apply: async (_op, value) => { if (changing) await new Promise<void>(resolve => { finishApply = resolve; }); current = value.identity; }, readIdentity: async () => { if (failedRead) throw Error(); return current; } });
  await sut.start("user-a"); changing = true; const switchB = sut.start("user-b");
  await vi.waitFor(() => expect(finishApply).toBeTypeOf("function"));
  await expect(sut.refresh("company", grant.identity.accountId)).rejects.toThrow("RUNTIME_UNAVAILABLE");
  failedRead = true; finishApply(); await switchB; failedRead = false;
  await sut.refresh("company", grant.identity.accountId);
  expect(source.grant).toHaveBeenLastCalledWith("user-b", true);
});
