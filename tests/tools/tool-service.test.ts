import { expect, test, vi } from "vitest";

import { LANE_TOOLS, LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";
import { ToolService } from "../../src/tools/tool-service.js";

function setup() {
  const router = {
    directory: vi.fn(() => []),
    attachCurrent: vi.fn(async () => ({ generation: 1 })),
    send: vi.fn(async () => ({ id: "message-1" })),
    ack: vi.fn(async () => ({ resolved: ["message-1"] })),
    restoreProject: vi.fn(async () => ({ project: "alpha", results: [] })),
  };
  return { router, tools: new ToolService(router as never) };
}

const context = { backend: "codex" as const, conversationId: "thread-1", requestKey: "codex:call-1" };

test("exports the five Lane Router tools", () => {
  expect(LANE_TOOL_NAMES).toEqual(["lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project"]);
  expect(LANE_TOOLS.find((tool) => tool.name === "lane_attach_current")?.description).toMatch(/explicit confirmation/i);
});

test("validates and dispatches all tools with authoritative caller context", async () => {
  const x = setup();
  await x.tools.call("lane_directory", { project: "alpha" }, context);
  await x.tools.call("lane_attach_current", { address: "alpha/design", role_description: "Design." }, context);
  await x.tools.call("lane_send", { target: "alpha/test", body: "hello", kind: "correction", reply_to: "message-0" }, context);
  await x.tools.call("lane_ack", { message_ids: ["message-1"] }, context);
  await x.tools.call("lane_restore_project", { lanes: ["alpha/test"] }, context);
  expect(x.router.directory).toHaveBeenCalledWith("alpha");
  expect(x.router.attachCurrent).toHaveBeenCalledWith(context, { address: "alpha/design", roleDescription: "Design." }, undefined);
  expect(x.router.send).toHaveBeenCalledWith(context, { target: "alpha/test", body: "hello", kind: "correction", replyTo: "message-0" });
  expect(x.router.ack).toHaveBeenCalledWith(context, { messageIds: ["message-1"] });
  expect(x.router.restoreProject).toHaveBeenCalledWith(context, { lanes: ["alpha/test"] });
});

test.each([
  ["lane_directory", { project: "alpha", conversation_id: "spoof" }],
  ["lane_attach_current", { address: "alpha/design", confirmed: true }],
  ["lane_send", { target: "alpha/test", body: "x", kind: "normal", generation: 2 }],
  ["lane_ack", { message_ids: ["message-1"], admin: true }],
  ["lane_restore_project", { lanes: ["alpha/test"], project: "beta" }],
] as const)("rejects caller-controlled internal fields for %s", async (name, args) => {
  const x = setup();
  await expect(x.tools.call(name, args, context)).rejects.toThrow(/unrecognized/i);
});
