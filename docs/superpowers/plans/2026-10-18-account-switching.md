# 本机统一账号切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 紧密关联的接入工作由本会话执行，独立审查使用子代理。

**Goal:** 用户在独立账号页完成一次授权，可等待现有任务结束后同步 Company 和 Router Codex lane 的账号。

**Architecture:** 独立后台拥有官方 managed 登录与系统凭据库，两个运行端长期连接后台，仅接收短期令牌。运行端在模型请求接纳处建立切换门，等待空闲后应用并核实身份，网页只获得脱敏状态。

**Tech Stack:** TypeScript、Node.js HTTP、现有 `ws`、官方 Codex app-server、Windows keyring/NTFS、Vitest/happy-dom。

设计依据：[本机统一账号切换](../specs/2026-10-18-account-switching.md)。实施目录为独立 `account-switching-20261018` 工作树。基线 `bb8a726`，722 项测试通过，不在主工作树构建，不启动共享部署。

## 任务 1：账号与运行端契约、切换服务

文件：新增 `src/accounts/contracts.ts`、`identity.ts`、`switch-service.ts`；测试 `tests/accounts/switch-service.test.ts`、`identity.test.ts`。

- [x] 写失败测试：两个运行端 A 到 B；忙碌等待；取消只在应用前；并发切换拒绝；部分失败和断线不可成功；同邮箱不同工作区不合并；所有对外状态无令牌。
- [x] 执行 `npx vitest run tests/accounts/switch-service.test.ts tests/accounts/identity.test.ts`，确认测试缺少实现失败。
- [x] 定义账号公开元数据、仅内部 `AccessGrant`、`AccountSource` 和 `SwitchParticipant`。`AccessGrant` 包含 `accessToken` 与结构化 `identity(userId/accountId/email/plan)`，不包含 refresh token。`SwitchParticipant` 提供 `prepare(operationId)`、`apply(operationId, grant)`、`release(operationId)`、`readIdentity()`；执行顺序为目标验证、所有 prepare、持久化期望、各 apply/核对、release。公开结果单独构造，禁止展开内部对象。
- [x] 实现单操作状态机和重连恢复；失败只记录固定码及参与端 ID。重复刷新按 profile 合并，并验证用户与工作区等于绑定身份。
- [x] 复跑上述测试，记录绿灯。

## 任务 2：官方登录拥有者及安全存储

文件：新增 `src/accounts/managed-login.ts`、`private-storage.ts`、`stdio-client.ts`；测试 `tests/accounts/managed-login.test.ts`、`private-storage.test.ts`。

- [x] 写失败测试：每 profile 独立 home，强制 keyring，官方登录 URL 校验并只交浏览器，取消/超时/子进程退出清理，串行刷新，元数据原子写，权限设置失败即停止。
- [x] 运行相关测试，确认失败原因正确。
- [x] 复用现有进程管理思路，实现仅用于后台拥有的 stdio JSON-RPC 客户端；不记录 stderr/协议内容。以明确的 `CODEX_HOME` 和 keyring 配置启动，移除可覆盖认证的 API key 环境变量。通过 `getAuthStatus(includeToken=true,refreshToken=true)` 获取短期令牌，解析官方响应内的用户/工作区身份；不读取 auth.json。
- [x] 建立专属目录与单实例锁；账号元数据、期望账号和连接随机凭据写仓库外，不保存令牌。重复身份用新授权替换同一 profile 的来源并关闭旧拥有者，不能同时刷新。
- [x] 运行测试并用隔离合成账号验证官方 `getAuthStatus` 行为和 keyring 能力；凭据测试不输出令牌。

## 任务 3：运行端模块和 Router 接纳边界

文件：新增 `src/accounts/switch-gate.ts`、`consumer.ts`、`peer-rpc.ts`；修改 `src/adapters/codex/protocol.ts`、`app-server-client.ts`、`codex-runtime.ts`、`tui-bridge.ts`、`src/backends/codex-backend.ts`、`src/process/main.ts`；测试 `tests/accounts/switch-gate.test.ts`、`consumer.test.ts` 及现有 adapter 测试。

- [x] 写失败测试：在 turn/start 响应尚未返回时准备切换；后台通知/TUI 并发启动；等待既有回合；已有内部队列/活动目标导致明确可重试的准备失败并恢复接纳；审查启动与 prepare 并发；取消；断线；旧 prepare/release 不释放新操作；401 刷新返回原账号。
- [x] 运行目标测试，确认失败。
- [x] `AccountSwitchGate` 同步关闭新请求接纳，等待已接纳请求应答，再以 `thread/loaded/list`、`thread/read` 和队列/目标状态核查空闲。未知结果按忙碌/失败处理。受控模型请求包括 turn/start、turn/steer、review/start、thread/compact/start、thread/queue/start；切换时拒绝新增或修改 queue/goal。发现 Codex 内部队列非空或活动 goal 时，返回 QUEUED_WORK_PENDING / ACTIVE_GOAL_PENDING 并释放所有准备门，页面提示待其完成后重试，不永久阻止它们消费。Company 尚未 dispatch 的任务保留至换号后继续，只等待已 dispatch 和效果未明操作；不把被门冻结的本地待派发数当作忙碌条件。不调用 interrupt/rotate。
- [x] 支持官方刷新 server request；长期 owner 连接处理刷新。Router backend 与所有 TUI 桥接入同一门；切换完触发既有通知机会，不重放用户文本。只有配置了后台连接文件才启用，默认不改变现有部署。
- [x] `AccountConsumer` 用内部 WebSocket 连接后台，连接凭据来自受限文件；重连时先核实/同步期望账号再释放新请求。runtime 失联或替换时重新准备，不沿用旧确认。
- [x] 将明确模块接口交 Company 作者在其源码中接入：共享 owned app-server，队列 dispatch 和终端同一门；本 lane 不修改 Company 源码。检查其接入测试和构建证据。
- [x] 运行目标回归测试，确认旧无配置行为保持。

## 任务 4：独立 HTTP 服务、账号页面与打包

文件：新增 `src/accounts/http-server.ts`、`main.ts`、`accounts.html`、`accounts.js`；修改 `package.json`、`scripts/copy-assets.mjs`；测试 `tests/accounts/http-server.test.ts`、`page.test.ts`。

- [x] 写失败测试：回环 Host/Origin 验证、JSON 大小限制、变更请求要求同源、内部 WS 拒绝浏览器 Origin/错误凭据、公开 JSON 无令牌/完整邮箱、未知错误不透出、页面等待/失败/重试显示。
- [x] 实现 `/api/state`、`/api/login`、`/api/login/cancel`、`/api/switch`、`/api/switch/cancel` 与内部 `/consumer` WebSocket。请求只包含账号 ID；登录 URL 后台打开，不经网页。
- [x] 页面支持添加授权、选择已保存账号、统一切换、查看两个端的实际状态和重新授权提示。不使用 localStorage/sessionStorage，不提供 token 输入或下载。脚本通过独立静态资源与 CSP 服务。
- [x] `lane-router-accounts` 启动专属服务，打印无秘密的页面地址，写受限连接文件；关闭仅清理自身拥有的进程。打包复制新页面资源，原 dashboard 不修改。
- [x] 运行 HTTP/DOM 测试和构建，从 `dist` 启动隔离实例检查页面及安全边界。

## 任务 5：整体验证和外部部署交付

文件：新增 `scripts/verify-account-protocol.mjs`（仅合成账号）、`docs/account-switching.md`；修改 `docs/README.md`。

- [x] 将已通过的私有版本探针改为显式 executable 参数及临时目录，确保只访问本地 fixture 服务，退出清理自己创建的进程/目录，不读取用户凭据。
- [x] 执行两版本真实 app-server 同 thread 的 A/B/401 刷新测试，检查 `A/B/B/refreshed-B` 请求头标签而不打印令牌。
- [x] 执行 `npm run typecheck`、`npm test -- --reporter=dot`、`npm run build`，仅在独立工作树。
- [x] 独立审查先确认需求覆盖，再审正确性/凭据边界和竞态；修复后补跑相关测试。
- [x] 文档写明安装命令、运行端接入配置、首次添加账号、离线/失败恢复和兼容版本；记录准确证据与真实授权尚未执行的边界。提交仅本任务文件，不包含秘密、本机运行元数据或看板稿。
- [x] 给外部部署对话交付可复核 commit、构建验证和操作说明，由其按用户授权窗口完成安装、真实授权及两边最终核实。本 lane 不自行部署或重启共享服务。

## 交付状态

实现提交为 `3164010`，可复用运行端模块为其父提交 `99fceb3`。最终 typecheck/build 通过，`npm test -- --reporter=dot --maxWorkers=4` 为 797 通过、1 个显式官方冒烟跳过。指定两版官方冒烟另已运行通过。跨仓固定协议组合已验证实际 Company 入口、Host、账号后台与刷新；部署及真实授权交给外部运行对话，尚未上线。详见[使用与验证说明](../../account-switching.md)。
