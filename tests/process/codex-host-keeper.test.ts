import { expect, test, vi } from "vitest";

import { CodexHostKeeper } from "../../src/process/codex-host-keeper.js";

// Bounded, because a machine without a working Codex would otherwise start a doomed host every few
// seconds for as long as the Router runs; the launcher asks again when someone opens a Codex lane.
test("a host that keeps failing to start is tried a bounded number of times, then left alone", async () => {
  const ensureHost = vi.fn(async () => { throw new Error("no codex"); });
  const logs: string[] = [];
  const keeper = new CodexHostKeeper({ ensureHost, attempts: 3, backoffMs: 10, log: (line) => logs.push(line) });
  keeper.ensure();
  await vi.waitFor(() => expect(ensureHost).toHaveBeenCalledTimes(3));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(ensureHost).toHaveBeenCalledTimes(3);
  expect(logs.at(-1)).toMatch(/attempt 3 of 3\): no codex/u);
  // A later loss of the link is a new reason to look, and gets a fresh set of attempts.
  keeper.ensure();
  await vi.waitFor(() => expect(ensureHost).toHaveBeenCalledTimes(6));
});

test("asking again while an ensure is under way does not start a second one", async () => {
  let finish!: () => void;
  const ensureHost = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const keeper = new CodexHostKeeper({ ensureHost });
  keeper.ensure();
  keeper.ensure();
  expect(ensureHost).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => { keeper.ensure(); expect(ensureHost).toHaveBeenCalledTimes(2); });
});

test("a stopped keeper starts nothing and abandons a scheduled retry", async () => {
  const ensureHost = vi.fn(async () => { throw new Error("no codex"); });
  const keeper = new CodexHostKeeper({ ensureHost, attempts: 3, backoffMs: 50 });
  keeper.ensure();
  await vi.waitFor(() => expect(ensureHost).toHaveBeenCalledTimes(1));
  keeper.stop();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(ensureHost).toHaveBeenCalledTimes(1);
  keeper.ensure();
  expect(ensureHost).toHaveBeenCalledTimes(1);
});
