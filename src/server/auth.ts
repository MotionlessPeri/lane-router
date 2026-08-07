import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export function createDiscoveryToken(): string {
  return randomBytes(32).toString("base64url");
}
export function isAuthorized(
  header: string | undefined,
  token: string,
): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(supplied, expected);
}

export type ActorSession =
  | Readonly<{ kind: "admin"; id: string }>
  | Readonly<{ kind: "binding"; id: string; generation: number }>;

export function createAdminSession(): ActorSession {
  return { kind: "admin", id: randomUUID() };
}
export function issueActorCredential(
  session: ActorSession,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyActorCredential(
  header: string | undefined,
  secret: string,
): ActorSession | null {
  if (!header?.startsWith("Session ")) return null;
  const [payload, suppliedText, extra] = header.slice(8).split(".");
  if (!payload || !suppliedText || extra !== undefined) return null;
  const supplied = Buffer.from(suppliedText, "base64url");
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.kind === "admin" &&
      typeof value.id === "string" &&
      value.id.length > 0
    )
      return { kind: "admin", id: value.id };
    if (
      value.kind === "binding" &&
      typeof value.id === "string" &&
      value.id.length > 0 &&
      Number.isSafeInteger(value.generation) &&
      (value.generation as number) > 0
    )
      return {
        kind: "binding",
        id: value.id,
        generation: value.generation as number,
      };
  } catch {
    /* invalid payload */
  }
  return null;
}
