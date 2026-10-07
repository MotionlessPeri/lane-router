import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZcodeAppServerDisconnectedError, ZcodeAppServerRpcError } from "../../../../src/adapters/zcode/driver/app-server-client.js";
import { ZcodeDriver, type ZcodeClientPort, type ZcodeProcessPort } from "../../../../src/adapters/zcode/driver/driver.js";
import type { SessionEventParams } from "../../../../src/adapters/zcode/driver/protocol.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const PLAN = { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", reasoningLevel: "high" as const };

interface RecordedRequest { readonly method: string; readonly params?: unknown }

/** A mock at the client boundary: records requests, answers from a handler, and can push wire events. */
function mockClient(handle: (method: string, params: any) => unknown = defaultHandle) {
  const requests: RecordedRequest[] = [];
  let eventHandler: (event: SessionEventParams) => void = () => undefined;
  let requestHandler: (request: { readonly method: string }) => Promise<unknown> = async () => undefined;
  const client: ZcodeClientPort = {
    request(method, params) {
      requests.push({ method, ...(params === undefined ? {} : { params }) });
      try { return Promise.resolve(handle(method, params)); } catch (error) { return Promise.reject(error); }
    },
    onEvent(handler) { eventHandler = handler; return () => undefined; },
    onServerRequest(handler) { requestHandler = handler; return () => undefined; },
  };
  return {
    client, requests,
    pushEvent(payload: SessionEventParams["payload"], sessionId = "sess-1") { eventHandler({ sessionId, seq: 0, payload }); },
    answerServerRequest(method: string) { return requestHandler({ method }); },
  };
}

function defaultHandle(method: string, params: any): unknown {
  if (method === "provider/updateAccountConfig") return { receivedRevision: params.revision, providerCount: 8, status: "received" };
  if (method === "session/create") return { sessionId: "sess-1" };
  return {};
}

const fakeProcess: ZcodeProcessPort = { start: async () => undefined, shutdown: async () => undefined, state: "stopped" };

async function tempBuiltin(): Promise<{ builtin: string; personal: string }> {
  const root = await mkdtemp(join(tmpdir(), "lane-router-driver-"));
  roots.push(root);
  const builtin = join(root, "builtin.json");
  await writeFile(builtin, JSON.stringify({ revision: 7 }), "utf8");
  return { builtin, personal: join(root, "personal.json") };
}

async function makeDriver(options: {
  handle?: (method: string, params: any) => unknown;
  driver?: (root: string) => Partial<ConstructorParameters<typeof ZcodeDriver>[0]>;
} = {}) {
  const { builtin, personal } = await tempBuiltin();
  const mock = mockClient(options.handle);
  const logs: string[] = [];
  const driver = new ZcodeDriver({
    launch: { command: "unused" },
    plan: PLAN,
    builtinConfigPath: builtin,
    personalConfigPath: personal,
    now: () => 42,
    newId: () => "id1",
    onLog: (line) => logs.push(line),
    client: mock.client,
    process: fakeProcess,
    ...(options.driver === undefined ? {} : options.driver(dirname(builtin))),
  });
  return { driver, mock, logs, root: dirname(builtin) };
}

describe("ZcodeDriver boot", () => {
  it("spawns lazily and pushes account config exactly once before reporting ready", async () => {
    const { driver, mock, logs } = await makeDriver();
    expect(mock.requests).toHaveLength(0);
    expect(driver.processState).toBe("stopped");
    await driver.ensureStarted();
    expect(mock.requests.map((request) => request.method)).toEqual(["provider/updateAccountConfig"]);
    expect(mock.requests[0]!.params).toMatchObject({ revision: "lane-router-42-id1" });
    await driver.ensureStarted();
    expect(mock.requests).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("stays unstarted when the push is refused, and retries from scratch afterwards", async () => {
    let pushes = 0;
    const { driver, mock } = await makeDriver({
      handle: (method) => {
        if (method !== "provider/updateAccountConfig") return defaultHandle(method, {});
        pushes += 1;
        return pushes === 1 ? { receivedRevision: "mismatch", providerCount: 8, status: "received" } : { receivedRevision: "lane-router-42-id1", providerCount: 8, status: "received" };
      },
    });
    await expect(driver.ensureStarted()).rejects.toThrow(/different revision/u);
    expect(driver.hasSession("sess-1")).toBe(false);
    await driver.ensureStarted();
    expect(pushes).toBe(2);
    expect(mock.requests).toHaveLength(2);
  });

  it("answers the boot server requests from the verified recipe", async () => {
    const { driver, mock } = await makeDriver();
    await driver.ensureStarted();
    expect(await mock.answerServerRequest("session/requestRuntimePreferences")).toEqual({
      nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true,
    });
    expect(await mock.answerServerRequest("interaction/requestOfficialMcpAuthHeaders")).toEqual({ headers: {} });
    // No credentials path: the honest answer is headersApplied:false, never a silent hang.
    await expect(mock.answerServerRequest("interaction/requestProviderRuntimeHeaders")).resolves.toMatchObject({
      headersApplied: false, errorMessage: expect.stringContaining("credentials path") as unknown as string,
    });
    // An unknown server request is refused by name; the client layer turns the rejection into the
    // -32000 reply, so the server's own timeout never fires.
    await expect(mock.answerServerRequest("future/method")).rejects.toThrow(/no responder for future\/method/u);
  });

  it("performs a live key exchange from the configured credentials file when asked at turn time", async () => {
    const secret = "driver-test-secret";
    const token = "driver-oauth-token";
    const key = createHash("sha256").update(secret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(token, "utf8")), cipher.final()]);
    const encrypted = `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;

    const fetch = vi.fn(async (url: string | URL): Promise<Response> => {
      const target = String(url);
      if (target.endsWith("/api/biz/customer/getCustomerInfo")) {
        return new Response(JSON.stringify({ data: { organizations: [{ organizationId: "o", organizationName: "默认机构", projects: [{ projectId: "p", projectName: "默认项目" }] }] } }), { status: 200 });
      }
      if (target.endsWith("/api_keys") && !target.includes("/copy/")) {
        return new Response(JSON.stringify({ data: [{ name: "zcode-api-key", apiKey: "kid" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { secretKey: "shh" } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const { driver, mock, root, logs } = await makeDriver({
      driver: (currentRoot) => ({
        credentialsPath: join(currentRoot, "credentials.json"),
        host: "https://host.test",
        fetch,
        credentialEnv: { ZCODE_CREDENTIAL_SECRET: secret },
      }),
    });
    await writeFile(join(root, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": encrypted }), "utf8");
    await driver.ensureStarted();
    await expect(mock.answerServerRequest("interaction/requestProviderRuntimeHeaders")).resolves.toEqual({
      headersApplied: true, requestAuth: { apiKey: "kid.shh" },
    });
    // The exchange is observable without ever printing what it exchanged.
    expect(logs.some((line) => line.includes("id length 3, secret length 3"))).toBe(true);
    expect(logs.join("\n")).not.toContain("shh");
    expect(logs.join("\n")).not.toContain(token);
  });
});

describe("ZcodeDriver sessions", () => {
  it("creates a session with both workspace fields, the plan model, the mode, and subscribes it", async () => {
    const { driver, mock } = await makeDriver();
    const { sessionId } = await driver.createSession({ workspacePath: "C:/repo", mode: "yolo" });
    expect(sessionId).toBe("sess-1");
    expect(mock.requests.find((request) => request.method === "session/create")!.params).toEqual({
      workspace: { workspacePath: "C:/repo", workspaceKey: "C:/repo" },
      model: { providerId: PLAN.providerId, modelId: PLAN.modelId, options: { reasoningLevel: "high" } },
      mode: "yolo",
    });
    expect(mock.requests.find((request) => request.method === "session/subscribe")!.params)
      .toEqual({ sessionId: "sess-1", deliveryKind: "desktop-continuous" });
    expect(driver.sessionSnapshot("sess-1")).toMatchObject({ busy: false, lastTurnText: null, lastLifecycleAt: null });
  });

  it("sends content (not text) with the model selection and maps the turn onto busy/idle", async () => {
    const settled: string[] = [];
    const { driver, mock } = await makeDriver();
    driver.onTurnSettled((sessionId) => settled.push(sessionId));
    await driver.createSession({ workspacePath: "C:/repo" });

    expect(await driver.send("sess-1", "lane_router_mailbox {...}")).toBe("sent");
    expect(mock.requests.find((request) => request.method === "session/send")!.params).toEqual({
      sessionId: "sess-1",
      content: "lane_router_mailbox {...}",
      modelSelection: { providerId: PLAN.providerId, modelId: PLAN.modelId, options: { reasoningLevel: "high" } },
    });
    expect(driver.sessionSnapshot("sess-1")?.busy).toBe(true);
    expect(await driver.send("sess-1", "second")).toBe("deferred");

    mock.pushEvent({ type: "input.executionStartedAt", turnNumber: 1 });
    mock.pushEvent({ type: "text_delta", text: "partial" });
    expect(driver.sessionSnapshot("sess-1")?.busy).toBe(true);

    mock.pushEvent({ type: "model_complete", content: "final answer", stopReason: "stop" });
    expect(driver.sessionSnapshot("sess-1")).toMatchObject({ busy: false, lastTurnText: "final answer", lastError: null, lastLifecycleAt: 42 });
    expect(settled).toEqual(["sess-1"]);

    // A second completion spelling for the same turn changes nothing: the first settle won.
    mock.pushEvent({ type: "response", response: "echo" });
    expect(driver.sessionSnapshot("sess-1")?.lastTurnText).toBe("final answer");
    expect(settled).toEqual(["sess-1"]);
    expect(await driver.send("sess-1", "next")).toBe("sent");
  });

  it("prefers the completion text over accumulated deltas, and the deltas when it is empty", async () => {
    const { driver, mock } = await makeDriver();
    await driver.createSession({ workspacePath: "C:/repo" });
    await driver.send("sess-1", "x");
    mock.pushEvent({ type: "text_delta", text: "accu" });
    mock.pushEvent({ type: "model_complete", content: "authoritative" });
    expect(driver.sessionSnapshot("sess-1")?.lastTurnText).toBe("authoritative");
  });

  it("records a failed model request, settles the turn, and accepts the next send", async () => {
    const { driver, mock } = await makeDriver();
    await driver.createSession({ workspacePath: "C:/repo" });
    await driver.send("sess-1", "x");
    mock.pushEvent({ type: "model_request_failed", error: { message: "quota exhausted" } });
    expect(driver.sessionSnapshot("sess-1")).toMatchObject({ busy: false, lastError: "quota exhausted" });
    expect(await driver.send("sess-1", "retry")).toBe("sent");
  });

  it("ignores events for sessions it does not know", async () => {
    const { driver, mock } = await makeDriver();
    await driver.createSession({ workspacePath: "C:/repo" });
    mock.pushEvent({ type: "model_complete", content: "stranger" }, "sess-unknown");
    expect(driver.hasSession("sess-unknown")).toBe(false);
    expect(driver.sessionSnapshot("sess-1")?.lastTurnText).toBeNull();
  });

  it("classifies send failures: no_channel for unknown sessions and transport loss, send_failed for rpc errors", async () => {
    const { driver } = await makeDriver();
    expect(await driver.send("sess-none", "x")).toBe("no_channel");

    const paths = await tempBuiltin();
    const loss = mockClient((method, params) => {
      if (method === "session/send") throw new ZcodeAppServerDisconnectedError();
      return defaultHandle(method, params);
    });
    const lossDriver = new ZcodeDriver({
      launch: { command: "unused" }, plan: PLAN, client: loss.client, process: fakeProcess,
      builtinConfigPath: paths.builtin, personalConfigPath: paths.personal,
    });
    await lossDriver.ensureStarted();
    await lossDriver.createSession({ workspacePath: "w" });
    expect(await lossDriver.send("sess-1", "x")).toBe("no_channel");
    expect(lossDriver.sessionSnapshot("sess-1")?.busy).toBe(false);

    const rpc = mockClient((method, params) => {
      if (method === "session/send") throw new ZcodeAppServerRpcError(-32000, "session gone");
      return defaultHandle(method, params);
    });
    const rpcDriver = new ZcodeDriver({
      launch: { command: "unused" }, plan: PLAN, client: rpc.client, process: fakeProcess,
      builtinConfigPath: paths.builtin, personalConfigPath: paths.personal,
    });
    await rpcDriver.ensureStarted();
    await rpcDriver.createSession({ workspacePath: "w" });
    expect(await rpcDriver.send("sess-1", "x")).toBe("send_failed");
    void driver;
  });

  it("resolves waitUntilIdle on settlement and rejects it on abort", async () => {
    const { driver, mock } = await makeDriver();
    await driver.createSession({ workspacePath: "C:/repo" });
    await driver.send("sess-1", "x");
    const waiter = driver.waitUntilIdle("sess-1");
    await expect(driver.waitUntilIdle("sess-1", AbortSignal.abort(new Error("caller gone")))).rejects.toThrow("caller gone");
    mock.pushEvent({ type: "model_complete", content: "done" });
    await expect(waiter).resolves.toBeUndefined();
    await expect(driver.waitUntilIdle("sess-none")).resolves.toBeUndefined();
  });

  it("stops a session and settles an in-flight turn without recording an error", async () => {
    const settled: string[] = [];
    const { driver } = await makeDriver();
    await driver.ensureStarted();
    driver.onTurnSettled((sessionId) => settled.push(sessionId));
    await driver.createSession({ workspacePath: "C:/repo" });
    await driver.send("sess-1", "x");
    await driver.stop("sess-1");
    expect(driver.sessionSnapshot("sess-1")).toMatchObject({ busy: false, lastError: null });
    expect(settled).toEqual(["sess-1"]);
  });

  it("clears every session on shutdown", async () => {
    const { driver } = await makeDriver();
    await driver.ensureStarted();
    await driver.createSession({ workspacePath: "C:/repo" });
    await driver.send("sess-1", "x");
    await driver.shutdown();
    expect(driver.hasSession("sess-1")).toBe(false);
    expect(await driver.send("sess-1", "x")).toBe("no_channel");
  });
});
