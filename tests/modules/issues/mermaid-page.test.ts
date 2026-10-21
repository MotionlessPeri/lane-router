import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

/**
 * Spec 2026-10-21-issue-page-usability.md, batch two, acceptance 2: a lane's mermaid blocks are drawn,
 * the library is fetched once and only when needed, and what cannot be drawn stays as code with the
 * reason. The page runs in happy-dom against the real issues HTTP service; the library is a stand-in
 * the test puts on the window, and happy-dom fetches no script.
 */
const page = readFileSync(new URL("../../../src/ui/issues/index.html", import.meta.url), "utf8");
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const fence = (info: string, source: string) => ["```" + info, source, "```"].join("\n");
const LANE_BODY = ["两张图：", "", fence("mermaid", "graph TD; A-->B"), "", fence(" Mermaid ", "graph LR; C-->D"), "", fence("js", "const x = 1;")].join("\n");
const USER_BODY = fence("mermaid", "graph TD; X-->Y");

async function open(options: { body?: string; loads?: boolean; fails?: (source: string) => string | null } = {}) {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const issue = x.service.publish(x.caller, { operationKey: "diagrams", title: "图", kind: "question", body: options.body ?? LANE_BODY });
  x.service.reply({ operationKey: "user", issueId: issue.issueId, body: USER_BODY });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: randomUUID(), issues: { service: x.service } });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const window = new Window({ url: `${url}/issues`, settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: options.loads ?? true } });
  cleanup.push(() => window.happyDOM.abort());
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const errors: unknown[] = [];
  window.addEventListener("error", event => errors.push((event as ErrorEvent).error));
  const rendered: string[] = [];
  const mermaid = {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, source: string) => {
      const failure = options.fails?.(source);
      if (failure) throw new Error(failure);
      rendered.push(source);
      return { svg: `<svg id="${id}" viewBox="0 0 120 60"><text>${source.length}</text></svg>` };
    }),
  };
  Object.defineProperty(window, "mermaid", { configurable: true, writable: true, value: mermaid });
  window.document.write(page);
  for (const asset of window.document.querySelectorAll("script[src]")) {
    new Function("globalThis", "module", "exports", await (await fetch(new URL(asset.getAttribute("src")!, url))).text())(window, undefined, undefined);
  }
  const browserFetch = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
  new Function("document", "fetch", "setInterval", "crypto", "setTimeout", "clearTimeout", window.document.querySelector("script:not([src])")!.textContent!)(
    window.document, browserFetch, () => 0, { randomUUID }, () => 0, () => undefined,
  );
  const query = (selector: string) => window.document.querySelector(selector) as any;
  const all = (selector: string) => [...window.document.querySelectorAll(selector)] as any[];
  await vi.waitFor(() => expect(query(`#thread-list [data-issue-id="${issue.issueId}"]`)).not.toBeNull());
  query(`#thread-list [data-issue-id="${issue.issueId}"]`).click();
  await vi.waitFor(() => expect(query("#issue-detail").getAttribute("data-issue-id")).toBe(issue.issueId));
  const scripts = () => all('script[src="/issues/assets/mermaid.js"]').length;
  return { window, query, all, mermaid, rendered, scripts, errors };
}

test("2: a lane's mermaid blocks are drawn, the library fetched once and set to strict; other code and the user's words stay text", async () => {
  const p = await open();
  await vi.waitFor(() => expect(p.all('article[data-entry-seq="1"] .mermaid-diagram svg')).toHaveLength(2));
  expect(p.scripts()).toBe(1);
  expect(p.mermaid.initialize).toHaveBeenCalledTimes(1);
  expect(p.mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: "strict", theme: expect.stringMatching(/^(default|dark)$/u) });
  expect(p.rendered).toEqual(["graph TD; A-->B", "graph LR; C-->D"]);
  // Each diagram keeps its source under it, folded, with the copy button code blocks have.
  for (const diagram of p.all('article[data-entry-seq="1"] .mermaid-diagram')) {
    const details = diagram.nextElementSibling;
    expect(details.tagName).toBe("DETAILS");
    expect(details.querySelector("summary").textContent).toBe("源码");
    expect(details.querySelector("pre code").hasAttribute("data-mermaid")).toBe(true);
    expect(details.querySelector("pre .copy-code")).not.toBeNull();
  }
  expect(p.query('article[data-entry-seq="1"] code.language-js').closest(".mermaid-source, .mermaid-diagram")).toBeNull();
  expect(p.all('article[data-entry-seq="2"] .mermaid-diagram')).toHaveLength(0);
  expect(p.query('article[data-entry-seq="2"] .entry-body').textContent).toContain("```mermaid");
  expect(p.errors).toEqual([]);
});

test("2: a page with no diagram never fetches the library", async () => {
  const p = await open({ body: fence("js", "const x = 1;") });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(p.scripts()).toBe(0);
  expect(p.mermaid.initialize).not.toHaveBeenCalled();
});

test("2: a block the library cannot draw stays as code, under a line saying why; the others are drawn", async () => {
  const p = await open({ fails: source => source.includes("C-->D") ? "Parse error on line 1" : null });
  await vi.waitFor(() => expect(p.all(".mermaid-error")).toHaveLength(1));
  expect(p.query(".mermaid-error").textContent).toBe("图没画出来：Parse error on line 1");
  expect(p.query(".mermaid-error").nextElementSibling.tagName).toBe("PRE");
  expect(p.query(".mermaid-error").nextElementSibling.textContent).toContain("graph LR; C-->D");
  expect(p.all(".mermaid-diagram")).toHaveLength(1);
  expect(p.errors).toEqual([]);
});

test("2: when the library does not load, every block stays as code, under a line saying so", async () => {
  const p = await open({ loads: false });
  await vi.waitFor(() => expect(p.all(".mermaid-error")).toHaveLength(2));
  expect(p.all(".mermaid-error").map(line => line.textContent)).toEqual(["图没画出来：图表组件没能加载", "图没画出来：图表组件没能加载"]);
  expect(p.all(".mermaid-diagram")).toHaveLength(0);
  expect(p.mermaid.render).not.toHaveBeenCalled();
  expect(p.errors).toEqual([]);
});

test("2: a poll leaves drawn diagrams as they are", async () => {
  const p = await open();
  await vi.waitFor(() => expect(p.all(".mermaid-diagram")).toHaveLength(2));
  const before = p.all(".mermaid-diagram");
  p.query("#refresh").click();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(p.mermaid.render).toHaveBeenCalledTimes(2);
  expect(p.all(".mermaid-diagram")).toEqual(before);
  expect(p.scripts()).toBe(1);
});
