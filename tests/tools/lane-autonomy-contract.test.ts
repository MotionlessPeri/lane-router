import { expect, test } from "vitest";

import { LANE_ROUTER_INSTRUCTIONS, LANE_TOOLS } from "../../src/tools/tool-contract.js";

const description = (name: string) => LANE_TOOLS.find((tool) => tool.name === name)?.description ?? "";

// Spec 2026-10-20-lane-autonomy-gates.md, acceptance 1 and 2: the gate is instruction text, read
// both where the attach tool is described and where every conversation is told at its start.
test.each([
  ["the lane_attach_current description", description("lane_attach_current")],
  ["the instructions every conversation starts with", LANE_ROUTER_INSTRUCTIONS],
])("%s confirms only a takeover of someone else's live lane or a role change", (_where, text) => {
  expect(text).toContain("Creating a lane, waking or restoring an offline lane, and rotating yourself to a fresh generation of the same lane (keeping its role) do not need the user's confirmation.");
  expect(text).toContain("Before taking over a lane that a different, still-live conversation holds, or before changing an existing lane's role description, explain the change and obtain the user's explicit confirmation in the conversation.");
  expect(text).toContain("If you are unsure whether an attach would rotate your own role or displace someone else's live lane, treat it as a takeover and confirm.");
  expect(text).toContain("Do not add a confirmation argument.");
  expect(text).not.toContain("Before creating, replacing, rotating, or changing the role description of a lane");
});

// Acceptance 3: waking a peer the current task needs is no longer reserved for the user's request.
test("lane_restore_project wakes the lanes the task needs without waiting to be asked", () => {
  expect(description("lane_restore_project")).not.toContain("Call only when the user explicitly asks to reopen lanes.");
  expect(description("lane_restore_project")).toContain("Call when you need to reach offline peer lanes for the current task; wake only the lanes you actually need, not speculatively in bulk.");
});
