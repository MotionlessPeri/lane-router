import { expect, test, vi } from "vitest";
import { AccountSwitchGate } from "../../src/accounts/switch-gate.js";

function fixture() {
  let busy = false, queue = false, goal = false;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/loaded/list") return { data: ["thread-original"], nextCursor: null };
    if (method === "thread/read") return { thread: { status: { type: busy ? "active" : "idle" }, turns: [] } };
    if (method === "thread/queue/list") return { data: queue ? [{ id: "queued" }] : [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: goal ? { status: "active" } : null };
    throw new Error("unexpected");
  });
  return { gate: new AccountSwitchGate({ request, pollMs: 5 }), request, busy: (v: boolean) => { busy = v; }, queue: () => { queue = true; }, goal: () => { goal = true; } };
}
test("closes admission synchronously and waits for dispatched-but-unanswered work", async () => {
  const f = fixture(); const finish = f.gate.enter("turn/start");
  const ready = vi.fn(); const prepare = f.gate.prepare("op").then(ready);
  expect(() => f.gate.enter("review/start")).toThrow("ACCOUNT_SWITCH_IN_PROGRESS");
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(ready).not.toHaveBeenCalled();
  f.busy(true); finish(); await new Promise(resolve => setTimeout(resolve, 15));
  expect(ready).not.toHaveBeenCalled();
  f.busy(false); await prepare;
  expect(f.gate.isPrepared("op")).toBe(true);
  f.gate.release("old-operation"); expect(f.gate.isHeld).toBe(true);
  f.gate.release("op"); expect(f.gate.isHeld).toBe(false);
});
test.each(["turn/start", "turn/steer", "review/start", "thread/compact/start", "thread/queue/start", "thread/queue/add", "thread/goal/set", "thread/resume"])("blocks model-producing method %s while allowing diagnostics", async method => {
  const f = fixture(); await f.gate.prepare("op");
  expect(() => f.gate.enter(method)).toThrow(); expect(() => f.gate.enter("account/read")()).not.toThrow();
});
test.each(["queue", "goal"] as const)("reports %s instead of waiting for work it has frozen", async kind => {
  const f = fixture(); f[kind]();
  await expect(f.gate.prepare("op")).rejects.toThrow(kind === "queue" ? "QUEUED_WORK_PENDING" : "ACTIVE_GOAL_PENDING");
  f.gate.release("op"); expect(f.gate.isHeld).toBe(false);
});
test("disconnect fences a prior successful prepare and a stale release", async () => {
  const f = fixture(); await f.gate.prepare("op"); f.gate.hold();
  expect(f.gate.isPrepared("op")).toBe(false); f.gate.release("op"); expect(f.gate.isHeld).toBe(true);
});
test("an already admitted Company input can cross its Host while preparation drains", async () => {
  const f = fixture(); let admitted!: string, proceed!: () => void;
  const work = f.gate.withAdmission("turn/start", async admission => {
    admitted = admission.token; await new Promise<void>(resolve => { proceed = resolve; });
    await f.gate.request("thread/resume", async () => {}, admission.token);
    await f.gate.request("turn/start", async () => {}, admission.token);
  });
  const ready = vi.fn(); const preparing = f.gate.prepare("op").then(ready);
  expect(() => f.gate.enter("turn/start")).toThrow();
  expect(ready).not.toHaveBeenCalled(); proceed(); await work; await preparing;
  expect(() => f.gate.enter("turn/start", admitted)).toThrow();
});
test("only actual process replacement clears uncertain effects and ignores old completions", async () => {
  const f = fixture(); const oldFinish = f.gate.enter("turn/start"); f.gate.markUncertain();
  await expect(f.gate.prepare("old")).rejects.toThrow("RUNTIME_UNAVAILABLE");
  f.gate.hold(); await expect(f.gate.prepare("reconnected")).rejects.toThrow("RUNTIME_UNAVAILABLE");
  f.gate.runtimeReplaced(); oldFinish(); await f.gate.prepare("new");
  expect(f.gate.isPrepared("new")).toBe(true);
});
test("late failures and disconnect callbacks from a replaced process cannot poison the new gate", async () => {
  const f = fixture(); let rejectOld!: (error: Error) => void;
  const old = f.gate.request("turn/start", () => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  const oldSocketFinish = f.gate.enter("review/start");
  f.gate.runtimeReplaced();
  rejectOld(Object.assign(new Error(), { code: "CODEX_APP_SERVER_TIMEOUT" }));
  await expect(old).rejects.toThrow();
  oldSocketFinish.markUncertain?.(); oldSocketFinish();
  await f.gate.prepare("new"); expect(f.gate.isPrepared("new")).toBe(true);
});
test("uncertain effects revoke even a still-active cross-Host admission", async () => {
  const f = fixture();
  await f.gate.withAdmission("turn/start", async admission => {
    admission.markUncertain();
    expect(() => f.gate.enter("turn/start", admission.token)).toThrow("ACCOUNT_SWITCH_IN_PROGRESS");
  });
  await expect(f.gate.prepare("next")).rejects.toThrow("RUNTIME_UNAVAILABLE");
});
test("an undecodable response cannot release possibly dispatched model work", async () => {
  const f = fixture();
  await expect(f.gate.request("turn/start", async () => { throw Object.assign(new Error("bad protocol"), { code: "CODEX_PROTOCOL_DECODE" }); })).rejects.toThrow();
  await expect(f.gate.prepare("next")).rejects.toThrow("RUNTIME_UNAVAILABLE");
});
