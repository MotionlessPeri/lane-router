import { describe, expect, it } from "vitest";

import { isSenderLabel, mailboxLanePath, parseLaneAddress, senderLabel } from "../../src/router/address.js";

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

describe("sender labels", () => {
  // A message sent from outside every lane names its sender `user:<origin>`. Readers tell it from a
  // lane by shape alone — an address always has a slash, a label never does — so the two sets must
  // not overlap in either direction, or a label could be mistaken for a lane and the reverse.
  it("builds a label from an origin and recognises only that shape", () => {
    expect(senderLabel("vikunja")).toBe("user:vikunja");
    expect(isSenderLabel("user:vikunja")).toBe(true);
    expect(isSenderLabel("user:task-37")).toBe(true);
    for (const address of ["alpha/design", "user/vikunja", "user:x/y"]) expect(isSenderLabel(address)).toBe(false);
    expect(() => parseLaneAddress("user:vikunja")).toThrow(/Invalid lane address/u);
  });

  // The origin is the only part of the header a caller chooses, so it is held to an identifier:
  // anything wider is a way to write something other than an origin into the sender line.
  it("refuses an origin that is not a short lowercase identifier", () => {
    for (const origin of ["", "Vikunja", "a/b", "a b", "x\nsender: alpha/a", "a".repeat(33), "user:x"]) {
      expect(() => senderLabel(origin), JSON.stringify(origin)).toThrow(/origin/iu);
    }
    expect(senderLabel("a".repeat(32))).toBe(`user:${"a".repeat(32)}`);
    for (const label of ["user:", "user:Vikunja", `user:${"a".repeat(33)}`, "user:a b"]) expect(isSenderLabel(label)).toBe(false);
  });
});