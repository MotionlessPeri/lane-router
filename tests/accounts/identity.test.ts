import { expect, test } from "vitest";
import { identityFromToken, sameIdentity, publicIdentity } from "../../src/accounts/identity.js";

const token = (workspace = "workspace-a", user = "user-a") => `e30.${Buffer.from(JSON.stringify({ email: "person@example.invalid", exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: workspace, chatgpt_user_id: user, chatgpt_plan_type: "plus" } })).toString("base64url")}.fixture`;
test("identity uses stable user and workspace, never email alone", () => {
  const a = identityFromToken(token());
  expect(sameIdentity(a, identityFromToken(token("workspace-b")))).toBe(false);
  expect(sameIdentity(a, identityFromToken(token("workspace-a", "user-b")))).toBe(false);
  expect(publicIdentity(a)).toMatchObject({ email: "p***@example.invalid", plan: "plus" });
  expect(JSON.stringify(publicIdentity(a))).not.toContain("user-a");
});
test("invalid token errors never echo credentials; incomplete identity fails closed", () => {
  expect(() => identityFromToken("secret-do-not-echo")).toThrow("INVALID_IDENTITY");
  expect(() => identityFromToken("e30.e30.fixture")).toThrow("INVALID_IDENTITY");
});
