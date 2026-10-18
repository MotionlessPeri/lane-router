import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CodexStdioClient, managedEnvironment } from "../../src/accounts/stdio-client.js";

const roots: string[] = []; const clients: CodexStdioClient[] = [];
vi.setConfig({ testTimeout: 20_000 });
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function connect() {
  const home = await mkdtemp(join(tmpdir(), "router-stdio-")); roots.push(home);
  const client = await CodexStdioClient.connect({ executable: "fixture", home, requestTimeoutMs: 5_000,
    spawnProcess(command, args, options) {
      expect(command).toBe("fixture");
      expect(args).toContain('cli_auth_credentials_store="keyring"');
      expect(options.windowsHide).toBe(true);
      expect(options.stdio).toEqual(["pipe", "pipe", "ignore"]);
      expect(options.cwd).toBe(home);
      return spawn(process.execPath, ["-e", `
        require('readline').createInterface({ input: process.stdin }).on('line', line => {
          const message = JSON.parse(line);
          if (!message.id) return;
          if (message.method === 'hang') return;
          if (message.method === 'exit') process.exit(1);
          if (message.method === 'malformed') { process.stdout.write('sensitive-invalid-protocol\\n'); return; }
          if (message.method === 'fail') { process.stdout.write(JSON.stringify({id:message.id,error:{message:'secret-rpc-body'}})+'\\n'); return; }
          if (message.method === 'notify') process.stdout.write(JSON.stringify({method:'account/login/completed',params:{loginId:'fixture',success:true}})+'\\n');
          process.stdout.write(JSON.stringify({id:message.id,result:{ok:true}})+'\\n');
        });
      `], options);
    },
  }); clients.push(client); return client;
}

test("managed environment excludes inherited auth and config overrides", () => {
  const environment = managedEnvironment(join(tmpdir(), "owned-home"), { Path: "fixture-path", SystemRoot: "C:\\Windows", TEMP: tmpdir(), OPENAI_API_KEY: "secret", CODEX_HOME: "wrong", CODEX_CONFIG: "unsafe", NODE_OPTIONS: "unsafe", HTTPS_PROXY: "unsafe", USERPROFILE: "parent-home" });
  expect(environment.CODEX_HOME).toBe(join(tmpdir(), "owned-home"));
  expect(environment.Path).toBe("fixture-path");
  expect(environment.USERPROFILE).toBe(join(tmpdir(), "owned-home"));
  expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(environment).not.toHaveProperty("CODEX_CONFIG");
  expect(environment).not.toHaveProperty("NODE_OPTIONS");
  expect(environment).not.toHaveProperty("HTTPS_PROXY");
});

test("stdio routes results and notifications without exposing RPC error text", async () => {
  const client = await connect(); const notifications: unknown[] = [];
  client.onNotification(message => notifications.push(message));
  await expect(client.request("notify", {})).resolves.toEqual({ ok: true });
  expect(notifications).toEqual([{ method: "account/login/completed", params: { loginId: "fixture", success: true } }]);
  await expect(client.request("fail", {})).rejects.toThrow(/^RUNTIME_UNAVAILABLE$/);
});

test.each(["hang", "exit", "malformed"])("stdio %s rejects pending requests with a safe code", async method => {
  const client = await connect();
  await expect(client.request(method, {})).rejects.toThrow(/^RUNTIME_UNAVAILABLE$/);
  await client.close();
  await expect(client.request("after-close", {})).rejects.toThrow(/^RUNTIME_UNAVAILABLE$/);
});

test("a timed-out RPC retires its owner so later refreshes cannot overlap abandoned work", async () => {
  const client = await connect(); let closed = false;
  client.onClose(() => { closed = true; });
  await expect(client.request("hang", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
  await expect.poll(() => closed).toBe(true);
  await expect(client.request("notify", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
});

test("closing the owned child rejects pending requests and notifies once", async () => {
  const client = await connect(); let closes = 0;
  client.onClose(() => { closes++; });
  const pending = expect(client.request("hang", {})).rejects.toThrow("RUNTIME_UNAVAILABLE");
  await client.close(); await pending;
  expect(closes).toBe(1);
});
