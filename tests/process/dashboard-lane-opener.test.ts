import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import type { RouterStateStore } from "../../src/router/state-store.js";
import { RouterStateStore as ConcreteRouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord } from "../../src/router/types.js";
import { DashboardLaneOpener, type DashboardOpenOverride } from "../../src/process/dashboard-lane-opener.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-dashboard-open-")); roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new ConcreteRouterStateStore(database);
  const restore = vi.fn(async (_binding: BindingRecord, _override?: DashboardOpenOverride) =>
    ({ status: "launch_requested" as const }));
  const opener = new DashboardLaneOpener({ state, restore: { restore } });
  return { root, database, state, restore, opener };
}

function addBoundLane(
  state: RouterStateStore,
  address: string,
  backend: "claude" | "codex",
): void {
  const project = address.split("/")[0]!;
  state.createLane({ address, project, roleDescription: `role ${address}`, now: 1 });
  state.createBinding({
    id: `binding-${address}`, laneAddress: address, backend,
    conversationId: `${backend}-${address}`, generation: 1, startup: {}, now: 2,
  });
}

test("opens a deduplicated selection across projects with one override", async () => {
  const x = setup();
  try {
    addBoundLane(x.state, "alpha/a", "codex");
    addBoundLane(x.state, "beta/b", "claude");
    const override: DashboardOpenOverride = { model: "glm-5.3" };

    await expect(x.opener.open({ addresses: ["alpha/a", "beta/b", "alpha/a"], override })).resolves.toEqual({
      results: [
        { address: "alpha/a", status: "launch_requested" },
        { address: "beta/b", status: "launch_requested" },
      ],
    });
    expect(x.restore).toHaveBeenCalledTimes(2);
    expect(x.restore.mock.calls[0]![1]).toEqual(override);
  } finally { x.database.close(); }
});

test("rejects the whole selection before launching when a lane has no active binding", async () => {
  const x = setup();
  try {
    addBoundLane(x.state, "alpha/a", "codex");
    x.state.createLane({ address: "alpha/b", project: "alpha", roleDescription: "unbound", now: 1 });

    await expect(x.opener.open({ addresses: ["alpha/a", "alpha/b"] }))
      .rejects.toThrow(/alpha\/b has no active binding/u);
    expect(x.restore).not.toHaveBeenCalled();
  } finally { x.database.close(); }
});

test("rejects provider and profile overrides for a selection that includes Claude lanes", async () => {
  const x = setup();
  try {
    addBoundLane(x.state, "alpha/codex", "codex");
    addBoundLane(x.state, "beta/claude", "claude");

    await expect(x.opener.open({
      addresses: ["alpha/codex", "beta/claude"],
      override: { profile: "glm", modelProvider: "ZAI" },
    })).rejects.toThrow(/only valid for Codex lanes/u);
    expect(x.restore).not.toHaveBeenCalled();
  } finally { x.database.close(); }
});

test("resolves a profile-only override to that profile's provider", async () => {
  const x = setup();
  try {
    addBoundLane(x.state, "alpha/codex", "codex");
    const opener = new DashboardLaneOpener({
      state: x.state,
      restore: { restore: x.restore },
      resolveProfileProvider: (profile: string) => profile === "glm" ? "ZAI" : "openai",
    });

    await opener.open({ addresses: ["alpha/codex"], override: { profile: "glm" } });

    expect(x.restore.mock.calls[0]![1]).toEqual({ profile: "glm", modelProvider: "ZAI" });
  } finally { x.database.close(); }
});

test("rejects an override value absent from the launcher menus before launching", async () => {
  const x = setup();
  try {
    addBoundLane(x.state, "alpha/codex", "codex");
    const opener = new DashboardLaneOpener({
      state: x.state,
      restore: { restore: x.restore },
      overrideChoices: {
        models: ["glm-5.3", "gpt-6-astra"],
        profiles: ["gpt", "glm"],
        modelProviders: ["openai", "ZAI"],
      },
    });

    await expect(opener.open({
      addresses: ["alpha/codex"],
      override: { profile: "glm", modelProvider: "glm" },
    })).rejects.toThrow(/unknown modelProvider override: glm/iu);
    expect(x.restore).not.toHaveBeenCalled();
  } finally { x.database.close(); }
});

test("rejects an empty or invalid selection before launching", async () => {
  const x = setup();
  try {
    await expect(x.opener.open({ addresses: [] })).rejects.toThrow(/select at least one lane/iu);
    await expect(x.opener.open({ addresses: ["not-an-address"] })).rejects.toThrow(/invalid lane address/iu);
    await expect(x.opener.open({ addresses: ["alpha/missing"] })).rejects.toThrow(/lane not found/iu);
    expect(x.restore).not.toHaveBeenCalled();
  } finally { x.database.close(); }
});
