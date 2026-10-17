# 用户议题收件箱实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户于 2026-10-18 批准持续推进实现；内部审查保留，不再逐单元等待用户批准。

**Goal:** 为用户提供按议题集中查看两类问答、直接多轮回复并明确结束讨论的辅助看板，回复不依赖浏览器保存或回 TUI 重复。

**Architecture:** 同进程显式装配议题模块；业务服务、独立 SQLite、工具与 HTTP 适配、UI 分层。复用已实现的 `UserMessageDelivery` 与 mailbox/通知泵，仅补窄的 lane 身份查询和宿主工具组合；通信 core 不依赖议题业务。

**Tech Stack:** 现有 TypeScript/Node.js、`better-sqlite3`、Zod、Vitest、`happy-dom`、原生 HTML/CSS/JavaScript；不加依赖、前端框架或新服务。

---

## 1. 已批准依据与执行边界

- 用户于 2026-10-18 确认整体设计并同意进入本计划阶段。依据：[需求](../specs/2026-10-17-user-issue-inbox-requirements.md)、[设计](../specs/2026-10-17-user-issue-inbox-design.md)。设计的批准不等于本计划或未见交付结果已获批准。
- 原始基线：主仓 `master`，`6067dbb93079920c308933b6bb5ed4e880eb2b49`。已有未提交看板需求、设计、两份样稿及 `docs/README.md` 索引属于本任务；`dist-before-20261009-standalone/` 不属于本任务。保留其他工作与 `tmp.md`，后者不得读取。
- 实现时新建隔离工作树，基于上述基线及经确认的本任务文档提交；不在主树安装、构建、清理或运行测试进程。记录隔离树绝对路径、实际起点和后来新增的差异，不悄悄重设基线。
- `lane-router/account-switching` 独立负责换号，不是本功能的依赖。涉及共同装配文件时先核对其交付差异，由本协调者决定接线；不能覆盖对方工作。
- 分四个交付单元 U1–U4。用户已改为授权连续实现：各单元完成独立审查和证据汇总后继续下一单元，不再逐单元索授权；保留最终需要用户实际观察的页面验收与外部部署边界。
- 编码验证只用临时双库、mailbox、假 backend/模型协议及本机临时端口，不连接生产 Router、Company、真实登录或在用 lane。部署、共享重启以及真实客户端验收交外部对话；没有该证据时只能交付隔离验证结果，不能宣称已上线。

## 2. 文件职责与接线

| 文件 | 变动与责任 |
|---|---|
| `src/router/lane-access.ts`（新） | 进程内调用方身份、稳定 lane 查询类型；不含议题概念 |
| `src/router/router-core.ts` | 封装既有身份/binding/lane 查询，不修改数据库 schema、send/ack 或通知机制 |
| `src/modules/issues/types.ts`、`ports.ts`（新） | 议题输入/结果/错误，以及存储、时间/ID、身份、通用投递依赖 |
| `src/modules/issues/schema.ts`、`store.ts`（新） | 模块独立库、版本检查、内部外键、事务和查询；不导入 core 存储 |
| `src/modules/issues/service.ts`（新） | 发布、追加、读取、等待状态、已读、用户结束、TUI 同步和幂等操作 |
| `src/modules/issues/delivery.ts`（新） | 持久交接、重试/恢复、core 结果和 agent 业务回执；不另造通知队列 |
| `src/modules/issues/index.ts`（新） | 无启动副作用的模块工厂及显式 `start/close`，不在 import 时开库 |
| `src/modules/issues/tool-schema.ts`、`tools.ts`、`cli.ts`、`http.ts`（新） | 同一服务的工具、旧 Codex CLI、用户网页接口；不复制业务规则 |
| `src/application/tool-catalog.ts`、`builtin-tools.ts`（新） | 名称/定义/解析/分发组合与独立产品定义；模块业务不进入原 `ToolService` |
| `src/adapters/codex/dynamic-tools.ts`、`codex-runtime.ts` | 接收工具目录，发布/分发一致；保留 thread ownership、请求去重和 developer instructions |
| `src/mcp/tool-schemas.ts`、`lane-mcp-server.ts`、`zcode-lane-mcp-server.ts` | 普通 MCP 使用相同纯定义，调用由 Router 执行，不开模块数据库 |
| `src/process/local-client.ts`、`local-server.ts`、`lane-launcher.ts`、`main.ts` | 接入组合分发、`issue` CLI 分组、相邻 HTTP handler 与模块生命周期 |
| `src/process/http-json.ts`、`dashboard-http.ts` | 仅提取两种网页入口共同需要的 action 校验，旧路由/错误契约保持不变 |
| `src/ui/issues/index.html`（新）、`src/process/dashboard.html`、`scripts/copy-assets.mjs` | 列表/详情页、原后台导航链接、静态资源随构建复制并核对 |
| `docs/manual-tests.md`、`docs/README.md` | 用户使用、真实客户端验收、双库备份/回退边界及索引 |

原 `src/tools/tool-contract.ts`、`tool-schema.ts`、`tool-service.ts` 继续拥有五个通信工具的契约。允许加接线适配，不把它们扩大为含议题名的总枚举。`native-host-service.ts`、DSH 工具白名单、core schema 与通用投递底座不是重新实现范围。

## 3. 关键契约

### 身份与幂等

调用方身份由 backend 的 `resolveIdentity` 和有效 binding 决定；稳定 lane ID 必须取自 `bindingLaneId(binding.id)`，不能先按地址查找归属。身份结果含 lane ID、binding ID、generation；业务写入前重新确认其有效性，校验到同步 SQLite 事务之间不插入可让绑定变化的异步等待。无绑定、旧 generation、其他 lane 的议题写入均拒绝。

业务操作键按稳定调用方范围、操作类型和客户端操作键保存，不以临时 RPC call ID 或某一代 binding 作为持久去重依据；同键同内容返回原结果，同键异内容拒绝。用户回复使用独立的本地用户范围。已成功操作的重放先识别原结果，再应用“已结束”等新操作限制；仍先验证当前调用方有权访问该议题。

每份交接在保存用户回复的同一事务内固定：`deliveryId`、`entryId`、`ownerLaneId`、首次组织好的完整 `body`、宿主 `source`、`requestKey`。正文携带议题、条目、投递 ID、必要上下文、可用查询方式与原授权内继续处理说明；重试不根据后来变化的标题、历史或地址重新生成。通用来源使用固定宿主值，不接受网页/模型任填。

### 状态与提交

严格分开议题 open/closed、问题等待状态、用户已读位置、持久入箱事实及 agent 处理回执。用户的解释请求只转为等 lane，不自动成为最终决定；agent 补充解释后可以继续等待用户。回答/无需回答必须关联记录，不能删除正文。只有用户结束议题；TUI 结束以带原话、来源为 `agent_reported_tui_user` 的专门记录操作实现，不藏进普通状态更新。

保存成功才返回成功；HTTP 超时表示结果未确定，客户端用同一操作键重试或读取后端历史，不生成新键自动重发。页面刷新后以后端历史为准，不依赖浏览器持久队列。后端列表计算待处理原因；前端不自行推导议题规则。

已有入箱结果只停止交接重试，不表示 agent 已处理；模块处理回执按投递 ID 独立记录，可先于交接器写回 core 消息 ID 到达，不得被较晚的入箱结果覆盖。结束后拒绝新的讨论追加和问题变更；已读游标仍可按实际展示序号单调推进，成功操作可重放、已有投递可补记事实回执，不取消先前保存的授权输入。

### 模块表与索引

所有业务 ID 为不含地址语义的字符串，时间为毫秒整数。下表字段是实现约束，不要求照抄整段 SQL；可增加对应约束需要的内部列，但不能引入新产品状态。正文、原始问题及状态事件均保留在条目中，列表不从 mailbox 反查正文。

| 表 | 字段与键约束 |
|---|---|
| `issue_thread` | `id` 主键，`owner_lane_id`、`title`、`origin_kind`（答复/主动提问）、`status`（open/closed）、`created_at`、`updated_at`、`closed_at`、`read_seq`、`next_seq`。owner 不设跨库外键；索引 `(owner_lane_id, updated_at, id)`，已读序号仅单调前进 |
| `issue_entry` | `id` 主键，`issue_id` 本库外键、`seq`、`kind`（question/answer/reply/event）、`author`、`source`、`body`、可空 `related_entry_id`、`recorded_by_binding_id`/`recorded_by_generation`、`created_at`。`(issue_id, seq)` 与 `(issue_id, id)` 唯一；关联条目以 `(issue_id, related_entry_id)` 复合外键保证同议题，Web 用户无伪造 recorder |
| `issue_question` | `id` 主键，`issue_id`、`prompt_entry_id`、初始 `asked_to`、`status`（waiting_user/waiting_lane/answered/not_needed）、可空 `answer_entry_id`、`reason`。提问/答复均用同议题复合外键，`prompt_entry_id` 唯一；answered 必须关联答复，not_needed 必须有原因；索引 `(issue_id, status)` |
| `issue_delivery` | `id` 主键，`issue_id`、`entry_id` 同议题外键且唯一，固定 `owner_lane_id`、`body`、`source_kind`/`source_origin`、`request_key` 唯一，`handoff_state`（pending/accepted/blocked）、可空 `core_message_id`、`attempt_count`、`next_attempt_at`、`last_error`/`last_target_state`，独立的 `processed_at`/`processed_by_binding_id`/`processed_by_generation`。索引 `(handoff_state, next_attempt_at)`；accepted 需有 core 消息 ID，处理回执可先于 accepted 到达 |
| `issue_operation` | `(actor_scope, operation, operation_key)` 主键，`request_digest`、`result_json`、`created_at`。摘要来自校验/规范化后的请求内容，不因 JSON 字段顺序不同而冲突；scope 不随 lane generation 改变。不缓存业务失败为成功，不用它充当通知或重试队列 |
| `issue_schema_version` | 单例版本行；只表示本模块支持的 schema。建库、迁移与版本记录在模块事务内完成；未来版本、未知非空结构或损坏明确拒绝，不覆盖为新空库，不修改 core `user_version` |

线程序号分配、条目、问题状态与业务操作结果在同一模块事务提交；回复另包含唯一交接任务。关闭等状态事件不计作未读 lane 答复。索引服务于现有列表、问题与交接查询，不预建全文搜索或跨库 lane 副本。

## U1：模块业务与独立存储

交付目标：不依赖 UI/HTTP/真实模型即可完成议题生命周期，稳定身份可校验；不装配模块时旧 core 完整可用。

### Task 1：基线与窄身份端口

**Files:** 新建 `src/router/lane-access.ts`、`tests/router/lane-access.test.ts`；修改 `src/router/router-core.ts`。

- [x] 在隔离树保留原始 `git status`、基线全套结果与依赖版本；运行 `npm ci`、`npm test -- --maxWorkers=2 --testTimeout=30000`，先区分既有失败，不改测试配置掩盖它。
- [x] 新增失败测试：未绑定/失效 binding 拒绝；joined identity 正确解析；旧地址归档并同名新建后仍按 binding 的 lane ID 判归属；按 ID 查询不误指向新 lane。
- [x] 运行 `npm test -- tests/router/lane-access.test.ts`，确认缺少端口的目标失败，而非测试加载/语法失败。
- [x] 用既有身份解析、`bindingLaneId`、`laneById`、`activeBindingForLaneId` 实现窄端口；不把 state store 交给模块。
- [x] 重跑定向测试与 `tests/router/router-core.test.ts`、`tests/router/lane-archive.test.ts`、`npm run typecheck`；只提交本任务文件。

### Task 2：模块表、事务与业务服务

**Files:** 新建模块 `types.ts`、`ports.ts`、`schema.ts`、`store.ts`、`service.ts`、`index.ts`；新建 `tests/fixtures/issues/setup.ts`、`tests/modules/issues/store.test.ts`、`service.test.ts`、`lifecycle.test.ts`。

- [x] 先新增失败测试：仅两种发布类别；答复携带原问题；同 lane 多轮关联；TUI 相关输入同步不回声；未读与仍待回答分别计算；读到指定序号、不吞并发新消息；只有用户结束；结束/追加提交顺序及成功操作重放。
- [x] 新增存储失败测试：本库外键/同议题引用、单调序号、操作键冲突、重开历史保留、未来版本/损坏库拒绝且不覆盖文件；模块未装配不创建文件；core 严格 schema 不变。
- [x] 运行 `npm test -- tests/modules/issues` 确认新行为为红；建立设计所列六张自有表、内部索引/外键与独立版本，不使用 core 迁移器或跨库外键。
- [x] 实现统一服务与后端计算的列表/详情，按第 3 节校验身份和状态。用户回复事务同时写入正文、等待状态、操作结果、固定内容的持久交接记录；此单元不启动交接器。
- [x] 重跑模块及身份测试、`npm run typecheck`；补导入依赖边界测试 `tests/modules/issues/boundaries.test.ts`，禁止 core import 模块、服务 import UI/HTTP/core store。自查并本地提交。

**U1 完成条件：** 临时双库业务测试通过，独立服务可用，损坏库不丢历史，稳定归属与状态规则通过独立审查；汇总结果并继续 U2。

## U2：可靠交接与业务回执

交付目标：后端保存后即使页面关闭或进程中断，也能把同一回复交到原 lane，并准确表示处理是否已确认。

### Task 3：交接器与中断恢复

**Files:** 新建 `src/modules/issues/delivery.ts`、`tests/modules/issues/delivery.test.ts`、`tests/modules/issues/recovery.test.ts`；修改模块 `store.ts`、`service.ts`、`index.ts` 及 fixture。

- [x] 新增失败测试：保存后未调用投递即退出；core 入箱成功但模块尚未记结果；文件先写/索引中断；通知失败；ACK 后重试；归档后原结果恢复；同名新 lane 不能接收旧回复。
- [x] 使用持久库重开、可注入故障点、可控时间验证，不用真实模型或脆弱的固定时长 sleep；实际隔离 `RouterCore`/mailbox 交接至少一条，不能全用假投递掩盖底座契约。
- [x] 运行上述两套测试确认红；实现同进程单次消费、启动恢复及有上限的退避间隔。已知归档/missing 等目标拒绝保留记录及原因，不空转；不自动改目标、开 TUI 或新建投递。
- [x] 每次调用固定 `target: {laneId}`、来源、正文与请求键；仅未确认入箱的任务重试，成功后由原通知泵负责。关闭时停止调度、等待在途交接可安全收尾，再关模块库。
- [x] 运行 `npm test -- tests/modules/issues tests/router/user-message-delivery.test.ts tests/router/mailbox-store.test.ts tests/router/tell.test.ts`；检查并本地提交，不修改旧投递/ACK 契约。

### Task 4：回执、关闭与投递竞态

**Files:** 修改模块 `service.ts`、`delivery.ts`、`store.ts`；新建 `tests/modules/issues/receipt.test.ts`，扩展 `lifecycle.test.ts`。

- [x] 先写失败测试：无业务回执始终“处理未确认”；通知/ACK 不升级；回执先于 core 消息 ID 记回；回执重复/错 lane/错投递拒绝；结束后可补既有回执但不可追加讨论。
- [x] 实现按投递 ID 的业务事实记录；独立保存入箱结果与处理回执，晚到的入箱结果不降级处理状态。不提供新的通知/ACK 查询接口。
- [x] 重跑 U2 定向测试和 U1 生命周期回归，保留真实红绿证据、故障点和重开后的相同 ID；自查并本地提交。

**U2 完成条件：** 明确覆盖双库非原子窗口、内容稳定性、同名隔离与回执竞态；记录“至少一次提醒不等于业务副作用恰好一次”的限制，经审查后继续 U3。

## U3：工具、CLI、HTTP 与显式装配

交付目标：常规 agent 入口和用户网页接口调用同一业务服务，旧工具与受限 Host 不受扩大。

### Task 5：纯定义目录与议题工具

**Files:** 新建 `src/application/tool-catalog.ts`、`builtin-tools.ts`、模块 `tool-schema.ts`、`tools.ts`；修改 `src/adapters/codex/dynamic-tools.ts`、`codex-runtime.ts`、`src/mcp/tool-schemas.ts`、`lane-mcp-server.ts`、`zcode-lane-mcp-server.ts`、`src/process/local-client.ts`、`local-server.ts`、`main.ts`。新建 `tests/application/tool-catalog.test.ts`、`tests/modules/issues/tools.test.ts`、`tests/tools/issue-entry-contract.test.ts`，扩展既有工具/MCP/动态工具测试。

- [x] 先写失败测试：组合工具可发布并调用；重名/未知名拒绝；四个议题工具与专门 TUI 用户结束操作只访问本 lane；额外 owner/backend/generation/confirmed 参数拒绝；原五工具定义/参数/行为不变。
- [x] 纯定义目录统一提供名称、说明、Zod schema 与解析；运行分发按相同目录接到各服务。保留原 `ToolService` 及其 `AbortSignal`、`rejectTakeover` 行为；不把议题 case 放进去。
- [x] MCP/动态工具分别从该定义生成适用 JSON Schema，普通客户端接组合目录；Codex runtime 的工具发布与 dispatcher 检查必须使用同一目录，并保留 thread ownership 和已有请求缓存。不要求旧会话热更新动态工具。
- [x] `main.ts` 在 Codex 初始化前可构造纯定义，服务 ready 后才接处理函数；启动恢复在 mailbox 对账后进行。MCP import 定义不实例化数据库。独立产品显式装配议题；不装配路径保持通信工具原状。
- [x] 测试模块库故障时 core 仍能启动、议题入口返回 `ISSUES_UNAVAILABLE`；异常启动/正常关闭均回收交接调度与库，且不影响 core shutdown。DSH/Native Host 仍用原通信服务和现有白名单。
- [x] 运行 `npm test -- tests/application tests/modules/issues/tools.test.ts tests/tools tests/mcp tests/adapters/codex/dynamic-tools.test.ts tests/backends/codex-backend.test.ts tests/process/dsh-host-api.test.ts tests/process/native-host-boundary.test.ts tests/process/local-transport.test.ts`；通过后自查并提交。

### Task 6：旧 Codex CLI 与用户 HTTP

**Files:** 新建模块 `cli.ts`、`http.ts`，修改 `src/process/lane-launcher.ts`、`local-server.ts`、`main.ts`、`http-json.ts`、`dashboard-http.ts`；新建 `tests/modules/issues/cli.test.ts`、`http.test.ts`，扩展 `tests/process/lane-launcher.test.ts`、`dashboard-http-contract.test.ts`。

- [ ] CLI 测试先红：`lane-router-lane issue <publish|read|append|update|record-tui-close> --json-file <path>` 将 JSON 交同一工具操作；文件由 agent 普通编辑工具写入，不经 PowerShell 字符串造 JSON。操作键在 JSON 中；当前身份只取 `CODEX_THREAD_ID` 与 cwd，缺失/未绑定拒绝，不支持模型指定 backend/owner。
- [ ] HTTP 测试先红：`GET /issues` 静态页、`GET /issues/api/threads` 列表、`GET /issues/api/threads/:id` 详情；`POST /issues/api/threads/:id/replies`、`/read`、`/close` 写入已有议题。列表/详情可分页，默认待我处理，保留全部/结束历史浏览；不加 create/arbitrary-target。
- [ ] 实现相邻 `IssuesHttp` handler，复用 JSON 限额与现有 origin/action header/token 规则；只提取两 handler 实际共同使用的校验。读响应提供当前进程 action token，写请求拒绝跨源、缺 token、坏 JSON/类型和额外身份字段。网页不能调用机器 `/rpc` 冒充 agent，未知路径不读取正文。
- [ ] 状态结果保留业务错误码；已结束/键冲突/目标不可用按事实返回，保存失败不成功，超时用同键重试/历史确认。CLI 使用现有 loopback RPC，不另建协议或修改 `tell`。首次模块未装配为不存在，已装配但不可用明确报错。
- [ ] 运行 `npm test -- tests/modules/issues/cli.test.ts tests/modules/issues/http.test.ts tests/process/lane-launcher.test.ts tests/process/dashboard-http.test.ts tests/process/dashboard-http-contract.test.ts tests/process/tell-guard.test.ts tests/process/local-transport.test.ts`；类型检查，独立审查后提交。

**U3 完成条件：** 工具目录、各适配和已有入口回归均通过；通信-only 与模块故障路径实测于 fixture；汇总结果后继续 U4。新工具刷新是否真可用仍留给外部真实客户端验收，不用 schema 测试冒充。

## U4：列表与详情看板、完整验证与外部部署交接

交付目标：使用已选布局，UI 连接后端服务；可从待处理问题继续多轮讨论，关闭页面不影响已提交回复。

### Task 7：真实数据 UI 与资源交付

**Files:** 新建 `src/ui/issues/index.html`、`tests/modules/issues/ui.test.ts`；修改模块 `http.ts`、`src/process/dashboard.html`、`scripts/copy-assets.mjs`，扩展 `tests/process/dashboard-render.test.ts`。

- [ ] 先用 `happy-dom` 写失败交互测试：列表/详情切换，未读答复与仍待回答区分，同一议题回复关联，待 lane 状态，明确结束/取消，已结束可查且无回复入口，正文转义，后端保存失败与结果未确定。
- [ ] 从已选[普通浏览器样稿](../mockups/issue-inbox-layout-browser.html)实现原生 HTML 页面，不复制演示数据/模拟发送/内嵌 React runtime。UI 不导入存储或推导业务状态；提交期间保留同一操作键，后端成功前不清空并显示成功。
- [ ] 使用普通读取刷新后端列表和选中详情，不新增 WebSocket/SSE。读游标仅推进到本次实际展示序号；后台到达且未展示的新内容保持未读。不存浏览器投递队列，不因缺回执重发。
- [ ] 原后台只增加进入 `/issues` 的链接；模块 HTTP 按资源路径提供页面，构建脚本复制并读回核对 `ui/issues/index.html`。构建只在隔离树执行。
- [ ] 运行 UI、HTTP 和旧后台渲染测试，`npm run typecheck`、隔离树 `npm run build`；在构建产物上的隔离 server 请求页面及执行交互，确认不是只从源目录可用。自查并提交。

### Task 8：跨适配验收、文档与交付

**Files:** 新建 `tests/e2e/issue-inbox.test.ts`、`tests/fixtures/issues/router.ts`；修改 `docs/manual-tests.md`、`docs/README.md` 及本计划。

- [ ] 先写端到端失败场景：工具发布 → HTTP 列表/详情 → 用户回复 → 持久入箱 → 假 agent 查询/处理/回执 → 新答复 → 用户结束；另覆盖 TUI 同步、busy/offline、重开双库恢复、HTTP 断线、同名新 lane 隔离。不调用生产 `ensureRouter` 或真实模型。
- [ ] fixture 使用实际服务、双库、HTTP/CLI/工具组合，只有模型/backend 为假；加入 core-only/损坏模块库启动、worker 退出无残留、资源复制、依赖方向检查。修正本范围问题，保留最初失败与修复后输出。
- [ ] 完整执行隔离树 `npm test -- --maxWorkers=2 --testTimeout=30000`、`npm run typecheck`、`npm run build`、`git diff --check`。出现失败先核根因，保留原日志，不靠重复到绿掩盖波动，不修改默认配置。结果报告使用实际文件数/测试数，不预填新增数量。
- [ ] 更新操作说明、工具参数、CLI JSON 示例、错误与状态语义、停止/恢复模块的方法、双库备份及回退边界。备份覆盖两个数据库一致快照及相关 WAL 状态；不增加通用备份命令。单库恢复造成引用缺失时保留历史、拒绝错误投递，不自动改挂。
- [ ] 给外部部署对话准备准确提交/构建资源清单与 hashes、在用数据保护与回退条件；需要外部实施实际成对备份、受控部署/重启和 Codex 新动态工具/旧 CLI、Claude/ZCode MCP 刷新与真实往返验收。真实模型额度、指定 lane、可接受中断需在该外部操作中确定，不从本对话试探。
- [ ] 完成独立正确性/范围审查和走查，回报隔离证据、未验现场项与剩余风险。按当前持续实现授权整合已验证的任务自有本地结果；不 push、不部署、不重启，不宣称现场可用。

**U4 完成条件：** 实现与隔离端到端证据齐全，用户确认实际页面交互，交付可由外部对话部署的版本与准确验收步骤；现场通过与否单列，不作为本 lane 已经执行的事实。

## 4. 验收对照与范围增量审查

| 已批准要求 | 必须落地的单元与判据 |
|---|---|
| R1–R3：仅两类、TUI 发起、相关多轮 | U1 服务限制、U3 工具、U4 端到端；网页无创建入口 |
| R4–R5：回复有效、TUI 同步 | U1 保存、U2 交接、U3 相同服务与说明；同步不回声投递 |
| R6–R7/A5：只有用户结束、待处理准确 | U1/U2 状态/竞态、U4 DOM；读过仍待回答，结束后无新追加 |
| R8–R9：离线保留、历史与处理事实 | U1 双库持久、U2 中断恢复和回执、U4 历史/超时；不显示无证据的通知/ACK |
| R10/A7–A8：辅助入口与常规 TUI、列表详情 | U3 不扩 Host、U4 页面；不自动开 TUI、不做整份对话镜像 |
| R11–R12/A1–A4/A6：分层、可选模块、稳定归属、双库 | U1 依赖/身份测试、U3 纯定义与生命周期；core-only、模块故障与同名隔离均有证据 |

本计划相对已批准设计没有新增产品能力。新增的精确文件名、`/issues` 页面与 `/issues/api` 具体路由、CLI JSON 文件形态、同进程定时读取及模块 `start/close` 是设计已有适配、展示和可靠交接的落地选择；不增加网络协议、配置、鉴权体系、状态查询平台或公共通用发送入口。HTTP action 校验只按两个实际消费者提取，禁止顺带重写全部 server。

不纳入换号、资源讨论、图交互、动态插件管理、远程多用户、附件、全文搜索、主动通知、自动重开 TUI；不为未纳入项建立未来待办。审查发现若要求这些新能力或改变已确认语义，先报告差异，不将其藏进“修 review”步骤。

状态：计划和连续实现已获用户批准；正在准备隔离工作树与 U1 基线。没有部署或共享重启授权。
