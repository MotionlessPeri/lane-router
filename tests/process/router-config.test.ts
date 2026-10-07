import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { readRouterConfig, routerConfigFile } from "../../src/process/router-config.js";

const VALID_DRIVER = {
  credentialsPath: "C:/Users/u/.zcode/v2/credentials.json",
  plan: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", reasoningLevel: "high" },
};

describe("router config", () => {
  it("locates the file under the data root unless the env points elsewhere", () => {
    expect(routerConfigFile("C:/data")).toBe(join("C:/data", "config.json"));
    expect(routerConfigFile("C:/data", { LANE_ROUTER_CONFIG: "C:/elsewhere.json" })).toBe("C:/elsewhere.json");
  });

  it("treats a missing file as an empty config, so the default Router simply runs without the driver", async () => {
    await expect(readRouterConfig({ dataRoot: "C:/data", configFile: "C:/missing.json" })).resolves.toEqual({});
  });

  it("parses a full driver section and applies the zcode command default", async () => {
    const config = await readRouterConfig({
      dataRoot: "unused",
      configFile: "C:/cfg.json",
      readFile: async () => JSON.stringify({ zcode: { driver: { ...VALID_DRIVER } } }),
    });
    expect(config.zcode?.driver).toMatchObject({
      command: "zcode",
      credentialsPath: VALID_DRIVER.credentialsPath,
      plan: VALID_DRIVER.plan,
    });
    expect(config.zcode?.driver?.builtinPath).toBeUndefined();
  });

  it("keeps an explicit command, args, env and both provider paths", async () => {
    const config = await readRouterConfig({
      dataRoot: "unused",
      configFile: "C:/cfg.json",
      readFile: async () => JSON.stringify({ zcode: { driver: {
        command: "node",
        args: ["C:/z/zcode.cjs", "app-server", "--stdio"],
        env: { ZCODE_CREDENTIAL_SECRET: "s" },
        builtinPath: "C:/builtin.json",
        personalPath: "C:/personal.json",
        host: "https://open.bigmodel.cn",
        ...VALID_DRIVER,
      } } }),
    });
    expect(config.zcode?.driver).toMatchObject({
      command: "node",
      args: ["C:/z/zcode.cjs", "app-server", "--stdio"],
      env: { ZCODE_CREDENTIAL_SECRET: "s" },
      builtinPath: "C:/builtin.json",
      personalPath: "C:/personal.json",
    });
  });

  it.each([
    ["invalid JSON", async () => "not json{"],
    ["an unknown top-level section", async () => JSON.stringify({ codex: {} })],
    ["an unknown driver field", async () => JSON.stringify({ zcode: { driver: { ...VALID_DRIVER, surprise: 1 } } })],
    ["builtin without personal", async () => JSON.stringify({ zcode: { driver: { ...VALID_DRIVER, builtinPath: "C:/b.json" } } })],
    ["an invalid reasoning level", async () => JSON.stringify({ zcode: { driver: { ...VALID_DRIVER, plan: { ...VALID_DRIVER.plan, reasoningLevel: "medium" } } } })],
    ["a missing credentials path", async () => JSON.stringify({ zcode: { driver: { plan: VALID_DRIVER.plan } } })],
  ])("rejects %s", async (_label, read) => {
    await expect(readRouterConfig({ dataRoot: "unused", configFile: "C:/cfg.json", readFile: read })).rejects.toThrow();
  });
});
