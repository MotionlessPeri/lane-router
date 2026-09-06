import { parseLaneAddress } from "../router/address.js";
import type { RouterStateStore } from "../router/state-store.js";
import type { BindingRecord } from "../router/types.js";
import type { RestoreOverride, RestoreResult } from "./conversation-restorer.js";

export type DashboardOpenOverride = RestoreOverride;

export interface DashboardOverrideChoices {
  readonly models: readonly string[];
  readonly profiles: readonly string[];
  readonly modelProviders: readonly string[];
}

type OpenResult = { readonly address: string } & RestoreResult;

interface DashboardLaneOpenerDependencies {
  readonly state: Pick<RouterStateStore, "lane" | "activeBindingForLane">;
  readonly restore: {
    restore(binding: BindingRecord, override?: DashboardOpenOverride): Promise<RestoreResult>;
  };
  readonly overrideChoices?: DashboardOverrideChoices;
}

/**
 * Validate the whole dashboard selection before opening any window.
 *
 * A partial batch is worse than a refusal here: the user asked for a set of lanes by clicking one
 * button, and half a set can look like the project is running when its coordinator or reviewer is
 * still absent. Address, binding, and backend checks therefore all finish before the first restore.
 */
export class DashboardLaneOpener {
  constructor(private readonly dependencies: DashboardLaneOpenerDependencies) {}

  async open(input: { readonly addresses: readonly string[]; readonly override?: DashboardOpenOverride }): Promise<{ readonly results: readonly OpenResult[] }> {
    if (input.addresses.length === 0) throw new Error("Select at least one lane to open");
    const override = validateOverride(input.override, this.dependencies.overrideChoices);
    const selected = new Map<string, BindingRecord>();

    for (const raw of input.addresses) {
      const address = parseLaneAddress(raw).address;
      if (selected.has(address)) continue;
      if (!this.dependencies.state.lane(address)) throw new Error(`Lane not found: ${address}`);
      const binding = this.dependencies.state.activeBindingForLane(address);
      if (!binding) throw new Error(`Lane ${address} has no active binding`);
      if ((override.profile !== undefined || override.modelProvider !== undefined) && binding.backend !== "codex") {
        throw new Error("profile and modelProvider overrides are only valid for Codex lanes");
      }
      selected.set(address, binding);
    }

    const results: OpenResult[] = [];
    for (const [address, binding] of selected) {
      try {
        results.push({ address, ...await this.dependencies.restore.restore(binding, override) });
      } catch (error) {
        results.push({
          address,
          status: "failed",
          reason: "terminal_launch_failed",
          message: error instanceof Error ? error.message : "Conversation restore failed",
        });
      }
    }
    return { results };
  }
}

function validateOverride(value: DashboardOpenOverride | undefined, choices: DashboardOverrideChoices | undefined): DashboardOpenOverride {
  if (value === undefined) return {};
  for (const key of ["model", "profile", "modelProvider"] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "string" || field.trim() === "")) {
      throw new Error(`${key} override must be a non-empty string`);
    }
  }
  if (choices !== undefined) {
    const allowed = {
      model: choices.models,
      profile: choices.profiles,
      modelProvider: choices.modelProviders,
    };
    for (const key of ["model", "profile", "modelProvider"] as const) {
      const field = value[key];
      if (field !== undefined && !allowed[key].includes(field)) {
        throw new Error(`Unknown ${key} override: ${field}`);
      }
    }
  }
  return value;
}
