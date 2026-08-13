import { expect, test, vi } from "vitest";

import { runProjectRestoreCli } from "../../src/process/project-restore-cli.js";

function setup(threadId: string | null = "thread-main") {
  const call = vi.fn(async () => ({ project: "alpha", results: [] }));
  const write = vi.fn();
  const runtime = runProjectRestoreCli;
  return {
    call, write, runtime,
    dependencies: {
      threadId: () => threadId ?? undefined,
      cwd: () => "D:\\project",
      newRequestKey: () => "request-1",
      ensure: vi.fn(async () => ({ url: "http://127.0.0.1:1" })),
      createClient: vi.fn(() => ({ call })),
      write,
    },
  };
}

test("restores all peers for the current Codex thread and prints JSON", async () => {
  const x = setup();
  await expect(x.runtime([], x.dependencies as never)).resolves.toBe(0);
  expect(x.call).toHaveBeenCalledWith("lane_restore_project", {}, {
    backend: "codex", conversationId: "thread-main", cwd: "D:\\project", requestKey: "cli:request-1",
  });
  expect(x.write).toHaveBeenCalledWith(`${JSON.stringify({ project: "alpha", results: [] }, null, 2)}\n`);
});

test("passes positional lane addresses as the optional subset", async () => {
  const x = setup();
  await x.runtime(["alpha/a", "alpha/b"], x.dependencies as never);
  expect(x.call).toHaveBeenCalledWith("lane_restore_project", { lanes: ["alpha/a", "alpha/b"] }, expect.any(Object));
});

test("rejects a shell without CODEX_THREAD_ID before ensuring the Router", async () => {
  const x = setup(null);
  await expect(x.runtime([], x.dependencies as never)).rejects.toThrow(/CODEX_THREAD_ID/u);
  expect(x.dependencies.ensure).not.toHaveBeenCalled();
  expect(x.call).not.toHaveBeenCalled();
});

test("propagates Router errors and does not print a false result", async () => {
  const x = setup();
  x.call.mockRejectedValueOnce(new Error("The current conversation is not attached to a lane"));
  await expect(x.runtime([], x.dependencies as never)).rejects.toThrow(/not attached/iu);
  expect(x.write).not.toHaveBeenCalled();
});

test("gives the client a resolver that can follow a replacement Router", async () => {
  const x = setup();
  x.dependencies.ensure
    .mockResolvedValueOnce({ url: "http://127.0.0.1:1" })
    .mockResolvedValueOnce({ url: "http://127.0.0.1:2" });
  x.dependencies.createClient.mockImplementation((resolveUrl: () => Promise<string>) => ({
    call: async () => ({ urls: [await resolveUrl(), await resolveUrl()] }),
  }));

  await x.runtime([], x.dependencies as never);

  expect(x.write).toHaveBeenCalledWith(`${JSON.stringify({ urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"] }, null, 2)}\n`);
});
