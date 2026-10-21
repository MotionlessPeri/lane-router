import { parseLaneAddress } from "./address.js";
import type { LaneRecord } from "./types.js";

/**
 * A task lane is one opened for a bounded piece of work, and says so in the first words of its
 * role: 「任务 lane：为问答 `<id>` 开，归属 `<父 lane>`，完成条件：…，完成即归档。」 That sentence is
 * also what lets it finish itself, and lets a parent close it. Finishing ends with archiving, which
 * is permanent, so a role lane that called it by mistake must be refused rather than lost.
 * Spec docs/superpowers/specs/2026-10-21-task-lane.md.
 */
export const TASK_LANE_PREFIX = "任务 lane：";

export function isTaskLane(roleDescription: string): boolean {
  return roleDescription.trimStart().startsWith(TASK_LANE_PREFIX);
}

/**
 * Where the work the lane was opened for continues: its issue and its parent, from the first sentence.
 * The spec puts both in backticks, but roles are typed by hand and the backticks get left out, so a
 * bare value is read too, as long as it looks like what it is: an issue id of eight hex characters
 * or a whole UUID, and a lane address the Router itself would accept.
 */
export function taskLaneOrigin(roleDescription: string): { readonly issue: string | null; readonly parent: string | null } {
  const issue = /问答\s*`([^`]+)`/u.exec(roleDescription)?.[1]
    ?? /问答\s*([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?![0-9a-z-])/iu.exec(roleDescription)?.[1]
    ?? null;
  const parent = /归属\s*`([^`]+)`/u.exec(roleDescription)?.[1]
    ?? laneAddressOrNull(/归属\s*([^\s，,。；;`]+)/u.exec(roleDescription)?.[1]);
  return { issue, parent };
}

function laneAddressOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  try { return parseLaneAddress(value).address; } catch { return null; }
}

/** The refusal a finished lane's sender reads, naming where a follow-up should go instead. */
export function finishedLaneRefusal(lane: LaneRecord): string {
  const { issue, parent } = taskLaneOrigin(lane.roleDescription);
  const places = [issue === null ? null : `问答 \`${issue}\``, parent === null ? null : `\`${parent}\``].filter((place) => place !== null);
  const instead = places.length === 0 ? "该任务 lane 已完成。" : `该任务 lane 已完成；追问请到${places.join(" 或联系 ")}。`;
  return `Lane ${lane.address} is a finished task lane and takes no more mail. ${instead}`;
}
