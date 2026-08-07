import {
  acquireRuntimeLock,
  BrokerAlreadyRunningError,
  type BrokerRuntimeLock,
} from "../../../src/broker/runtime.js";

const locks = new Map<string, BrokerRuntimeLock>();
process.on(
  "message",
  async (message: {
    id: string;
    command: "acquire" | "release";
    dataDir: string;
    instanceId: string;
  }) => {
    try {
      if (message.command === "acquire") {
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
