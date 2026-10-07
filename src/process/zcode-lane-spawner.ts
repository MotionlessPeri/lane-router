import { randomUUID } from "node:crypto";

import type { ZcodeDriver } from "../adapters/zcode/driver/driver.js";
import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "../tools/tool-contract.js";

export interface HeadlessZcodeSpawnInput {
  readonly address: string;
  readonly role: string;
  readonly cwd: string;
  readonly model?: string;
}

/**
 * Creates a headless zcode lane in the Router process: one driver session (the conversation), one
 * attach through the ordinary ToolService path (the binding). The attach travels the same
 * `lane_attach_current` every other backend uses, so a driven lane differs from an interactive one
 * in transport only — not in how its binding, backlog or attention opportunities behave.
 *
 * There is no terminal window to open and none is missed: a headless lane's "window" is the
 * Router-owned app-server session itself, and its turns start when mail arrives, not when a human
 * looks at it.
 */
export async function spawnHeadlessZcodeLane(options: {
  readonly driver: ZcodeDriver;
  readonly callTool: (name: LaneToolName, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>;
  readonly input: HeadlessZcodeSpawnInput;
  readonly newRequestKey?: () => string;
}): Promise<{ readonly sessionId: string; readonly address: string }> {
  const { sessionId } = await options.driver.createSession({
    workspacePath: options.input.cwd,
    workspaceKey: options.input.cwd,
    mode: "yolo",
  });
  try {
    await options.callTool("lane_attach_current", {
      address: options.input.address,
      role_description: options.input.role,
      ...(options.input.model === undefined ? {} : { model: options.input.model }),
    }, {
      backend: "zcode",
      conversationId: sessionId,
      cwd: options.input.cwd,
      requestKey: `zcode-spawn:${(options.newRequestKey ?? randomUUID)()}`,
    });
  } catch (error) {
    // A session created for a lane that then failed to attach is a running conversation bound to
    // nothing; stopping it keeps the spawn verb all-or-nothing.
    await options.driver.stop(sessionId).catch(() => undefined);
    throw error;
  }
  return { sessionId, address: options.input.address };
}
