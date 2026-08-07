import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
