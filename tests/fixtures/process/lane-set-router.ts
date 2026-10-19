import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { LocalRouterServer } from "../../../src/process/local-server.js";
import { BackendRegistry, type PlatformBackend } from "../../../src/router/backend.js";
import { openRouterDatabase } from "../../../src/router/database.js";
import { MailboxStore } from "../../../src/router/mailbox-store.js";
import { NotificationPump } from "../../../src/router/notification-pump.js";
import { RouterCore } from "../../../src/router/router-core.js";
import { RouterStateStore } from "../../../src/router/state-store.js";
import { ToolService } from "../../../src/tools/tool-service.js";

/**
 * A real Router server over a real core and state store, for the two window CLIs that ask the
 * Router where a lane opens. `alpha/worker` is in the set `research`, `alpha/plain` is in none;
 * both are bound Claude lanes, closed, with a recorded directory, so `open` has something to open.
 * Its discovery file is written into `dataRoot`, which is how both CLIs find a Router.
 */
export async function startLaneSetRouter(dataRoot: string): Promise<{ close: () => Promise<void> }> {
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(dataRoot);
  const claude = {
    name: "claude",
    reach: () => null,
    restorePresence: () => "offline",
    onAttentionOpportunity: () => () => undefined,
  } as unknown as PlatformBackend;
  const backends = new BackendRegistry([claude]);
  const core = new RouterCore({
    state, mailbox, backends, pump: new NotificationPump(state, mailbox, backends),
    newId: (kind) => `${kind}-${Math.random()}`, now: () => 10,
  });
  for (const [index, address] of ["alpha/worker", "alpha/plain"].entries()) {
    state.createLane({ address, project: "alpha", roleDescription: address, now: 1 });
    state.createBinding({
      id: `binding-${index}`, laneAddress: address, backend: "claude",
      conversationId: `0000000${index}-0000-4000-8000-000000000000`, generation: 2, startup: {}, now: 2,
    });
    state.updateBindingCwd("claude", `0000000${index}-0000-4000-8000-000000000000`, dataRoot);
  }
  core.assignLaneSet(["alpha/worker"], core.createLaneSet("research").id);

  const server = new LocalRouterServer({
    tools: new ToolService(core),
    instanceId: "lane-sets",
    resumeInfo: (address) => core.resumeInfo(address),
  });
  const discovery = await server.start();
  writeFileSync(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
  return { close: async () => { await server.close(); database.close(); } };
}
