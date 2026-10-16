import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";

const pageSource = readFileSync(fileURLToPath(new URL("../../src/process/dashboard.html", import.meta.url)), "utf8");

const HOSTILE_SCRIPT = "<script>alert(1)</script>";
const HOSTILE_IMAGE = "<img src=x onerror=alert(1)>";

/**
 * Everything on this board was written by another lane or by a person. The snapshot below puts
 * markup in each of the three places the design names — body, role description, cwd — because a
 * page that escapes one of them and not the others is a page that escapes none of them.
 */
const snapshot = {
  capturedAt: 1_788_180_000_000,
  router: { pid: 1, port: 52494, instanceId: "instance-1", schemaVersion: 5 },
  lanes: [{
    address: "alpha/one", project: "alpha", roleDescription: `role ${HOSTILE_IMAGE}`, model: null, archived: false,
    binding: { backend: "claude", conversationId: "conversation-1", generation: 1, cwd: `C:/${HOSTILE_SCRIPT}`, attachedAt: 1_788_179_000_000 },
    reach: { state: "live", connectedAt: null, lastLifecycleAt: 1_788_179_500_000, lastNotifiedAt: null, believedBusy: false },
    restorePresence: "online",
    pending: { count: 1, oldestCreatedAt: 1_788_179_000_000 },
  }],
  messages: [{
    id: "message-1", sender: "alpha/one", target: "alpha/one", kind: "normal", replyTo: null,
    createdAt: 1_788_179_000_000, state: "pending", resolvedAt: null, ackLane: null,
    notificationState: "sent", body: `${HOSTILE_SCRIPT} and ${HOSTILE_IMAGE}`,
  }],
  truncated: { messages: false, limit: 200 },
};

const launcherSnapshot = {
  ...snapshot,
  actionToken: "action-token-1",
  launcher: {
    defaultModelProvider: "ZAI",
    // Shaped like what the Router now publishes: the Claude aliases first, then whatever Codex
    // reports, each carrying the backend it belongs to.
    models: [
      { id: "opus", displayName: "opus", hidden: false, backend: "claude" },
      { id: "sonnet", displayName: "sonnet", hidden: false, backend: "claude" },
      { id: "haiku", displayName: "haiku", hidden: false, backend: "claude" },
      { id: "fable", displayName: "fable", hidden: false, backend: "claude" },
      { id: "glm-5.3", displayName: "GLM 5.3", hidden: false, backend: "codex" },
      { id: "gpt-6-astra", displayName: "GPT 6 Astra", hidden: true, backend: "codex" },
    ],
    profiles: [
      { name: "glm", model: "glm-5.3", modelProvider: "ZAI" },
      { name: "gpt", model: "gpt-5.6-sol", modelProvider: "openai" },
    ],
    modelProviders: ["openai", "ZAI"],
  },
  lanes: [
    {
      ...snapshot.lanes[0]!, address: "alpha/offline", project: "alpha", binding: {
        ...snapshot.lanes[0]!.binding!, backend: "codex", profile: "gpt", modelProvider: "openai",
      }, restorePresence: "offline",
    },
    {
      ...snapshot.lanes[0]!, address: "beta/online", project: "beta", restorePresence: "online",
    },
    // Unbound, so the launcher disables it: there is no conversation to resume. Present in the
    // fixture because the disabled branch is what "select all" must not reach past, and a fixture
    // where every lane is selectable cannot tell a correct select-all from one that ticks anything
    // it finds.
    {
      ...snapshot.lanes[0]!, address: "beta/unbound", project: "beta",
      binding: null, reach: null, restorePresence: "unavailable",
    },
  ],
};

/**
 * The document is parsed from the shipped page and every DOM call below lands on happy-dom's own
 * implementation — which is the point, because `textContent` and `innerHTML` differing is the
 * whole property under test, and a stand-in DOM written here would be judging its own author.
 *
 * The page's script is started by hand rather than by the parser: this happy-dom (20.12.0) parses
 * inline scripts into the tree but never evaluates them — measured, with the script element
 * present, its text intact, and no console output or error event. So the script text is taken
 * from the parsed document, exactly what a browser would have run, and given the document to work
 * on. What this does not cover is the page's own loading — that is the manual case.
 */
async function render(): Promise<Window["document"]> {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script, "the page must carry exactly one inline script").toBeTruthy();
  const fetchStub = async () => ({ ok: true, json: async () => snapshot });
  // No interval: one render is what is under test, and a live timer would outlive the test.
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub, () => 0);
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/one"));
  return window.document;
}

async function renderLauncher() {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script).toBeTruthy();
  const calls: Array<{ url?: string | URL; init?: RequestInit }> = [];
  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url, init });
    if (calls.length === 1) return { ok: true, json: async () => launcherSnapshot };
    const addresses = JSON.parse(String(init?.body)).addresses as string[];
    return { ok: true, json: async () => ({ results: [
      { address: "alpha/offline", status: "launch_requested" },
      ...(addresses.includes("beta/online") ? [{ address: "beta/online", status: "skipped_online" }] : []),
    ] }) };
  });
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/offline"));
  return { document: window.document, window, calls };
}

async function renderLauncherWithRefresh() {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script).toBeTruthy();
  const firstSnapshot = launcherSnapshot;
  const secondSnapshot = {
    ...launcherSnapshot,
    router: { ...launcherSnapshot.router!, pid: 2 },
  };
  const fetchStub = vi.fn(async () => ({ ok: true, json: async () => firstSnapshot }));
  const run = () =>
    new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
  run();
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/offline"));
  return {
    document: window.document,
    refresh: async () => {
      fetchStub.mockImplementation(async () => ({ ok: true, json: async () => secondSnapshot }));
      run();
      await vi.waitFor(() => expect(window.document.body.textContent).toContain("pid 2"));
    },
  };
}

test("hostile text in a snapshot is shown, not run", async () => {
  const document = await render();

  // Visible as characters, in all three places the snapshot poisoned.
  expect(document.body.textContent).toContain(HOSTILE_SCRIPT);
  expect(document.body.textContent).toContain(HOSTILE_IMAGE);

  // The teeth: markup in the data must never have become markup in the document. `innerHTML`
  // would create both of these elements — and the img's onerror fires even though the script's
  // does not, which is why counting elements is the assertion rather than watching for alerts.
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(document.querySelectorAll("script")).toHaveLength(1);
});

test("the launcher starts with nothing selected and submits one protected request", async () => {
  const { document, calls } = await renderLauncher();
  const checkboxes = [...document.querySelectorAll("input[data-lane-checkbox]")];
  // Both sides, not just the restorable one: a default that ticks anything makes opening a lane
  // one stray click away, and asserting only the online lane would pass under either default.
  expect(checkboxes.map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([false, false, false]);
  expect(document.querySelector("button#open-selected")?.hasAttribute("disabled")).toBe(false);

  (document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (document.querySelector("#override-model") as HTMLInputElement).value = "glm-5.3";
  (document.querySelector("#override-profile") as HTMLInputElement).value = "glm";
  (document.querySelector("#override-provider") as HTMLInputElement).value = "ZAI";
  (document.querySelector("button#open-selected") as HTMLButtonElement).click();

  await vi.waitFor(() => expect(document.body.textContent).toContain("已请求打开"));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.url).toBe("/dashboard/lanes/open");
  expect(calls[1]!.init?.method).toBe("POST");
  expect(new Headers(calls[1]!.init?.headers).get("x-lane-router-action")).toBe("open");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
    addresses: ["alpha/offline"],
    override: { model: "glm-5.3", profile: "glm", modelProvider: "ZAI" },
    actionToken: "action-token-1",
  });
});

test("the section people operate comes first and the long ones start folded", async () => {
  const document = await render();

  const headings = [...document.querySelectorAll("h2, summary.section")].map((node) => node.textContent);
  expect(headings[0]).toBe("恢复 lane");

  // Folded, not removed: 29 lanes with their role descriptions and 200 message bodies are what
  // pushed the launcher below the fold, and they are still worth reaching in two clicks.
  expect(document.querySelector("#lanes")?.closest("details")?.hasAttribute("open")).toBe(false);
  expect(document.querySelector("#messages")?.closest("details")?.hasAttribute("open")).toBe(false);
  // The backlog stays open on purpose — it is the panel that shows a lane nobody is answering,
  // and it is short enough not to cost anything.
  expect(document.querySelector("#backlog")?.closest("details")).toBeNull();
});

test("select-all reaches every restorable lane and stops at the ones it cannot open", async () => {
  const { document, window } = await renderLauncher();
  const selectAll = document.querySelector("input[data-select-all]") as HTMLInputElement;
  const checked = () =>
    [...document.querySelectorAll("input[data-lane-checkbox]")].map((box) => (box as HTMLInputElement).checked);

  expect(selectAll.checked).toBe(false);

  selectAll.checked = true;
  selectAll.dispatchEvent(new window.Event("change"));
  // The unbound lane stays false: it has no conversation to resume, so selecting it would report a
  // choice the launcher cannot act on.
  expect(checked()).toEqual([true, true, false]);

  selectAll.checked = false;
  selectAll.dispatchEvent(new window.Event("change"));
  expect(checked()).toEqual([false, false, false]);
});

test("select-all shows a third state while only some lanes are picked", async () => {
  const { document, window } = await renderLauncher();
  const selectAll = document.querySelector("input[data-select-all]") as HTMLInputElement;
  const one = document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement;

  one.checked = true;
  one.dispatchEvent(new window.Event("change"));

  // Neither ticked nor clear: ticking it from here means "select everything", and showing it as
  // checked would make the next click a silent deselect of a lane the reader had chosen.
  expect(selectAll.checked).toBe(false);
  expect(selectAll.indeterminate).toBe(true);
});

test("the model menu offers Claude aliases and says which CLI each name belongs to", async () => {
  const { document } = await renderLauncher();
  const options = [...(document.querySelector("#override-model")?.querySelectorAll("option") ?? [])];
  const byValue = new Map(options.map((option) => [option.getAttribute("value"), option.textContent]));

  // Aliases, not versioned ids: the Claude CLI has no listing command, and an alias keeps naming
  // the current model of its family while a version would go stale.
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) expect(byValue.has(alias)).toBe(true);

  // Both backends share one menu, so each option says which one it is for — picking a Codex model
  // for a Claude lane fails at the CLI, far from this choice.
  expect(byValue.get("opus")).toContain("claude");
  expect(byValue.get("glm-5.3")).toContain("codex");
});

test("the model menu narrows to the CLI of the lanes that are picked", async () => {
  const { document, window } = await renderLauncher();
  const model = document.querySelector("#override-model") as HTMLSelectElement;
  const enabled = () =>
    [...model.querySelectorAll("option")].filter((option) => !option.disabled).map((option) => option.getAttribute("value"));
  const tick = (address: string, on: boolean) => {
    const box = document.querySelector(`input[data-lane-checkbox][value='${address}']`) as HTMLInputElement;
    box.checked = on;
    box.dispatchEvent(new window.Event("change"));
  };

  // Nothing picked yet, so nothing is ruled out.
  expect(enabled()).toContain("opus");
  expect(enabled()).toContain("glm-5.3");

  // alpha/offline is a Codex lane, so the Claude aliases drop out and the Codex models stay.
  tick("alpha/offline", true);
  expect(enabled()).not.toContain("opus");
  expect(enabled()).toContain("glm-5.3");
  expect(enabled()).toContain("");

  // beta/online is a Claude lane. One override goes to both, and no model suits both, so only
  // "leave it alone" is left.
  tick("beta/online", true);
  expect(enabled()).toEqual([""]);
});

test("a model that stops suiting the selection is cleared, not left showing", async () => {
  const { document, window } = await renderLauncher();
  const model = document.querySelector("#override-model") as HTMLSelectElement;

  model.value = "opus";
  const claude = document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement;
  claude.checked = true;
  claude.dispatchEvent(new window.Event("change"));
  expect(model.value).toBe("opus");

  // Adding a Codex lane leaves opus applying to only half the selection. Leaving it selected would
  // submit an override that lane cannot use, so it goes back to "default".
  const codex = document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement;
  codex.checked = true;
  codex.dispatchEvent(new window.Event("change"));
  expect(model.value).toBe("");
});

test("clicking open with nothing selected says so and sends no request", async () => {
  const { document, calls } = await renderLauncher();
  const before = calls.length;

  (document.querySelector("button#open-selected") as HTMLButtonElement).click();

  await vi.waitFor(() => expect(document.querySelector("#launcher-status")?.textContent).toContain("先勾选"));
  // The point of the guard is that nothing leaves the page: the Router would answer an empty list
  // with a 400, and the reader would be told a status code instead of what they did.
  expect(calls).toHaveLength(before);
});

test("the launcher offers constrained startup menus and fills a profile's startup facts", async () => {
  const { document, window } = await renderLauncher();
  const model = document.querySelector("#override-model");
  const profile = document.querySelector("#override-profile");
  const provider = document.querySelector("#override-provider");

  expect(model?.tagName).toBe("SELECT");
  expect(profile?.tagName).toBe("SELECT");
  expect(provider?.tagName).toBe("SELECT");
  expect([...(profile?.querySelectorAll("option") ?? [])].map((option) => option.getAttribute("value")))
    .toEqual(["", "glm", "gpt"]);
  expect([...(provider?.querySelectorAll("option") ?? [])].map((option) => option.getAttribute("value")))
    .toEqual(["", "openai", "ZAI"]);

  (profile as HTMLSelectElement).value = "glm";
  (profile as HTMLSelectElement).dispatchEvent(new window.Event("change"));

  expect((model as HTMLSelectElement).value).toBe("glm-5.3");
  expect((provider as HTMLSelectElement).value).toBe("ZAI");
});

test("switching from a GLM profile to a GPT model also returns to the default provider", async () => {
  const { document, window, calls } = await renderLauncher();
  const model = document.querySelector("#override-model") as HTMLSelectElement;
  const profile = document.querySelector("#override-profile") as HTMLSelectElement;
  const provider = document.querySelector("#override-provider") as HTMLSelectElement;

  profile.value = "glm";
  profile.dispatchEvent(new window.Event("change"));
  expect(provider.value).toBe("ZAI");

  model.value = "gpt-6-astra";
  model.dispatchEvent(new window.Event("change"));

  expect(model.value).toBe("gpt-6-astra");
  expect(profile.value).toBe("");
  expect(provider.value).toBe("openai");

  (document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (document.querySelector("button#open-selected") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(JSON.parse(String(calls[1]!.init?.body)).override).toEqual({
    model: "gpt-6-astra",
    modelProvider: "openai",
  });
});

test("a launcher refresh keeps operator choices instead of resetting offline defaults", async () => {
  const { document, refresh } = await renderLauncherWithRefresh();
  // A Codex lane with Codex overrides: the point here is that a poll keeps what the operator
  // chose, so the choice has to be one that stands on its own rather than one the model filter
  // would clear for a reason of its own.
  (document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement).checked = false;
  (document.querySelector("#override-model") as HTMLInputElement).value = "glm-5.3";
  (document.querySelector("#override-profile") as HTMLInputElement).value = "glm";
  (document.querySelector("#override-provider") as HTMLInputElement).value = "ZAI";
  (document.querySelector("#override-model") as HTMLInputElement).focus();

  await refresh();

  const checkboxes = [...document.querySelectorAll("input[data-lane-checkbox]")];
  expect(checkboxes.map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([true, false, false]);
  const groupCheckboxes = [...document.querySelectorAll("input[data-group-checkbox]")];
  expect(groupCheckboxes.map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([true, false]);
  expect(groupCheckboxes.map((checkbox) => (checkbox as HTMLInputElement).indeterminate)).toEqual([false, false]);
  expect((document.querySelector("#override-model") as HTMLInputElement).value).toBe("glm-5.3");
  expect(document.activeElement?.id).toBe("override-model");
  expect((document.querySelector("#override-profile") as HTMLInputElement).value).toBe("glm");
  expect((document.querySelector("#override-provider") as HTMLInputElement).value).toBe("ZAI");
});

test("an open result remains visible when polling replaces the launcher while the request is pending", async () => {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script).toBeTruthy();
  let poll: (() => void) | undefined;
  let resolveOpen: ((value: unknown) => void) | undefined;
  const fetchStub = vi.fn((url: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Promise((resolve) => { resolveOpen = resolve; });
    }
    return Promise.resolve({ ok: true, json: async () => launcherSnapshot });
  });
  new Function("document", "fetch", "setInterval", script!)(
    window.document,
    fetchStub as never,
    (callback: () => void) => { poll = callback; return 0; },
  );
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/offline"));

  (window.document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (window.document.querySelector("button#open-selected") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
  poll?.();
  await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(3));
  resolveOpen?.({ ok: true, json: async () => ({ results: [{ address: "alpha/offline", status: "launch_requested" }] }) });

  await vi.waitFor(() => expect(window.document.querySelector("#launcher-status")?.textContent).toContain("已请求打开"));
});

test("open results are localized and grouped by project", async () => {
  const { document, calls } = await renderLauncher();
  (document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement).checked = true;
  (document.querySelector("button#open-selected") as HTMLButtonElement).click();

  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await vi.waitFor(() => expect(document.querySelector("#launcher-status")?.textContent).toContain("已请求打开"));
  expect(document.querySelector("#launcher-status")?.textContent).toContain("alpha\nalpha/offline：已请求打开");
  expect(document.querySelector("#launcher-status")?.textContent).toContain("beta\nbeta/online：已在线，跳过");
});

test("the launcher rejects Codex profile overrides when Claude lanes are selected", async () => {
  const { document, calls } = await renderLauncher();
  (document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement).checked = true;
  (document.querySelector("#override-profile") as HTMLSelectElement).value = "glm";

  (document.querySelector("button#open-selected") as HTMLButtonElement).click();

  expect(calls).toHaveLength(1);
  expect(document.querySelector("#launcher-status")?.textContent).toContain("Claude lane");
});

test("the launcher stays read-only when the Router does not publish an action token", async () => {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  const fetchStub = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/one"));
  expect(window.document.querySelector("button#open-selected")?.hasAttribute("disabled")).toBe(true);
  (window.document.querySelector("button#open-selected") as HTMLButtonElement).click();
  expect(fetchStub).toHaveBeenCalledOnce();
});

test("the launcher lists projects and their lanes alphabetically, whatever order the snapshot has", async () => {
  // Deliberately scrambled, with a capitalised project in the middle: the snapshot comes in
  // creation order, and a person looking for a project reads by name, not by case.
  const scrambled = {
    ...launcherSnapshot,
    lanes: [
      { ...snapshot.lanes[0]!, address: "zeta/one", project: "zeta", restorePresence: "offline" },
      { ...snapshot.lanes[0]!, address: "Beta/two", project: "Beta", restorePresence: "offline" },
      { ...snapshot.lanes[0]!, address: "alpha/one", project: "alpha", restorePresence: "offline" },
      { ...snapshot.lanes[0]!, address: "Beta/one", project: "Beta", restorePresence: "offline" },
    ],
  };
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  const fetchStub = vi.fn(async () => ({ ok: true, json: async () => scrambled }));
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("zeta/one"));

  const groups = [...window.document.querySelectorAll("section.lane-group")];
  expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["alpha", "Beta", "zeta"]);
  const betaLanes = [...window.document.querySelectorAll("section.lane-group[data-group='Beta'] input[data-lane-checkbox]")];
  expect(betaLanes.map((checkbox) => (checkbox as HTMLInputElement).value)).toEqual(["Beta/one", "Beta/two"]);
});

/**
 * A Router with lane sets: alpha/offline and gamma/one are in "research", across two projects, so
 * neither alpha nor gamma has a group of its own any more; "empty" has no lanes; the beta lanes
 * are in no set and stay under their project.
 */
const setSnapshot = {
  ...launcherSnapshot,
  lanes: [
    ...launcherSnapshot.lanes,
    { ...snapshot.lanes[0]!, address: "gamma/one", project: "gamma", restorePresence: "offline" },
  ],
  laneSets: [
    { id: "set-research", name: "research", members: ["alpha/offline", "gamma/one"] },
    { id: "set-empty", name: "empty", members: [] },
  ],
};

/** Serves `state` for every poll and answers each POST with `answer`, recording every call. */
function startPage(state: unknown, answer: (url: string, body: Record<string, unknown>) => { ok: boolean; status?: number; json: () => Promise<unknown> } = () => ({
  ok: true, json: async () => ({ laneSets: setSnapshot.laneSets }),
})) {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script).toBeTruthy();
  let current = state;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST") return answer(String(url), JSON.parse(String(init.body)) as Record<string, unknown>);
    return { ok: true, json: async () => current };
  });
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
  const posts = () => calls.filter((call) => call.init?.method === "POST");
  const gets = () => calls.filter((call) => call.init?.method !== "POST");
  return {
    window, document: window.document, calls, posts, gets,
    ready: () => vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/offline")),
    /** Polls again, the way the interval would, after the snapshot changed to `next`. */
    poll: async (next: unknown, marker: string) => {
      current = next;
      new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub as never, () => 0);
      await vi.waitFor(() => expect(window.document.body.textContent).toContain(marker));
    },
  };
}

function laneText(document: Window["document"], address: string): string {
  return (document.querySelector(`input[data-lane-checkbox][value='${address}']`)?.closest("label")?.textContent ?? "").trim();
}

test("the launcher groups lanes by set, and by project for the lanes in none, empty sets included", async () => {
  const page = startPage(setSnapshot);
  await page.ready();
  const groups = [...page.document.querySelectorAll("section.lane-group")];
  expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["beta", "empty", "research"]);
  // Across projects, so each lane carries its project in front of its name.
  const research = [...page.document.querySelectorAll("section.lane-group[data-group='research'] input[data-lane-checkbox]")];
  expect(research.map((checkbox) => (checkbox as HTMLInputElement).value)).toEqual(["alpha/offline", "gamma/one"]);
  expect(laneText(page.document, "gamma/one")).toBe("gamma/one · claude · offline · 未声明模型");

  const empty = page.document.querySelector("section.lane-group[data-group='empty']")!;
  expect(empty.textContent).toContain("（空）");
  expect(empty.querySelector("button[data-delete-set='set-empty']")).not.toBeNull();
  // Only an empty set offers deletion: the Router refuses the others, and a button that can only
  // fail is a button that should not be there.
  expect(page.document.querySelectorAll("button[data-delete-set]")).toHaveLength(1);

  // The group's own box picks its lanes, wherever they came from.
  const box = page.document.querySelector("input[data-group-checkbox='research']") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new page.window.Event("change"));
  expect(research.map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([true, true]);
});

// Grouping by set changed where a row sits, not what it says. The row keeps backend, Codex
// startup, presence and model: presence is how the reader tells an already open lane from one
// worth ticking. It was cut once on a misread of the user's words (2026-10-16) and put back.
test("a lane row still names its backend, startup, presence and model under set grouping", async () => {
  const page = startPage(setSnapshot);
  await page.ready();
  expect(laneText(page.document, "alpha/offline")).toBe("alpha/offline · codex · gpt / openai · offline · 未声明模型");
  expect(laneText(page.document, "beta/online")).toBe("beta/online · claude · online · 未声明模型");
  expect(laneText(page.document, "beta/unbound")).toBe("beta/unbound · 未绑定 · unavailable · 未声明模型");
});

test("creating, moving and deleting each send one protected request and then reload", async () => {
  const page = startPage(setSnapshot);
  await page.ready();
  const name = page.document.querySelector("input[data-set-control]") as HTMLInputElement;
  const move = page.document.querySelector("select#move-to-set") as HTMLSelectElement;
  expect(move.getAttribute("data-set-control")).not.toBeNull();
  expect([...move.querySelectorAll("option")].map((option) => [option.getAttribute("value"), option.textContent]))
    .toEqual([["", "项目默认"], ["set-empty", "empty"], ["set-research", "research"]]);

  /** One click: exactly one protected request with this body, then exactly one reload. */
  const press = async (selector: string, body: Record<string, unknown>) => {
    const posts = page.posts().length;
    const reloads = page.gets().length;
    (page.document.querySelector(selector) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(page.posts()).toHaveLength(posts + 1));
    const post = page.posts().at(-1)!;
    expect(post.url).toBe("/dashboard/lane-sets");
    expect(new Headers(post.init?.headers).get("x-lane-router-action")).toBe("lane-sets");
    expect(new Headers(post.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(post.init?.body))).toEqual({ ...body, actionToken: "action-token-1" });
    await vi.waitFor(() => expect(page.gets()).toHaveLength(reloads + 1));
  };

  name.value = "curvenet";
  await press("button#create-set", { action: "create", name: "curvenet" });
  // A name that was just used is not left behind as unfinished input.
  expect((page.document.querySelector("input[data-set-control]") as HTMLInputElement).value).toBe("");

  (page.document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement).checked = true;
  (page.document.querySelector("select#move-to-set") as HTMLSelectElement).value = "set-research";
  await press("button#move-selected", { action: "assign", addresses: ["beta/online"], setId: "set-research" });

  // "项目默认" is the empty value, and it means back to the project: null, not an empty id.
  (page.document.querySelector("select#move-to-set") as HTMLSelectElement).value = "";
  await press("button#move-selected", { action: "assign", addresses: ["beta/online"], setId: null });

  await press("button[data-delete-set='set-empty']", { action: "delete", setId: "set-empty" });
  expect(page.posts()).toHaveLength(4);
});

test("moving with no lane ticked says so and sends nothing", async () => {
  const page = startPage(setSnapshot);
  await page.ready();
  (page.document.querySelector("select#move-to-set") as HTMLSelectElement).value = "set-research";
  (page.document.querySelector("button#move-selected") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(page.document.querySelector("#launcher-status")?.textContent).toContain("先勾选"));
  expect(page.posts()).toHaveLength(0);
});

test("a refused set request shows the Router's words", async () => {
  const page = startPage(setSnapshot, () => ({
    ok: false, status: 409, json: async () => ({ error: "research is already a project with lanes in service; give the set another name" }),
  }));
  await page.ready();
  (page.document.querySelector("input[data-set-control]") as HTMLInputElement).value = "research";
  (page.document.querySelector("button#create-set") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(page.document.querySelector("#launcher-status")?.textContent).toContain("already a project"));
  expect(page.document.querySelector("#launcher-status")?.className).toBe("warn");
});

// The open button sends every [data-override] control's value as an override. A set control
// marked that way would send "move-to-set: set-research" to the CLI as if it were a launch option.
test("the set controls never ride along in an open request's override", async () => {
  const page = startPage(setSnapshot, (url) => ({
    ok: true, json: async () => (url === "/dashboard/lanes/open" ? { results: [{ address: "alpha/offline", status: "launch_requested" }] } : { laneSets: [] }),
  }));
  await page.ready();
  (page.document.querySelector("input[data-set-control]") as HTMLInputElement).value = "curvenet";
  (page.document.querySelector("select#move-to-set") as HTMLSelectElement).value = "set-research";
  (page.document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (page.document.querySelector("button#open-selected") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(page.posts()).toHaveLength(1));
  expect(page.posts()[0]!.url).toBe("/dashboard/lanes/open");
  expect(JSON.parse(String(page.posts()[0]!.init?.body)).override).toEqual({});
});

test("a poll keeps what was typed and chosen in the set controls", async () => {
  const page = startPage(setSnapshot);
  await page.ready();
  (page.document.querySelector("input[data-set-control]") as HTMLInputElement).value = "curvenet";
  (page.document.querySelector("select#move-to-set") as HTMLSelectElement).value = "set-research";
  (page.document.querySelector("input[data-set-control]") as HTMLInputElement).focus();

  await page.poll({ ...setSnapshot, router: { ...setSnapshot.router, pid: 2 } }, "pid 2");

  expect((page.document.querySelector("input[data-set-control]") as HTMLInputElement).value).toBe("curvenet");
  expect((page.document.querySelector("select#move-to-set") as HTMLSelectElement).value).toBe("set-research");
  expect(page.document.activeElement).toBe(page.document.querySelector("input[data-set-control]"));
});

// `dist/dashboard.html` is read on every request, so a build reaches the running Router's page
// before the Router itself is restarted onto the build that publishes sets. That page has to be
// today's page.
test("without laneSets in the snapshot there is no set control and lanes group by project", async () => {
  const page = startPage(launcherSnapshot);
  await page.ready();
  expect(page.document.querySelectorAll("[data-set-control]")).toHaveLength(0);
  expect(page.document.querySelector("button#create-set")).toBeNull();
  expect(page.document.querySelector("button#move-selected")).toBeNull();
  expect(page.document.querySelectorAll("button[data-delete-set]")).toHaveLength(0);
  expect([...page.document.querySelectorAll("section.lane-group")].map((group) => group.getAttribute("data-group")))
    .toEqual(["alpha", "beta"]);
  expect(page.document.querySelector("button#open-selected")?.hasAttribute("disabled")).toBe(false);
});

test("open results are grouped the way the launcher groups the lanes", async () => {
  const page = startPage(setSnapshot, () => ({
    ok: true, json: async () => ({ results: [
      { address: "alpha/offline", status: "launch_requested" },
      { address: "beta/online", status: "skipped_online" },
    ] }),
  }));
  await page.ready();
  (page.document.querySelector("input[data-lane-checkbox][value='alpha/offline']") as HTMLInputElement).checked = true;
  (page.document.querySelector("input[data-lane-checkbox][value='beta/online']") as HTMLInputElement).checked = true;
  (page.document.querySelector("button#open-selected") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(page.document.querySelector("#launcher-status")?.textContent).toContain("已请求打开"));
  expect(page.document.querySelector("#launcher-status")?.textContent).toContain("research\nalpha/offline：已请求打开");
  expect(page.document.querySelector("#launcher-status")?.textContent).toContain("beta\nbeta/online：已在线，跳过");
});
