import { randomUUID } from "node:crypto";

import type { ZcodeDriver } from "../adapters/zcode/driver/driver.js";
import type { CallerContext } from "../router/types.js";
import type { LaneToolName } from "../tools/tool-contract.js";

export interface HeadlessZcodeSpawnInput {
  readonly address: string;
  readonly role: string;
  readonly cwd: string;
  readonly model?: string;
  /**
   * First turn of the new conversation. A headless session cannot be handed a bootstrap prompt by
   * a window (there is no window), so an intro — when one is wanted, e.g. a TUI lane whose window
   * will resume this session — travels as the session's first driven turn.
   */
  readonly intro?: string;
  /** Windowed lanes set this: open the TUI only after the intro turn has settled. */
  readonly waitForIntro?: boolean;
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
  if (options.input.intro !== undefined && options.input.intro.trim().length > 0) {
    // Fire-and-forget in the same sense mail is: the turn belongs to the session, and a headless
    // caller waiting for it would make spawn latency depend on a model. The windowed form opts in
    // (waitForIntro): a TUI that opens on a still-running intro renders the question without the
    // answer — the user lands in a conversation that looks stuck until they poke it — because a
    // window does not live-render turns driven by the Router's engine.
    const sent = options.driver.send(sessionId, options.input.intro).catch(() => undefined);
    if (options.input.waitForIntro === true) {
      await Promise.race([
        sent.then(() => options.driver.waitUntilIdle(sessionId, AbortSignal.timeout(90_000))).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 95_000).unref?.()),
      ]);
    }
  }
  return { sessionId, address: options.input.address };
}
