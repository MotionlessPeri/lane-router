import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { providerRuntimeHeadersResultSchema, type ProviderRuntimeHeadersResult } from "./protocol.js";

export const DEFAULT_BIGMODEL_HOST = "https://open.bigmodel.cn";
const ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const API_KEY_NAME = "zcode-api-key";

/**
 * The credential store derives its AES key from this secret when ZCODE_CREDENTIAL_SECRET is unset,
 * matching the CLI's own derivation byte for byte: platform, homedir and username of the user who
 * logged in. Everything is injected so tests (and any future host) never need the real store.
 */
export function credentialSecret(
  env: { readonly ZCODE_CREDENTIAL_SECRET?: string },
  fallback: { readonly platform: string; readonly homedir: string; readonly username: string },
): string {
  return env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${fallback.platform}:${fallback.homedir}:${fallback.username}`;
}

/** Values are either plaintext (older stores) or `enc:v1:<iv>.<tag>.<ct>` base64url AES-256-GCM. */
export function decryptCredentialValue(value: string, secret: string): string {
  if (!value.startsWith("enc:v1:")) return value;
  const [iv, tag, ciphertext] = value.slice("enc:v1:".length).split(".");
  if (iv === undefined || tag === undefined || ciphertext === undefined) throw new Error("Malformed enc:v1 credential value");
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

type Json = Record<string, unknown>;

/**
 * The signing-key exchange the desktop host performs at turn time: OAuth token from the store,
 * customer info for the default org/project, then the dedicated API key's secret. Mirrors the
 * verified probe exactly, including the tolerance for `code` being 0, 200 or absent.
 *
 * Error messages name fields and endpoints only: the token and the secret must never travel into
 * an exception, because exceptions are what logs print.
 */
export async function exchangeApiKey(input: {
  readonly credentialsPath: string;
  readonly secret: string;
  readonly host?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly readCredentialsFile?: (path: string) => Promise<string>;
}): Promise<string> {
  const host = (input.host ?? DEFAULT_BIGMODEL_HOST).replace(/\/$/u, "");
  const read = input.readCredentialsFile ?? ((path: string) => readFile(path, "utf8"));
  const doFetch = input.fetch ?? globalThis.fetch;
  let credentials: unknown;
  try { credentials = JSON.parse(await read(input.credentialsPath)); } catch {
    throw new Error("Unable to read the ZCode credential store");
  }
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new Error("ZCode credential store is not an object");
  }
  const encryptedToken = (credentials as Record<string, unknown>)[ACCESS_TOKEN_KEY];
  if (typeof encryptedToken !== "string" || encryptedToken.length === 0) {
    throw new Error(`Credential store has no ${ACCESS_TOKEN_KEY}`);
  }
  const accessToken = decryptCredentialValue(encryptedToken, input.secret);

  const headers = { Authorization: accessToken, "Content-Type": "application/json" };
  const getJson = async (url: string, init?: RequestInit): Promise<Json> => {
    const response = await doFetch(url, { ...init, headers });
    const body = await response.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`Bigmodel biz API returned a non-object body from ${pathOf(url)}`);
    assertBizOk(body as Json, pathOf(url));
    return body as Json;
  };

  const info = await getJson(`${host}/api/biz/customer/getCustomerInfo`);
  const customer = dataOf(info.data, "getCustomerInfo.data");
  const organizations = dataList(customer.organizations, "getCustomerInfo.data.organizations");
  const organization = organizations.find((entry) => nameOf(entry).includes("默认机构")) ?? organizations[0];
  if (organization === undefined) throw new Error("getCustomerInfo returned no organizations");
  const projects = dataList(organization.projects, "getCustomerInfo organization projects");
  const project = projects.find((entry) => nameOf(entry).includes("默认项目")) ?? projects[0];
  if (project === undefined) throw new Error("getCustomerInfo returned no projects for the default organization");
  const organizationId = idOf(organization, "organizationId");
  const projectId = idOf(project, "projectId");

  const keysUrl = `${host}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
  const keys = dataList((await getJson(keysUrl)).data, "api_keys.data");
  let entry = keys.find((key) => key.name === API_KEY_NAME);
  if (entry === undefined) {
    const created = await getJson(keysUrl, { method: "POST", body: JSON.stringify({ name: API_KEY_NAME }) });
    entry = recordOf(created.data, "api_keys create response data");
  }
  const keyId = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
  if (keyId === "") throw new Error("api_keys response is missing apiKey");

  const copied = await getJson(`${keysUrl}/copy/${encodeURIComponent(keyId)}`);
  const secretKey = dataOf(copied.data, "api_keys copy response data");
  const secret = typeof secretKey.secretKey === "string" ? secretKey.secretKey.trim() : "";
  if (secret === "") throw new Error("api_keys copy response is missing secretKey");
  return `${keyId}.${secret}`;
}

/**
 * The answer to interaction/requestProviderRuntimeHeaders. Failure is a *successful* answer —
 * `{headersApplied:false}` — because the alternative (not replying) leaves the server blocked for
 * its own 180s timeout while the user sees a hung turn.
 */
export function createProviderRuntimeHeadersResponder(dependencies: {
  readonly credentialsPath?: string;
  readonly host?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly secretSource: () => string;
  readonly readCredentialsFile?: (path: string) => Promise<string>;
  readonly onExchanged?: (summary: { readonly keyIdLength: number; readonly secretLength: number }) => void;
}): (params: unknown) => Promise<ProviderRuntimeHeadersResult> {
  return async () => {
    if (dependencies.credentialsPath === undefined) {
      return { headersApplied: false, errorMessage: "No credentials path is configured for the ZCode driver" };
    }
    try {
      const apiKey = await exchangeApiKey({
        credentialsPath: dependencies.credentialsPath,
        host: dependencies.host,
        fetch: dependencies.fetch,
        readCredentialsFile: dependencies.readCredentialsFile,
        secret: dependencies.secretSource(),
      });
      const separator = apiKey.indexOf(".");
      const keyId = separator === -1 ? apiKey : apiKey.slice(0, separator);
      // Lengths only, never the values: this hook is the one place the exchange could leak a
      // credential into a log, and a length is all a post-mortem ever needed.
      dependencies.onExchanged?.({ keyIdLength: keyId.length, secretLength: apiKey.length - keyId.length - 1 });
      return providerRuntimeHeadersResultSchema.parse({ headersApplied: true, requestAuth: { apiKey } });
    } catch (error) {
      return { headersApplied: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };
}

function assertBizOk(body: Json, source: string): void {
  const code = body.code;
  if (code !== undefined && code !== 0 && code !== 200) {
    const message = typeof body.msg === "string" ? body.msg : "no message";
    throw new Error(`${source} failed with code=${String(code)}: ${message}`);
  }
}

function dataList(value: unknown, label: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value.filter((entry): entry is Json => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function dataOf(value: unknown, label: string): Json {
  if (value === undefined || value === null) throw new Error(`${label} is missing`);
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Json;
}

function recordOf(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Json;
}

function nameOf(entry: Json): string {
  return typeof entry.organizationName === "string" ? entry.organizationName : typeof entry.projectName === "string" ? entry.projectName : "";
}

function idOf(entry: Json, field: "organizationId" | "projectId"): string {
  const value = entry[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`getCustomerInfo entry is missing ${field}`);
  return value;
}

function pathOf(url: string): string {
  const marker = "/api/biz/";
  const index = url.indexOf(marker);
  return index === -1 ? url : url.slice(index + "/api".length);
}
