import type { DashboardLauncherModel } from "../router/dashboard.js";

/**
 * The models the dashboard offers for Claude lanes.
 *
 * Written down rather than discovered, because there is nothing to discover: the Claude CLI has no
 * command that lists models, and nothing under `~/.claude` holds a list either — `settings.json`
 * records the one model in use, not the set to choose from. Codex is the exception, not the rule:
 * its App Server answers `model/list`, which is why that side is enumerated.
 *
 * Aliases rather than versioned ids, because the alias is the part that does not go stale. `claude
 * --help` describes `--model` as taking "an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet') or a model's full name" — so an alias keeps naming the current model of its family,
 * while a list of versions would start rejecting the models that actually exist. That is the same
 * reason the lane's declared model is stored without an allow-list.
 *
 * ⚠️ The menu is a closed list: a model that is not here cannot be picked for a lane from the
 * dashboard. `lane-router-lane open` and the lane's own declaration still take any name.
 */
export const CLAUDE_LAUNCHER_MODELS: readonly DashboardLauncherModel[] = [
  { id: "opus", displayName: "opus", hidden: false, backend: "claude" },
  { id: "sonnet", displayName: "sonnet", hidden: false, backend: "claude" },
  { id: "haiku", displayName: "haiku", hidden: false, backend: "claude" },
  { id: "fable", displayName: "fable", hidden: false, backend: "claude" },
];
