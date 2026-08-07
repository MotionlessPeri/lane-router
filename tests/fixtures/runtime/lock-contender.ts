import {
  acquireRuntimeLock,
  BrokerAlreadyRunningError,
  type BrokerRuntimeLock,
} from "../../../src/broker/runtime.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const locks = new Map<string, BrokerRuntimeLock>();
process.on(
  "message",
  async (message: {
    id: string;
    command: "acquire" | "release" | "crash_marker";
    dataDir: string;
    instanceId: string;
  }) => {
    try {
      if (message.command === "crash_marker") {
        const owner = {
          pid: process.pid,
          instanceId: message.instanceId,
          processStart: `child:${process.pid}`,
          createdAt: Date.now(),
          heartbeatAt: Date.now(),
        };
        await writeFile(
          join(message.dataDir, "broker.lock"),
          JSON.stringify({ ...owner, instanceId: "stale-lock" }),
        );
        await writeFile(
          join(message.dataDir, "broker.lock.reclaim"),
          JSON.stringify(owner),
        );
        process.send?.({ id: message.id, result: "marker_written" });
        setImmediate(() => process.exit(0));
      } else if (message.command === "acquire") {
        const lock = await acquireRuntimeLock(message.dataDir, {
          instanceId: message.instanceId,
        });
        locks.set(message.id, lock);
        process.send?.({ id: message.id, result: "won" });
      } else {
        locks.get(message.id)?.release();
        locks.delete(message.id);
        process.send?.({ id: message.id, result: "released" });
      }
    } catch (error) {
      process.send?.({
        id: message.id,
        result:
          error instanceof BrokerAlreadyRunningError ? "conflict" : "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
