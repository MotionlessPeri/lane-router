# Dashboard HTTP Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有后台 HTTP 处理与共用 JSON 读写移出 `LocalRouterServer`，并用契约测试固定现有行为和工具支持范围。

**Architecture:** `LocalRouterServer` 继续持有服务和 channel 生命周期、机器 RPC、CLI 与 Host 入口。每个服务实例创建一个 `DashboardHttp`，注入实时 Router 信息、origin、该实例生成的 action token 和原有可选业务回调。`http-json.ts` 原样承接 JSON 读写；异常仍由各入口原有边界处理。

**Tech Stack:** TypeScript、Node HTTP、Vitest、Zod；不新增依赖。

---

## 执行边界与基线

设计依据：[后台 HTTP 边界整理设计](../specs/2026-10-17-dashboard-http-boundary-design.md)。设计与实现已获授权，本计划由同一个实现 agent 内联执行；独立子 agent 仅审查文档和最终代码，不重复申请执行方式或例行 checkpoint 审批。

- 起点：`20bdc4c07fea5b3232194b6ff1f4235e89902804`，代码基线为 `087d2a79b8d3d6d841d3cd34acccc403dc05138f`。
- 工作树：`C:/Users/KrabsXD/.config/superpowers/worktrees/lane-router/dashboard-http-boundary-20261017`。
- 分支：`refactor/dashboard-http-boundary-20261017`。
- 主工作树初始状态仅有用户已有的 `dist-before-20261009-standalone/`；隔离工作树初始状态干净。
- 所有命令均在隔离工作树运行。测试只用 fake server、内存数据库与临时 fixture；不得操作真实库、Router 或 lane，不运行实际模型，不部署、不推送、不合并。
- 纯重构先增加在旧实现上通过的行为测试，不伪造缺陷修复的 red-green。

## 文件职责

| 文件 | 变动与职责 |
|---|---|
| `src/process/dashboard-http.ts` | 新增，承接四条后台路由、页面读取、网页操作和请求形状校验、`DashboardLaneSetsInput` |
| `src/process/http-json.ts` | 新增，原样导出 `readJson` 和 `json`，不包含权限或身份策略 |
| `src/process/local-server.ts` | 创建实例处理器并在原有总入口委托；保留旧类型路径转导出；仅删除已迁移代码及其失效 import |
| `tests/process/dashboard-http-contract.test.ts` | 新增，通过真实的隔离 `LocalRouterServer` 固定路径、校验顺序、token、错误和 JSON 边界 |
| `tests/process/dashboard-http.test.ts` | 新增，只固定新处理器未匹配请求不读 body、不调用回调的委托契约 |
| `tests/tools/tool-entry-contract.test.ts` | 新增，固定 Codex/MCP 的工具名称、说明和参数语义 |
| `tests/process/dsh-host-api.test.ts` | 增补四项允许能力和其他方法拒绝的实际 HTTP 契约 |
| `tests/process/native-host-service.test.ts` | 增补 Company Host 拒绝共享工具等未开放方法、且无业务副作用的契约 |
| `docs/README.md`、本计划、设计文档 | 注册计划，记录整理后的内部职责与现有能力范围；不改产品接口 |

## Task 1: 建立可复核的旧行为基线

**Files:** `tests/process/dashboard-http-contract.test.ts`、`tests/tools/tool-entry-contract.test.ts`、`tests/process/dsh-host-api.test.ts`、`tests/process/native-host-service.test.ts`。

- [x] **Step 1: 运行未修改实现的完整测试和 typecheck。**

```powershell
npm test -- --reporter=dot
npm run typecheck
```

预期：全部现有测试通过，类型检查无诊断。记录实际数量；若失败先定位是否环境或既有问题，不掩盖。

- [x] **Step 2: 增补后台集成行为测试。**

复用 `tests/process/dashboard-endpoints.test.ts` 的 fake tools 与 Codex endpoint 模式。新增测试逐项断言以下矩阵，并断言失败分支不调用业务回调：

| 输入或状态 | 现有输出 |
|---|---|
| 两个 GET 带 `?probe=1` | 与无 query 相同的 HTML 或状态；快照收到监听中的 pid、port、instanceId |
| POST 带 query、错误 method、未知路径 | 404 `{ error: "not found" }` |
| 未接线的 open 或 lane-sets，且请求缺少保护字段 | 先 404；不解析 body |
| 只读状态 | 不额外注入 action token |
| 仅 open、仅 lane-sets、两者均有 | 状态注入 token；同实例稳定、不同实例不同 |
| 错误 origin、action header、content type、token | 依次 403、403、400、403，保留原错误文本 |
| 多项保护同时错误、且 JSON 损坏 | 按 origin、action、content type 的顺序先拒绝，避免读 body |
| 合法保护但 JSON 损坏 | 总入口原有 400，错误包含 JSON 解析信息 |
| 原始 UTF-8 JSON 正好 1 MiB / 超过 1 MiB | 边界内由原业务回调处理；超限 400 `request too large` |
| open 的无效 addresses、override 类型或字段 | 400，保留原错误文本 |
| open 的字符串 override | 原样传给回调，成功响应不额外包装 |
| open 回调拒绝、lane-sets 回调拒绝 | 分别 400、409，保留 Error.message 和非 Error fallback |

- [x] **Step 3: 固定工具入口支持范围。**

Codex 与 MCP 导出均严格断言名称序列为 `lane_directory`、`lane_attach_current`、`lane_send`、`lane_ack`、`lane_restore_project`；逐工具核对共享说明与参数名、必填字段、string/array/enum 语义、`additionalProperties: false`，不要求 JSON Schema 方言标记一致。参数验证使用现有 `toolArgsSchemas` 和 MCP `parseLaneToolArguments`，验证 trim、可选字段、非空列表及拒绝身份字段。

DSH 实际 HTTP 请求验证四项允许工具调用和 Host 注入的 context，拒绝 `lane_restore_project`、`external_lane_read`、`lane_handoff` 等未开放方法且不调用 tools。Company fixture 注册后拒绝五个共享工具名称及未知 external 名称；复用已有 send/read/ack 测试作为允许能力证据，拒绝前后检查 tools/core.read 没有执行。

- [x] **Step 4: 在搬移前运行新增测试和受影响旧测试。**

```powershell
npx vitest run tests/process/dashboard-http-contract.test.ts tests/process/dashboard-endpoints.test.ts tests/tools/tool-entry-contract.test.ts tests/process/dsh-host-api.test.ts tests/process/native-host-service.test.ts
```

预期：旧实现下通过。若观察到旧行为与计划假设不同，先按已批准的“行为不变”要求修正测试期望并保留发现，不顺手修业务。

已取得证据：未改代码的完整基线为 59 文件、680 测试通过；`npm run typecheck` exit 0。新增契约与受影响测试命令为 5 文件、64 测试通过。计划经独立只读审查，结论为 Approved，无阻断项。

## Task 2: 原样提取 JSON 与后台 HTTP

**Files:** `src/process/http-json.ts`、`src/process/dashboard-http.ts`、`src/process/local-server.ts`、`tests/process/dashboard-http.test.ts`。

- [ ] **Step 1: 提取原有 JSON 实现。**

`http-json.ts` 导出以下原实现；不得调整限制、字符串解码、响应 header 或序列化：

```typescript
export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
```

- [ ] **Step 2: 提取后台处理器。**

创建 `DashboardHttp`，构造参数为 `router: () => DashboardRouter`、`origin: () => string`、`actionToken: string` 与原有三个可选后台回调（名称、可选性与参数形状沿用原代码）。`handle(request, response): Promise<boolean>` 只在四条方法/URL 匹配时接管并返回 true，未匹配返回 false。GET 仍须 `request.url !== undefined` 并按 `URL.pathname` 匹配；POST 仍按原始 `request.url` 精确匹配。未接线直接返回原 404。

原样移动 page read、`readDashboardAction`、`parseLaneSetsInput` 和 `DashboardLaneSetsInput`。维持四道校验顺序与每个回调的 catch 状态；不要在处理器增加总 catch，解析异常继续流向 `LocalRouterServer.handle` 的旧 400 边界。页面继续相对同目录 `dashboard.html` 读取。

- [ ] **Step 3: 接回总入口。**

在构造函数初始化一次 `DashboardHttp`，将实时 discovery 包成只返回 `{ pid, port, instanceId }` 的 callback，origin callback 返回实时 discovery.url；传入已有服务实例 token。总入口仍先处理 DSH/native Host 与 health，在普通路由段委托 `if (await this.dashboard.handle(request, response)) return;`。删除四条旧分支和已迁走 helper。保留原构造 options 和：

```typescript
import { DashboardHttp, type DashboardLaneSetsInput } from "./dashboard-http.js";
export type { DashboardLaneSetsInput } from "./dashboard-http.js";
```

- [ ] **Step 4: 测未匹配契约并复验。**

处理器单测用未匹配的 method/query/path 请求和一个一旦迭代便失败的 body，断言返回 false、response 和业务回调均未调用。集成测试继续经 `LocalRouterServer` 验证接线，不依赖私有字段。

```powershell
npx vitest run tests/process/dashboard-http.test.ts tests/process/dashboard-http-contract.test.ts tests/process/dashboard-endpoints.test.ts tests/process/dashboard-render.test.ts tests/process/tell-guard.test.ts tests/process/local-transport.test.ts
npm run typecheck
```

预期：全部通过，原 `DashboardLaneSetsInput` 导入仍编译。

## Task 3: 整体验证、审查与提交

**Files:** `docs/README.md`、设计文档与本计划；审查修正仅限已批准行为。

- [ ] **Step 1: 同步文档。** 在索引注册计划；将设计状态改为已实现并链接计划。支持范围沿用设计已有清单，不新增运行时注册/权限配置。检查 diff，确认没有 tools、adapters、Router 业务、Host/channel 或 HTML 内容改动。
- [ ] **Step 2: 运行完整回归与隔离构建。**

```powershell
npm test -- --reporter=dot
npm run typecheck
npm run build
git diff --check
```

预期：完整测试通过、typecheck 无诊断、build exit 0，隔离 `dist/process/dashboard.html` 与源码字节一致，且 `dist/process/dashboard-http.js`、`dist/process/http-json.js` 同时存在。用临时 fake `LocalRouterServer` 从隔离构建导入，GET `/dashboard` 返回相同自包含页面；不连接真实 Router 或模型。

- [ ] **Step 3: 独立审查。** 按 `superpowers:requesting-code-review` 请求一个有限时 reviewer 核对 spec、总 diff、测试与范围。先按批准验收项分类发现；修复计划内缺陷后复验相关检查。按 `conversation-walkthrough` 复核职责、错误边界与注释。不实现额外加固或协议改动。
- [ ] **Step 4: 任务自有本地提交。** 按 `superpowers:verification-before-completion` 核实最新结果、只 stage 本任务明确路径并检查 staged diff；计划与测试可在稳定基线后先提交，结构迁移与最后证据在通过验证后提交。保留工作树供主对话汇合，不合并、不删除、不 push。
- [ ] **Step 5: 交付。** 返回 commit、工作树、文件职责和范围差异、原始验证命令和实际计数、审查结论及未验证的真实场景。
