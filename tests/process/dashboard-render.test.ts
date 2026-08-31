import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";

const pageSource = readFileSync(fileURLToPath(new URL("../../src/process/dashboard.html", import.meta.url)), "utf8");

const HOSTILE_SCRIPT = "<script>alert(1)</script>";
const HOSTILE_IMAGE = "<img src=x onerror=alert(1)>";

/**
 * Everything on this board was written by another lane or by a person. The snapshot below puts
 * markup in each of the three places the design names — body, role description, cwd — because a
 * page that escapes one of them and not the others is a page that escapes none of them.
 */
const snapshot = {
  capturedAt: 1_788_180_000_000,
  router: { pid: 1, port: 52494, instanceId: "instance-1", schemaVersion: 5 },
  lanes: [{
    address: "alpha/one", project: "alpha", roleDescription: `role ${HOSTILE_IMAGE}`, model: null, archived: false,
    binding: { backend: "claude", conversationId: "conversation-1", generation: 1, cwd: `C:/${HOSTILE_SCRIPT}`, attachedAt: 1_788_179_000_000 },
    reach: { state: "live", connectedAt: null, lastLifecycleAt: 1_788_179_500_000, lastNotifiedAt: null, believedBusy: false },
    pending: { count: 1, oldestCreatedAt: 1_788_179_000_000 },
  }],
  messages: [{
    id: "message-1", sender: "alpha/one", target: "alpha/one", kind: "normal", replyTo: null,
    createdAt: 1_788_179_000_000, state: "pending", resolvedAt: null, ackLane: null,
    notificationState: "sent", body: `${HOSTILE_SCRIPT} and ${HOSTILE_IMAGE}`,
  }],
  truncated: { messages: false, limit: 200 },
};

/**
 * The document is parsed from the shipped page and every DOM call below lands on happy-dom's own
 * implementation — which is the point, because `textContent` and `innerHTML` differing is the
 * whole property under test, and a stand-in DOM written here would be judging its own author.
 *
 * The page's script is started by hand rather than by the parser: this happy-dom (20.12.0) parses
 * inline scripts into the tree but never evaluates them — measured, with the script element
 * present, its text intact, and no console output or error event. So the script text is taken
 * from the parsed document, exactly what a browser would have run, and given the document to work
 * on. What this does not cover is the page's own loading — that is the manual case.
 */
async function render(): Promise<Window["document"]> {
  const window = new Window({ url: "http://127.0.0.1:52494/dashboard" });
  window.document.write(pageSource);
  const script = window.document.querySelector("script")?.textContent;
  expect(script, "the page must carry exactly one inline script").toBeTruthy();
  const fetchStub = async () => ({ ok: true, json: async () => snapshot });
  // No interval: one render is what is under test, and a live timer would outlive the test.
  new Function("document", "fetch", "setInterval", script!)(window.document, fetchStub, () => 0);
  await vi.waitFor(() => expect(window.document.body.textContent).toContain("alpha/one"));
  return window.document;
}

test("hostile text in a snapshot is shown, not run", async () => {
  const document = await render();

  // Visible as characters, in all three places the snapshot poisoned.
  expect(document.body.textContent).toContain(HOSTILE_SCRIPT);
  expect(document.body.textContent).toContain(HOSTILE_IMAGE);

  // The teeth: markup in the data must never have become markup in the document. `innerHTML`
  // would create both of these elements — and the img's onerror fires even though the script's
  // does not, which is why counting elements is the assertion rather than watching for alerts.
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(document.querySelectorAll("script")).toHaveLength(1);
});
