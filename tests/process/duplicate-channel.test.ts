import type { WebSocket } from "ws";
import { afterEach, expect, test, vi } from "vitest";

import { DUPLICATE_CHANNEL_CLOSE_CODE } from "../../src/process/channel-close-codes.js";
import { connectClaudeChannel, ReconnectBackoff } from "../../src/process/local-client.js";
import { ClaudeChannelHub, LocalRouterServer, type JoinEvent } from "../../src/process/local-server.js";
import type { BindingRecord } from "../../src/router/types.js";

// Vikunja LR-30: one Claude session that loaded the lane MCP server twice (a user-scope `lane`
// beside the `plugin:lane:lane` plugin) opened two channels under one join key and one conversation.
// Each displaced the other with "replaced", each reconnected at once, and the Router logged a
// channel_connected every ~110 ms until claude.exe was ended. The Router now refuses the second with
// 4409 and keeps the first; the client takes 4409 as final and backs off on any other loss.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const step of cleanup.splice(0).reverse()) await step(); });

function socket(readyState = 1) {
  return {
    on: vi.fn(), close: vi.fn(), readyState, OPEN: 1,
    send: vi.fn((_value: string, callback: (error?: Error) => void) => callback()),
  } as unknown as WebSocket & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

function hubWithLog() {
  const events: JoinEvent[] = [];
  const hub = new ClaudeChannelHub(undefined, () => 5_000, (event) => { events.push(event); }, () => undefined);
  return { hub, events };
}

const binding = (conversationId: string): BindingRecord => ({
  id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId, generation: 1, startup: {}, activeAt: 1, inactiveAt: null,
});
const notification = { laneAddress: "alpha/design", pendingPath: "C:/mailbox/pending", kind: "normal" as const, messageIds: ["m-1"], messages: [] };

test("a second channel with the same join key and conversation is refused with 4409, and the first keeps serving", async () => {
  const { hub, events } = hubWithLog();
  const first = socket(), second = socket();
  hub.connect("conversation-1", first, "4242");
  hub.connect("conversation-1", second, "4242");

  expect(second.close).toHaveBeenCalledWith(DUPLICATE_CHANNEL_CLOSE_CODE, "duplicate lane MCP server in one session");
  expect(first.close).not.toHaveBeenCalled();
  await expect(hub.notify(binding("conversation-1"), notification)).resolves.toBe("sent");
  expect(first.send).toHaveBeenCalledOnce();
  expect(second.send).not.toHaveBeenCalled();
  expect(events.filter((event) => event.event === "join.duplicate_refused"))
    .toEqual([{ event: "join.duplicate_refused", joinKey: "4242", conversationId: "conversation-1", at: 5_000 }]);
  expect(events.filter((event) => event.event === "join.channel_connected")).toHaveLength(1);
});

// Replacement stays what it was for everything that is not two servers of one live session.
test("a new process, a closing predecessor or a client without a join key still replaces", () => {
  const cases = [
    { name: "another join key: the session restarted", first: socket(), firstKey: "4242", secondKey: "5151" },
    { name: "the same join key on a socket already closing", first: socket(2), firstKey: "4242", secondKey: "4242" },
    { name: "no join key at all", first: socket(), firstKey: undefined, secondKey: undefined },
  ];
  for (const entry of cases) {
    const { hub, events } = hubWithLog();
    const second = socket();
    hub.connect("conversation-1", entry.first, entry.firstKey);
    hub.connect("conversation-1", second, entry.secondKey);
    expect(entry.first.close, entry.name).toHaveBeenCalledWith(1000, "replaced");
    expect(second.close, entry.name).not.toHaveBeenCalled();
    expect(events.some((event) => event.event === "join.duplicate_refused"), entry.name).toBe(false);
  }
});

test("waits double from half a second to half a minute", () => {
  const backoff = new ReconnectBackoff(() => 0);
  expect(Array.from({ length: 9 }, () => backoff.next())).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});

// The storm's other half: a channel that opens and is dropped again at once used to count as a
// success, so its wait went back to the first one every time.
test("only a connection that stayed up half a minute starts the waits over", () => {
  let now = 0;
  const backoff = new ReconnectBackoff(() => now);
  backoff.next(); backoff.next(); backoff.next();
  backoff.opened(); now += 29_999;
  expect(backoff.next()).toBe(4_000);
  backoff.opened(); now += 30_000;
  expect(backoff.next()).toBe(500);
  expect(backoff.next()).toBe(1_000);
});

/** A Router that records its join log, with two real clients of one session pointed at it. */
async function startRouter(hub: ClaudeChannelHub) {
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "x", claude: hub });
  const discovery = await server.start();
  cleanup.push(() => server.close());
  return discovery;
}

test("two servers of one session settle on one channel: one refusal, no reconnect loop, the first still notified", async () => {
  const events: JoinEvent[] = [];
  const hub = new ClaudeChannelHub(undefined, Date.now, (event) => { events.push(event); }, () => undefined);
  const discovery = await startRouter(hub);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const first = await connectClaudeChannel(async () => discovery.url, "conversation-1", "4242");
  cleanup.push(() => first.close());
  const second = await connectClaudeChannel(async () => discovery.url, "conversation-1", "4242");
  cleanup.push(() => second.close());
  // The old loop went round every ~110 ms; a second and a half is a dozen turns of it.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  expect(events.filter((event) => event.event === "join.channel_connected")).toHaveLength(1);
  expect(events.filter((event) => event.event === "join.duplicate_refused")).toHaveLength(1);
  const said = stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("4409"));
  expect(said).toHaveLength(1);
  expect(said[0]).toMatch(/another lane MCP server/u);

  const received: unknown[] = [];
  first.attach({ notification: async (value) => { received.push(value); } });
  await expect(hub.notify(binding("conversation-1"), notification)).resolves.toBe("sent");
  await vi.waitFor(() => expect(received).toHaveLength(1));
});

// Any other loss is still reconnected, but no faster than the waits allow: a Router that keeps
// dropping the channel the moment it opens sees a handful of attempts, not one every 100 ms.
test("a channel dropped as soon as it opens is retried on the waits, not at once", async () => {
  const hub = new ClaudeChannelHub(undefined, Date.now, () => undefined, () => undefined);
  const connects: number[] = [];
  vi.spyOn(hub, "connect").mockImplementation((_id, client) => { connects.push(Date.now()); client.close(1000, "replaced"); });
  const discovery = await startRouter(hub);
  const channel = await connectClaudeChannel(async () => discovery.url, "conversation-1", "4242");
  cleanup.push(() => channel.close());
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  // 0, then 0.5 s and 1 s more: three, with the fourth due at 3.5 s. The old loop made twenty.
  expect(connects.length).toBeGreaterThanOrEqual(2);
  expect(connects.length).toBeLessThanOrEqual(4);
}, 10_000);
