import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MODEL_PATTERN = /^\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/u;
const MODEL_PROVIDER_PATTERN = /^\s*model_provider\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/u;
const MODEL_PROVIDER_TABLE_PATTERN = /^\s*\[model_providers\.([^\]]+)\]\s*$/u;
const TABLE_HEADER_PATTERN = /^\s*\[/u;

export interface CodexProfileChoice {
  readonly name: string;
  readonly model?: string;
  readonly modelProvider?: string;
}

/**
 * Resolve the model provider selected by a Codex V2 profile (`~/.codex/<name>.config.toml`).
 * Only the top-level `model_provider` key counts; provider tables may repeat key names, so every
 * line after the first table header is ignored.
 */
export function profileModelProvider(profile: string, codexHome: string = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string {
  if (!PROFILE_NAME_PATTERN.test(profile)) throw new Error(`Invalid Codex profile name: ${profile}`);
  const configPath = join(codexHome, `${profile}.config.toml`);
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Codex profile config not found: ${configPath}`);
  }
  const selected = topLevelModelProvider(content);
  if (selected !== undefined) return selected;
  try {
    const inherited = topLevelModelProvider(readFileSync(join(codexHome, "config.toml"), "utf8"));
    if (inherited !== undefined) return inherited;
  } catch { /* the profile still gets the precise missing-provider error below */ }
  throw new Error(`Codex profile ${profile} does not set a top-level model_provider in ${configPath}`);
}

/**
 * List the profiles the dashboard can safely offer as menu items. A profile without a resolvable
 * provider is omitted because selecting it can only produce a launcher failure.
 */
export function listCodexProfiles(codexHome: string = process.env.CODEX_HOME ?? join(homedir(), ".codex")): CodexProfileChoice[] {
  const base = readSettingsIfPresent(join(codexHome, "config.toml"));
  return profileFileNames(codexHome)
    .flatMap((fileName): CodexProfileChoice[] => {
      const name = fileName.slice(0, -".config.toml".length);
      if (!PROFILE_NAME_PATTERN.test(name)) return [];
      const settings = readSettingsIfPresent(join(codexHome, fileName));
      const modelProvider = settings.modelProvider ?? base.modelProvider;
      if (modelProvider === undefined) return [];
      return [{
        name,
        ...(settings.model === undefined ? {} : { model: settings.model }),
        modelProvider,
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Provider ids come from config tables as well as top-level selections; both are valid launches. */
export function listCodexModelProviders(codexHome: string = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string[] {
  const providers = new Set<string>();
  for (const fileName of ["config.toml", ...profileFileNames(codexHome)]) {
    const content = readSettingsIfPresent(join(codexHome, fileName));
    if (content.modelProvider !== undefined) providers.add(content.modelProvider);
    for (const provider of content.modelProviderTables) providers.add(provider);
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

function topLevelModelProvider(content: string): string | undefined {
  return readSettings(content).modelProvider;
}

function profileFileNames(codexHome: string): string[] {
  try {
    return readdirSync(codexHome, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".config.toml"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readSettingsIfPresent(path: string): ReturnType<typeof readSettings> {
  try { return readSettings(readFileSync(path, "utf8")); }
  catch { return { model: undefined, modelProvider: undefined, modelProviderTables: [] }; }
}

function readSettings(content: string): { model?: string; modelProvider?: string; modelProviderTables: readonly string[] } {
  let model: string | undefined;
  let modelProvider: string | undefined;
  let topLevel = true;
  const modelProviderTables = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const providerTable = MODEL_PROVIDER_TABLE_PATTERN.exec(line);
    if (providerTable?.[1] && PROFILE_NAME_PATTERN.test(providerTable[1])) modelProviderTables.add(providerTable[1]);
    if (TABLE_HEADER_PATTERN.test(line)) {
      topLevel = false;
      continue;
    }
    if (topLevel) {
      const modelMatch = MODEL_PATTERN.exec(line);
      if (modelMatch?.[2]) model = modelMatch[2];
      const providerMatch = MODEL_PROVIDER_PATTERN.exec(line);
      if (providerMatch?.[2]) modelProvider = providerMatch[2];
    }
  }
  return { model, modelProvider, modelProviderTables: [...modelProviderTables] };
}
