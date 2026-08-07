import { describe, expect, it } from "vitest";

import { mailboxLanePath, parseLaneAddress } from "../../src/router/address.js";

describe("lane address", () => {
  it("keeps a valid two-segment address and exposes its project", () => {
    expect(parseLaneAddress("lane-router/design")).toEqual({
      address: "lane-router/design",
      project: "lane-router",
      lane: "design",
    });
  });

  it.each(["", "project", "/lane", "project/", "a/b/c", " a/b", "a\\b"]) (
    "rejects invalid address %j",
    (address) => expect(() => parseLaneAddress(address)).toThrow(/lane address/i),
  );

  it("encodes address segments without changing the logical address", () => {
    expect(mailboxLanePath("C:/state", parseLaneAddress("project%20/design.notes")))
      .toBe("C:\\state\\mailboxes\\project%2520\\design.notes");
  });
});
