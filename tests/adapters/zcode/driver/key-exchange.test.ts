import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  credentialSecret,
  createProviderRuntimeHeadersResponder,
  decryptCredentialValue,
  exchangeApiKey,
} from "../../../../src/adapters/zcode/driver/key-exchange.js";

const SECRET = "unit-test-secret";
const TOKEN = "oauth-token-value";

function encrypt(value: string): string {
  const key = createHash("sha256").update(SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function credentialsFile(token: string): Promise<string> {
  return Promise.resolve(JSON.stringify({
    "oauth:bigmodel:access_token": token,
    "zcodejwttoken": encrypt("not-the-one"),
  }));
}

interface RequestLogEntry { readonly url: string; readonly init?: RequestInit }

function bigmodelApi(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; body: unknown }>) {
  const requests: RequestLogEntry[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    requests.push({ url: target, init });
    const hit = responses.find((entry) => entry.match(target, init));
    if (!hit) return new Response(JSON.stringify({ code: 404, msg: `unexpected ${target}` }), { status: 200 });
    return new Response(JSON.stringify(hit.body), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const CUSTOMER_INFO = {
  code: 0,
  data: {
    organizations: [
      { organizationId: "org-second", organizationName: "第二机构", projects: [{ projectId: "proj-other", projectName: "别项目" }] },
      { organizationId: "org-default", organizationName: "我的默认机构呀", projects: [
        { projectId: "proj-second", projectName: "另一项目" },
        { projectId: "proj-default", projectName: "就叫默认项目吧" },
      ] },
    ],
  },
};

describe("zcode credential store", () => {
  it("derives the secret from the env override or the documented fallback", () => {
    expect(credentialSecret({ ZCODE_CREDENTIAL_SECRET: " explicit " }, { platform: "win32", homedir: "C:/Users/u", username: "u" })).toBe("explicit");
    expect(credentialSecret({}, { platform: "win32", homedir: "C:/Users/u", username: "u" }))
      .toBe("zcode-credential-fallback:win32:C:/Users/u:u");
    expect(credentialSecret({ ZCODE_CREDENTIAL_SECRET: "   " }, { platform: "linux", homedir: "/home/u", username: "u" }))
      .toBe("zcode-credential-fallback:linux:/home/u:u");
  });

  it("decrypts enc:v1 values with AES-256-GCM and passes plaintext through", () => {
    expect(decryptCredentialValue(encrypt(TOKEN), SECRET)).toBe(TOKEN);
    expect(decryptCredentialValue("plaintext", SECRET)).toBe("plaintext");
    expect(() => decryptCredentialValue("enc:v1:only-two.parts", SECRET)).toThrow(/Malformed/u);
    expect(() => decryptCredentialValue(encrypt(TOKEN), "wrong-secret")).toThrow();
  });
});

describe("zcode key exchange", () => {
  it("walks the three-step exchange, preferring the 默认机构/默认项目 names", async () => {
    const keysUrl = "https://open.bigmodel.cn/api/biz/v1/organization/org-default/projects/proj-default/api_keys";
    const { fetch, requests } = bigmodelApi([
      { match: (url) => url.endsWith("/api/biz/customer/getCustomerInfo"), body: CUSTOMER_INFO },
      { match: (url, init) => url === keysUrl && init?.method === undefined, body: { code: 0, data: [{ name: "zcode-api-key", apiKey: "key-1" }] } },
      { match: (url) => url === `${keysUrl}/copy/key-1`, body: { code: 0, data: { secretKey: "  secret-1  " } } },
    ]);

    const apiKey = await exchangeApiKey({
      credentialsPath: "C:/creds.json", secret: SECRET, fetch,
      readCredentialsFile: () => credentialsFile(encrypt(TOKEN)),
    });
    expect(apiKey).toBe("key-1.secret-1");
    expect(requests.map((entry) => entry.url)).toEqual([
      "https://open.bigmodel.cn/api/biz/customer/getCustomerInfo",
      keysUrl,
      `${keysUrl}/copy/key-1`,
    ]);
    expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it("creates the dedicated key when none exists, then copies it", async () => {
    const keysUrl = "https://host.test/api/biz/v1/organization/o/projects/p/api_keys";
    const { fetch, requests } = bigmodelApi([
      { match: (url) => url.endsWith("/getCustomerInfo"), body: { code: 0, data: { organizations: [{ organizationId: "o", organizationName: "默认机构", projects: [{ projectId: "p", projectName: "默认项目" }] }] } } },
      { match: (url, init) => url === keysUrl && init?.method === undefined, body: { code: 0, data: [] } },
      { match: (url, init) => url === keysUrl && init?.method === "POST", body: { code: 0, data: { name: "zcode-api-key", apiKey: "created-9" } } },
      { match: (url) => url === `${keysUrl}/copy/created-9`, body: { code: 0, data: { secretKey: "s" } } },
    ]);
    const apiKey = await exchangeApiKey({
      credentialsPath: "creds", secret: SECRET, host: "https://host.test", fetch,
      readCredentialsFile: () => credentialsFile("plaintext-token"),
    });
    expect(apiKey).toBe("created-9.s");
    const post = requests.find((entry) => entry.init?.method === "POST");
    expect(JSON.parse(String(post!.init!.body))).toEqual({ name: "zcode-api-key" });
  });

  it("fails with messages that name neither the token nor the secret", async () => {
    const { fetch } = bigmodelApi([
      { match: (url) => url.endsWith("/getCustomerInfo"), body: { code: 401, msg: "令牌无效" } },
    ]);
    const error = await exchangeApiKey({
      credentialsPath: "creds", secret: SECRET, fetch,
      readCredentialsFile: () => credentialsFile(encrypt(TOKEN)),
    }).then(() => undefined, (failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.message).toMatch(/getCustomerInfo/u);
  });

  it("names the missing pieces precisely", async () => {
    await expect(exchangeApiKey({ credentialsPath: "creds", secret: SECRET, fetch: async () => new Response("x"), readCredentialsFile: async () => "not json" }))
      .rejects.toThrow(/credential store/u);
    await expect(exchangeApiKey({ credentialsPath: "creds", secret: SECRET, fetch: async () => new Response("x"), readCredentialsFile: async () => JSON.stringify({}) }))
      .rejects.toThrow(/oauth:bigmodel:access_token/u);
  });
});

describe("provider runtime headers responder", () => {
  it("answers a successful exchange with headersApplied and the composed apiKey", async () => {
    const keysUrl = "https://open.bigmodel.cn/api/biz/v1/organization/o/projects/p/api_keys";
    const { fetch } = bigmodelApi([
      { match: (url) => url.endsWith("/getCustomerInfo"), body: { data: { organizations: [{ organizationId: "o", organizationName: "默认机构", projects: [{ projectId: "p", projectName: "默认项目" }] }] } } },
      { match: (url) => url === keysUrl, body: { data: [{ name: "zcode-api-key", apiKey: "id-7" }] } },
      { match: (url) => url === `${keysUrl}/copy/id-7`, body: { data: { secretKey: "sec-9" } } },
    ]);
    const logs: string[] = [];
    const responder = createProviderRuntimeHeadersResponder({
      credentialsPath: "creds", fetch, secretSource: () => SECRET,
      readCredentialsFile: () => credentialsFile("plain"),
      onExchanged: (summary) => logs.push(`${summary.keyIdLength}/${summary.secretLength}`),
    });
    await expect(responder(undefined)).resolves.toEqual({ headersApplied: true, requestAuth: { apiKey: "id-7.sec-9" } });
    expect(logs).toEqual(["4/5"]);
  });

  it("answers a failed exchange with headersApplied:false instead of throwing", async () => {
    const responder = createProviderRuntimeHeadersResponder({
      credentialsPath: "creds",
      fetch: async () => { throw new Error("network down"); },
      secretSource: () => SECRET,
      readCredentialsFile: () => credentialsFile("plain"),
    });
    await expect(responder(undefined)).resolves.toEqual({ headersApplied: false, errorMessage: "network down" });
  });

  it("declines cleanly when no credentials path is configured", async () => {
    const responder = createProviderRuntimeHeadersResponder({ secretSource: () => SECRET });
    await expect(responder(undefined)).resolves.toMatchObject({ headersApplied: false });
  });
});
