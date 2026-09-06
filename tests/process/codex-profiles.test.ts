import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { defaultCodexModelProvider, listCodexModelProviders, listCodexProfiles, profileModelProvider } from "../../src/process/codex-profiles.js";

function profileHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "lane-router-profiles-"));
  mkdirSync(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(home, name), content);
  return home;
}

test("reads only the top-level model_provider of a Codex profile", () => {
  const home = profileHome({
    "glm.config.toml": "model = \"glm-5.3\"\nmodel_provider = \"ZAI\"\n\n[model_providers.ZAI]\nname = \"ZAI\"\nmodel_provider = \"decoy\"\n",
  });
  try {
    expect(profileModelProvider("glm", home)).toBe("ZAI");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects unknown profiles, profiles without a provider, and unsafe profile names", () => {
  const home = profileHome({ "empty.config.toml": "model = \"gpt-5.6-sol\"\n" });
  try {
    expect(() => profileModelProvider("missing", home)).toThrow(/not found/iu);
    expect(() => profileModelProvider("empty", home)).toThrow(/model_provider/iu);
    expect(() => profileModelProvider("../escape", home)).toThrow(/Invalid/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uses CODEX_HOME semantics and inherits a provider from the base config", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "lane-router-codex-home-"));
  writeFileSync(join(codexHome, "config.toml"), "model_provider = 'ZAI' # inherited\n");
  writeFileSync(join(codexHome, "glm.config.toml"), "model = 'glm-5.3'\n");
  try {
    expect(profileModelProvider("glm", codexHome)).toBe("ZAI");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("lists profile and provider menu choices from Codex config files", () => {
  const codexHome = profileHome({
    "config.toml": "model_provider = \"openai\"\n\n[model_providers.ZAI]\nname = \"ZAI\"\n",
    "glm.config.toml": "model = \"glm-5.3\"\nmodel_provider = \"ZAI\"\n",
    "gpt.config.toml": "model = \"gpt-5.6-sol\"\nmodel_provider = \"openai\"\n",
    "ignored.toml": "model = \"ignored\"\n",
  });
  try {
    expect(listCodexProfiles(codexHome)).toEqual([
      { name: "glm", model: "glm-5.3", modelProvider: "ZAI" },
      { name: "gpt", model: "gpt-5.6-sol", modelProvider: "openai" },
    ]);
    expect(listCodexModelProviders(codexHome)).toEqual(["openai", "ZAI"]);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("profile provider overrides the base with single quotes and an inline comment", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "lane-router-codex-home-"));
  writeFileSync(join(codexHome, "config.toml"), "model_provider = \"openai\"\n");
  writeFileSync(join(codexHome, "glm.config.toml"), "model_provider = 'ZAI' # profile wins\n");
  try {
    expect(profileModelProvider("glm", codexHome)).toBe("ZAI");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("the dashboard default provider follows base config and otherwise uses Codex's built-in provider", () => {
  const inherited = profileHome({ "config.toml": "model_provider = 'ZAI'\n" });
  const builtIn = profileHome({ "config.toml": "model = 'gpt-6-astra'\n" });
  try {
    expect(defaultCodexModelProvider(inherited)).toBe("ZAI");
    expect(defaultCodexModelProvider(builtIn)).toBe("openai");
    expect(listCodexModelProviders(builtIn)).toContain("openai");
  } finally {
    rmSync(inherited, { recursive: true, force: true });
    rmSync(builtIn, { recursive: true, force: true });
  }
});
