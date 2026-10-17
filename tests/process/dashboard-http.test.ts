import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";

import { DashboardHttp } from "../../src/process/dashboard-http.js";

test.each([
  ["GET", "/other"], ["POST", "/dashboard"], ["POST", "/dashboard/state"],
  ["GET", "/dashboard/lanes/open"], ["POST", "/dashboard/lanes/open?probe=1"],
  ["POST", "/dashboard/lane-sets?probe=1"], ["OPTIONS", "/dashboard/lane-sets"], ["GET", undefined],
])("unmatched %s %s does not consume the request or call any dependency", async (method, url) => {
  const body = vi.fn(() => { throw new Error("unmatched body consumed"); });
  const request = { method, url, headers: {}, [Symbol.asyncIterator]: body } as unknown as IncomingMessage;
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const options = {
    router: vi.fn(), origin: vi.fn(), actionToken: "token",
    dashboardState: vi.fn(), dashboardOpen: vi.fn(), dashboardLaneSets: vi.fn(),
  };
  const handler = new DashboardHttp(options);
  expect(await handler.handle(request, response as unknown as ServerResponse)).toBe(false);
  expect(body).not.toHaveBeenCalled();
  expect(response.writeHead).not.toHaveBeenCalled();
  expect(response.end).not.toHaveBeenCalled();
  for (const dependency of [options.router, options.origin, options.dashboardState, options.dashboardOpen, options.dashboardLaneSets]) {
    expect(dependency).not.toHaveBeenCalled();
  }
});
