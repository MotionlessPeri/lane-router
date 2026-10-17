import { expect, test } from "vitest";

import { codexDynamicTools } from "../../src/adapters/codex/dynamic-tools.js";
import { LANE_MCP_TOOLS, parseLaneToolArguments } from "../../src/mcp/tool-schemas.js";
import { LANE_TOOLS, type LaneToolName } from "../../src/tools/tool-contract.js";
import { toolArgsSchemas } from "../../src/tools/tool-schema.js";

const text = { type: "string", minLength: 1 };
const list = { type: "array", items: text, minItems: 1 };
const contracts = {
  lane_directory: { required: ["project"], properties: { project: text } },
  lane_attach_current: { required: ["address"], properties: { address: text, role_description: text, model: text } },
  lane_send: { required: ["target", "body", "kind"], properties: { target: text, cc: list, body: { type: "string" }, kind: { type: "string", enum: ["normal", "correction"] }, reply_to: text } },
  lane_ack: { required: ["message_ids"], properties: { message_ids: list } },
  lane_restore_project: { required: [], properties: { lanes: list } },
} satisfies Record<LaneToolName, unknown>;

test("Codex and MCP publish the existing names, shared descriptions, and argument semantics", () => {
  for (const tools of [codexDynamicTools(), LANE_MCP_TOOLS]) {
    expect(tools.map(tool => tool.name)).toEqual([
      "lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBe(LANE_TOOLS.find(shared => shared.name === tool.name)!.description);
      const contract = contracts[tool.name];
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: contract.properties });
      expect(tool.inputSchema.required ?? []).toEqual(contract.required);
      expect(Object.keys(tool.inputSchema.properties as object)).toEqual(Object.keys(contract.properties));
    }
  }
});

test("shared argument parsing preserves normalization, optional fields, and strict rejection", () => {
  const cases: Array<[LaneToolName, Record<string, unknown>, Record<string, unknown>]> = [
    ["lane_directory", { project: " alpha " }, { project: "alpha" }],
    ["lane_attach_current", { address: " alpha/a ", role_description: " role ", model: " model " }, { address: "alpha/a", role_description: "role", model: "model" }],
    ["lane_send", { target: " alpha/a ", cc: [" beta/b "], body: "", kind: "correction", reply_to: " id " }, { target: "alpha/a", cc: ["beta/b"], body: "", kind: "correction", reply_to: "id" }],
    ["lane_ack", { message_ids: [" id "] }, { message_ids: ["id"] }],
    ["lane_restore_project", {}, {}],
    ["lane_restore_project", { lanes: [" alpha/a "] }, { lanes: ["alpha/a"] }],
  ];
  for (const [name, input, output] of cases) {
    expect(toolArgsSchemas[name].parse(input)).toEqual(output);
    expect(parseLaneToolArguments(name, input)).toEqual(output);
    for (const field of ["backend", "conversation_id", "binding_id", "generation", "confirmed"]) {
      expect(() => parseLaneToolArguments(name, { ...input, [field]: "spoof" })).toThrow();
    }
  }
  for (const [name, input] of [
    ["lane_directory", { project: " " }], ["lane_attach_current", { address: "alpha/a", model: " " }],
    ["lane_send", { target: "alpha/a", body: "x", kind: "unknown" }],
    ["lane_send", { target: "alpha/a", body: "x", kind: "normal", cc: [] }],
    ["lane_ack", { message_ids: [] }], ["lane_restore_project", { lanes: [] }],
  ] as const) expect(() => parseLaneToolArguments(name, input)).toThrow();
});
