#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeLock } from "../process/runtime-lock.js";
import { AccountError, safeError } from "./contracts.js";
import { AccountHttpServer } from "./http-server.js";
import { ManagedAccounts } from "./managed-login.js";
import { atomicPrivateJson, ensurePrivateDirectory } from "./private-storage.js";
import { AccountSwitchService } from "./switch-service.js";

export async function startAccountService(options: { root: string; executable: string; port?: number }) {
  const root = resolve(options.root);
  await ensurePrivateDirectory(root);
  const lock = RuntimeLock.acquire(join(root, "service.lock"));
  if (!lock) throw new AccountError("SERVICE_ALREADY_RUNNING");
  const accounts = new ManagedAccounts({ root, executable: options.executable });
  let http: AccountHttpServer | undefined;
  const connectionFile = join(root, "connection.json");
  try {
    await accounts.initialize();
    const service = new AccountSwitchService({ source: accounts, expected: ["router", "company"], desired: accounts.desiredProfileId, saveDesired: id => accounts.saveDesired(id) });
    const token = randomBytes(32).toString("base64url");
    http = new AccountHttpServer({ accounts, service, token });
    const url = await http.start(options.port ?? 47839);
    await atomicPrivateJson(connectionFile, { version: 1, url: url.replace("http:", "ws:") + "/consumer", token });
    let closed = false;
    return {
      url, connectionFile,
      async close() {
        if (closed) return; closed = true;
        try { await http!.close(); await accounts.close(); await unlink(connectionFile).catch(() => {}); }
        finally { lock.release(); }
      },
    };
  } catch (error) {
    await http?.close().catch(() => {}); await accounts.close().catch(() => {}); lock.release();
    throw error;
  }
}

function argumentsForCli(args: string[]) {
  let root = join(homedir(), ".lane-router-accounts");
  let executable = process.env.CODEX_EXE ?? "codex";
  let port = 47839;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!value) throw new AccountError("INVALID_REQUEST");
    if (key === "--root") root = resolve(value);
    else if (key === "--codex-exe") executable = value;
    else if (key === "--port" && /^\d+$/.test(value) && Number(value) <= 65535) port = Number(value);
    else throw new AccountError("INVALID_REQUEST");
  }
  return { root, executable, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("lane-router-accounts [--root <private-directory>] [--codex-exe <codex.exe>] [--port <number>]\n");
  } else {
    void startAccountService(argumentsForCli(process.argv.slice(2))).then(service => {
      process.stdout.write(`账号页：${service.url}\n`);
      let closing = false;
      const close = () => { if (!closing) { closing = true; void service.close().catch(() => { process.exitCode = 1; }); } };
      process.once("SIGINT", close); process.once("SIGTERM", close);
    }).catch(error => { process.stderr.write(`账号后台启动失败：${safeError(error)}\n`); process.exitCode = 1; });
  }
}
