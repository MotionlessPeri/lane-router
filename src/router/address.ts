import { join } from "node:path";

export interface LaneAddress {
  readonly address: string;
  readonly project: string;
  readonly lane: string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._%~-]*$/u;

export function parseLaneAddress(value: string): LaneAddress {
  if (value.trim() !== value) throw invalidAddress(value);
  const parts = value.split("/");
  if (parts.length !== 2 || !parts.every((part) => SEGMENT.test(part))) {
    throw invalidAddress(value);
  }
  return { address: value, project: parts[0]!, lane: parts[1]! };
}

export function mailboxLanePath(dataRoot: string, address: LaneAddress): string {
  return join(
    dataRoot,
    "mailboxes",
    encodeURIComponent(address.project),
    encodeURIComponent(address.lane),
  );
}

function invalidAddress(value: string): Error {
  return new Error(`Invalid lane address: ${JSON.stringify(value)}`);
}
