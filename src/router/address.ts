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

/** Whether a name could be one part of a lane address: the same rule, not a copy of it. */
export function isAddressSegment(value: string): boolean {
  return SEGMENT.test(value);
}

export function mailboxLanePath(dataRoot: string, address: LaneAddress): string {
  return join(
    dataRoot,
    "mailboxes",
    encodeURIComponent(address.project),
    encodeURIComponent(address.lane),
  );
}

/**
 * The origin a local program names itself by when it delivers a message on the user's behalf. Held
 * to a short lowercase identifier because it is the one part of a message header a caller chooses:
 * anything wider is a way to write something other than an origin into the sender line.
 */
const ORIGIN = /^[a-z0-9-]{1,32}$/u;
const SENDER_LABEL_PREFIX = "user:";

/**
 * The sender of a message that no lane sent. Told apart from a lane address by shape alone — an
 * address always has a slash and a label never does — which is what lets every reader of a message
 * header, a notification, or a row see at a glance that a lane did not write it.
 */
export function senderLabel(origin: string): string {
  if (!ORIGIN.test(origin)) throw new Error(`Invalid origin: ${JSON.stringify(origin)}; use 1-32 of a-z, 0-9 and -`);
  return `${SENDER_LABEL_PREFIX}${origin}`;
}

export function isSenderLabel(value: string): boolean {
  return value.startsWith(SENDER_LABEL_PREFIX) && ORIGIN.test(value.slice(SENDER_LABEL_PREFIX.length));
}

function invalidAddress(value: string): Error {
  return new Error(`Invalid lane address: ${JSON.stringify(value)}`);
}
