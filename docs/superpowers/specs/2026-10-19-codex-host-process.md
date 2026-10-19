# Codex 宿主独立进程：需求与设计

状态：2026-10-19 由 `lane-router/codex-host` 起草，`lane-router/design` 当天过目通过（回信 `8c65dc73`），并补了一条构建标识的要求，已并入 3.6。同日实施完成；自动测试和不依赖模型的真机部分已过，真模型那部分等全局 Codex 授权恢复后补跑（`docs/manual-tests.md` 的 TC-CODEX-HOST-2）。实施中对本稿的补充都在正文里注明了。任务书在仓库外（`handoffs/2026-10-19-codex-host/brief.md`），本稿把其中的目标、范围和验收口径收进来，实施只以本稿为准。

## 术语表

| 术语 | 含义 |
|---|---|
| 核心 | 现在的 Router 进程（`dist/process/main.js`）：SQLite、mailbox、HTTP/RPC、工具实现、通知泵、看板。 |
| 宿主 | 本稿新增的 Codex 宿主进程（`dist/process/codex-host.js`）：持有 `codex app-server` 子进程、TUI bridge、账号 consumer。 |
| 链路 | 宿主主动连到核心的一条 WebSocket（`/codex/host`），双向收发请求和事件。 |
| 原始连接 | 宿主自己对 app-server 开的那条长连接（今天是 `CodexAppServerProcess.client`），接收 `account/chatgptAuthTokens/refresh`，也承载核心发起的 `thread/read`、`turn/start`、`turn/steer`、`model/list`。 |

## 1. 目标与验收口径

用户原话：「lane-router 关闭的时候我还能对话」。

今天 Router 进程自己 `spawn` 并持有 `codex app-server`（`src/adapters/codex/app-server-process.ts:53`），`CodexTuiBridge` 也在 Router 进程里，TUI 连的是 discovery 里的 `codexEndpoint`。Router 一重启，`scripts/restart-router.ps1` 把 app-server 子进程一起停掉，TUI 的 WebSocket 断开，所有开着的 Codex 对话都要 `resume`。Claude 侧没有这个问题：模型在 `claude` 进程里，Router 只是旁路，重启只断 channel，MCP 子进程按 `discovery.json` 自己重连（2026-10-16 与 10-19 两次重启各有 18 到 25 条 channel 自动接回）。

本稿把 Codex 做成同样的分层：bridge 和 app-server 搬进独立的宿主进程，生命周期与核心分开。

| 角色 | 内容 |
|---|---|
| 核心 | SQLite、mailbox、HTTP/RPC、工具实现、通知泵、看板；Codex 侧只剩 `CodexBackend` 和链路的服务端。 |
| 宿主 | app-server 子进程、默认 bridge 与按 provider 开的 bridge、动态工具注入、thread 认领与可见客户端计数、`item/tool/call` 转发、通知观察、账号 consumer 与 switch gate。 |
| 宿主 → 核心 | 工具调用、所有权询问、可见客户端计数、通知观察、重连后的处理机会。核心不在时普通对话照常；lane 工具调用**立刻**返回「Router 暂不可用」，不挂起。核心回来后宿主自动重连，恢复认领与通知。 |
| 核心 → 宿主 | 通知投递和接替判断要用的 `thread/read`、`turn/start`、`turn/steer`，以及看板要用的 `model/list`。 |

## 2. 选型

### 2.1 宿主怎么启动、怎么被找到

| 候选 | 做法 | 取舍 |
|---|---|---|
| A 按需拉起（选用） | 宿主自带 `codex-host.lock` 和 `codex-host.json`。核心启动后、`lane-router-codex` 启动时各调一次 `ensureCodexHost`：找到活的（discovery 加 `/health` 核对 `instanceId`）就用，找不到就经 `detach-router.js` 拉起一个 detached 进程。 | 与 `ensureRouter` 同一套已验证的做法（detach 防杀树、启动锁、启动日志）；不新增常驻进程。 |
| B 独立 supervisor | 仿 `lane-router-accounts-supervisor`，常驻监督宿主并自动重启。 | supervisor 自己还得有人拉起（开机任务不在范围内），最终仍需要 A 的 ensure；多一个常驻进程。不选。 |

谁会去 ensure：核心启动时一次、核心发现链路断开时一次（各带 3 次退避重试，不无限重试）；`lane-router-codex` 每次启动一次。宿主自己**不**拉起核心：工具调用路径上去等一个核心启动（今天最长 15 秒以上）就违背了「立刻报错」。核心照旧由 Claude 侧 MCP、launcher 和重启脚本拉起。

### 2.2 链路走什么

| 候选 | 做法 | 取舍 |
|---|---|---|
| 复用 `/rpc` 加新端点 | 工具调用走 `/rpc`；核心到宿主的请求另开端点或另一条连接。 | 核心到宿主的方向（通知要 `turn/start`）`/rpc` 本来就做不到，仍要第二条通道；`/rpc` 的 `callerContext` 还得放宽去接收 `startup`。两个面。 |
| 单条 WebSocket（选用） | 宿主连核心的 `/codex/host`，一条连接上双向请求和事件。 | 一个新入口；断开就是「核心不在」的唯一判据，工具调用的立即失败和「调用中途断线、结果未知」都能从连接状态直接得出。 |

方向取宿主作客户端，与 Claude 侧 MCP 连 `/claude` 一致：核心重启换端口后，宿主按 `discovery.json` 重新解析并核对 `/health` 的 `instanceId` 再连，退避节奏沿用 `connectClaudeChannel` 的 100 ms 到 5 s。

## 3. 设计

### 3.1 进程与文件

| 文件（`dataRoot` 下） | 写者 | 内容 |
|---|---|---|
| `codex-host.lock` | 宿主 | `RuntimeLock`，保证每个 `dataRoot` 只有一个宿主。 |
| `codex-host.json` | 宿主 | `{ pid, url, codexEndpoint, instanceId, protocolVersion }`。app-server 就绪、默认 bridge 和 HTTP 面都在监听后才原子写入；正常退出时删除。 |
| `codex-host-startup.lock` | ensure 调用方 | 启动锁，与 `startup.lock` 同理，防两个 ensure 同时 spawn。 |
| `codex-host.log` | detach 启动器交给宿主的 stderr | **追加**写入，每次启动先写一行带时间与 pid 的分隔；ensure 只读本次 spawn 之后追加的部分来报告失败。 |

宿主的 HTTP 面只监听 loopback，两项：`GET /health` 返回 `codex-host.json` 同样的内容；`POST /codex/provider-endpoint` 从核心原样搬来（参数、校验、网页来源守卫都不变）。默认 bridge 和各 provider bridge 照旧各占一个 loopback 端口。

核心 discovery 去掉 `codexEndpoint`，只留 `pid`、`port`、`url`、`instanceId`。核心不再持有任何 Codex 端点，也不再有 `/codex/provider-endpoint`。

### 3.2 宿主怎么拉起才不产生第二个，也不覆盖日志

`ensureCodexHost({ dataRoot })` 的顺序：

1. 读 `codex-host.json`，`/health` 的 `instanceId` 对得上就直接返回。
2. 取 `codex-host-startup.lock`；取不到说明另一个调用方正在拉起，转去等待第 1 步成立。
3. 持锁后再查一次第 1 步。
4. `codex-host.lock` 若被活进程持有（宿主已在启动、还没写 discovery），**不 spawn**，等待第 1 步成立。这一步堵上今天 `router-start.log` 被第二次尝试覆盖开头的那个竞态：只有确认没有宿主进程在跑时才会拉起。
5. 经 `detach-router.js`（加追加模式参数）拉起宿主，环境沿用 `ensureRouter` 的代理补全；等待第 1 步成立，超时 60 秒。宿主启动包含 `codex --version`、schema 生成和 app-server 就绪，10-16 那次实测约 18 秒，所以不沿用核心的 15 秒。

宿主进程自己启动时也先取 `codex-host.lock`，取不到就以「已有宿主在运行」退出，作为第二道保证。

### 3.3 链路协议

帧都是 JSON。请求 `{ id, method, params }`，应答 `{ id, result }` 或 `{ id, error: { code, message, rpcCode? } }`，事件 `{ method, params }`（无 `id`）。版本号随 `hello` 发送，当前为 1。

| 方向 | 帧 | 内容与用途 |
|---|---|---|
| 宿主 → 核心 | 事件 `hello` | `protocolVersion`、宿主 `instanceId`、`pid`、构建标识 `build`（见 3.6）、app-server 状态、`threads: [{ threadId, visibleClients }]`。每次连上第一帧。核心据此替换整份宿主快照。 |
| 宿主 → 核心 | 事件 `appServer` | app-server 状态变化（`ready`、`recovering`、`failed` 等）。 |
| 宿主 → 核心 | 事件 `threadClients` | 某 thread 的可见客户端数（绝对值，可重放）。认领和 TUI 断开都发。 |
| 宿主 → 核心 | 事件 `observe` | 只转发 `CodexBackend` 消费的两种通知：`turn/completed` 和 `thread/status/changed`。来源包括原始连接和各 bridge 看到的上游消息。 |
| 宿主 → 核心 | 事件 `opportunity` | `threadIds`：app-server 恢复、账号切换放行后，给这些 thread 一次处理机会。 |
| 宿主 → 核心 | 请求 `tool` | `{ name, arguments, context: { conversationId, cwd?, startup?, requestKey } }`。核心固定 `backend: "codex"`；`cwd` 缺省时按今天的规则从绑定的 `startup.cwd` 补。 |
| 宿主 → 核心 | 请求 `ownsThread` | `{ threadId }`，答布尔值；核心查 `latestBindingForConversation("codex", threadId)`。 |
| 核心 → 宿主 | 请求 `appServer.request` | `{ method, params }`，方法限 `thread/read`、`turn/start`、`turn/steer`、`model/list`。宿主对模型类请求先过账号 gate，再经原始连接发出。 |

错误码在核心侧还原成今天 `CodexBackend` 认得的类型：`ACCOUNT_SWITCH_IN_PROGRESS` 等账号码还原为 `AccountError`，`CODEX_APP_SERVER_RPC` 还原为带 `rpcCode` 的 `AppServerRpcError`（`isMissingThread` 看 message，所以 message 原样带回），`CODEX_APP_SERVER_DISCONNECTED` 还原为 `AppServerDisconnectedError`。这样 `CodexBackend` 的 `notify`、`waitUntilReplaceable`、`reach`、`restorePresence` 一行不改。

核心侧只认一条宿主连接：新连接到达时关掉旧的（与 Claude channel 的 `replaced` 同理），`/codex/host` 握手带 `Origin` 一律 403，与 `/claude` 同一判据。信任边界不变：同一 Windows 用户的 loopback 进程。今天任何本机进程本来就能直连 `codexEndpoint` 驱动 app-server，也能用任意 codex `conversationId` 调 `/rpc`，这条链路没有给出更多能力。design 提过可复用 `loadDshHostToken` 的 owner-only token 给链路加 bearer，用来防日后同机第二份构建的宿主误连；它不算缺口，本稿不做：宿主只连自己 `dataRoot` 下 discovery 指向的核心，误连需要两份构建共用同一个 `dataRoot`，而那时 `codex-host.lock` 已经只放行一个宿主。

### 3.4 核心或宿主不在时各发生什么

| 情形 | TUI 普通对话 | lane 工具调用 | 通知与恢复 |
|---|---|---|---|
| 核心停止或重启中 | 照常：TUI 到 bridge 到 app-server 全在宿主里。账号 gate 也在宿主里，照常接纳。 | 宿主见链路未连通，立即返回 `ROUTER_UNAVAILABLE`：「Lane Router is not running (stopped or restarting); this call was not executed. Retry once it is back.」核心收不到任何调用。 | 不发生。 |
| 调用途中核心退出 | 照常。 | 该调用以 `ROUTER_CONNECTION_LOST` 失败：结果未知（例如 `lane_send` 可能已落盘），提示先用只读工具核实再决定是否重试。核心侧的执行收到中止信号。 | — |
| 核心回来 | 照常。 | 宿主重连成功后即可用。 | 宿主发 `hello`；核心对 `hello.threads` 与全部活跃 codex 绑定各发一次处理机会，通知泵补发 pending；拿到 app-server 就绪后刷新看板的 Codex 模型列表。绑定、generation 都在 SQLite 里，重连不改。 |
| 宿主退出或被重启 | 断开，属预期：bridge 和 app-server 都在宿主里。需要 `lane-router-codex resume <thread-id>`，或从看板 / `lane-router-lane open` 恢复。 | 无 TUI 可调。 | 核心见链路断开，`ensureCodexHost` 一次（找到活宿主就不 spawn）；`reach` 报 `no_channel`，`restorePresence` 报 `unavailable`，直到新宿主连上。 |
| 宿主的 app-server 自愈中 | 与今天相同：上游断开会让 TUI 断开。 | 与今天相同。 | 宿主发 `appServer` 事件；核心视为未连通。恢复后宿主发 `opportunity`。 |

### 3.5 各入口的适配

| 入口 | 改动 |
|---|---|
| 核心启动（`main.ts`） | 不再 `await codex.start()`。核心与宿主互相等待会成环：宿主要靠核心写出的 `discovery.json` 才能连上，所以核心启动不能依赖宿主就绪。核心写完 discovery 后在后台 ensure 宿主，失败只写 stderr。**行为变化**：没有可用 `codex` 的机器上核心照样启动，Codex 相关能力报 `unavailable`，而不是像今天这样拒绝启动。 |
| 核心关闭 | 不再停 app-server；只关链路连接。 |
| 看板启动选项 | Codex 模型列表从「启动时取一次，取不到就启动失败」改为「链路就绪时经 `model/list` 取，失败保留上一次结果」。链路就绪前列表里只有 Claude 模型。`DashboardLaneOpener` 的覆盖校验读同一份列表。 |
| `lane-router-codex` | 先 `ensureRouter`（与今天一样，保证 lane 工具可用），再 `ensureCodexHost`；默认端点取宿主 discovery 的 `codexEndpoint`，provider 端点向宿主 `url` 发 `POST /codex/provider-endpoint`。其余参数、`resume`、profile、transient 语义不变。 |
| 看板恢复、`lane-router-lane open`、批量打开 | 不改调用方。它们读 `resumeInfo` 的 `restorePresence`，终端里最终跑的还是 `lane-router-codex resume`。 |
| `restorePresence` | 链路未连通或宿主 app-server 未就绪时 `unavailable`；否则按宿主上报的可见客户端数给 `online` / `offline`。与今天「app-server 断开即 `unavailable`」同一语义，只是判据从进程内客户端换成链路加宿主状态。 |
| `reach` | 链路未连通时 `no_channel`；连通后沿用已观测的生命周期：核心重启后在该 thread 下一次 `turn/completed` 或转为空闲之前报 `unconfirmed`。这与 `docs/manual-tests.md`「Router 被换掉之后，`reach` 会在下一次 lifecycle 之前低报」记录的 Claude 侧语义一致。为此实施时改了 `CodexBackend.reportReconnect`：宿主重连、app-server 恢复、账号切换放行只给处理机会（唤醒通知泵和等待中的接替），不再记成观测到一次生命周期。此前它会把所有已知 thread 记成 `live`，接到宿主的 `hello` 上就会让每次核心重启后所有 Codex lane（包括没开 TUI 的）都报 `live`。只有宿主重启而核心没重启时，核心保留此前观测到的时间戳，照旧报 `live`，与拆分前 app-server 重启时一致。 |
| 接替等待（`waitUntilReplaceable`） | 不改。链路断开时等下一次处理机会，宿主重连的 `hello` 就会给出这次机会；外层仍受调用方的中止信号约束。 |
| 账号切换 | `AccountConsumer` 与 `AccountSwitchGate` 随原始连接搬进宿主，consumer `id` 仍为 `"router"`。连接文件取宿主环境的 `LANE_ROUTER_ACCOUNTS_CONNECTION`，否则取 `dataRoot` 配置的 `accounts.connectionFile`，与今天核心的取法相同。gate 放行时的处理机会经 `opportunity` 送到核心。`docs/account-switching.md` 里「Router 启动环境设置」改为「宿主启动环境」：宿主由核心或 launcher 拉起，继承拉起方的环境。 |
| `/codex/host` 与 `thread/resume` 所有权 | bridge 对 `thread/resume` 的所有权检查改为：宿主本次生命周期认领过的直接放行，其余经链路问核心；链路不通时拒绝并说明 Router 暂不可用。为此 bridge 对同一 TUI 连接的消息按到达顺序串行处理，避免异步检查让后面的消息抢先。 |
| `scripts/restart-router.ps1` | 默认行为不变：停核心、杀**核心**的 `codex.exe app-server` 子进程、ensure 核心。新构建的核心没有这类子进程，所以不会碰宿主的 app-server；这段清理留给第一次从旧构建升级时用。新增 `-CodexHost` 开关：额外停宿主（按 `codex-host.json` 的 pid，并核对命令行是本仓库的 `dist\process\codex-host.js`）和宿主的 app-server 子进程，再 ensure 宿主并核对 `/health`。另加 `-DataRoot`（默认仍是 `~/.lane-router`），让脚本本身能在隔离目录上真跑验收，不碰共享 Router。 |

### 3.6 版本不一致

宿主跨核心重启存活，所以部署新构建并重启核心之后，宿主仍跑旧代码，直到有人带 `-CodexHost` 重启它。处理方式：

- `hello` 带 `protocolVersion`。核心不认识的版本，以关闭码 4001 和原因文字关掉连接并写 stderr；宿主记下原因，之后的工具调用错误里带上这句原因和「用 `restart-router.ps1 -CodexHost` 重启宿主」的提示。
- 协议号相同、但宿主代码有修复（例如 bridge 的 bug）时，版本号发现不了。为此 `hello` 再带构建标识 `build`：进程启动时对自己所在构建目录（`dist/`）下全部 `.js` 文件按相对路径排序后连同内容取 SHA-256。核心启动时用同一函数算出自己的标识。看板快照加一项 `codexHost: { connected, hostBuild, coreBuild }`，两者不同时看板显示一行提示：「Codex 宿主的构建与核心不同，用 `restart-router.ps1 -CodexHost` 换代」。不新增构建戳机制，只读已有产物。
- 线上格式不变的改动（例如工具实现）不涉及版本；动态工具清单仍在 `thread/start` 时由宿主注入，旧 thread 不热刷新，与今天的约定相同。

第一次部署本构建时，旧核心持有的 app-server 会被重启脚本停掉，开着的 Codex TUI 最后再断一次；之后的核心重启才不再断。部署交接要写明这一点。

### 3.7 代码落点

| 位置 | 改动 |
|---|---|
| `src/adapters/codex/host-protocol.ts`（新） | 帧类型、版本号、错误码的编码与还原。 |
| `src/adapters/codex/codex-runtime.ts` | 改为宿主侧：去掉 `RouterStateStore` 与 `CodexBackend`；工具调用、所有权询问、事件上报都经注入的链路接口。保留动态工具注入、认领、可见客户端计数、账号 gate 与 consumer、`CodexDynamicToolDispatcher`。 |
| `src/adapters/codex/tui-bridge.ts` | `ownsThread` 可返回 Promise；每条 TUI 连接的下行消息串行处理。 |
| `src/process/codex-host-link.ts`（新，宿主侧） | 连核心的客户端：解析 discovery、核对 `/health`、退避重连、请求与事件收发、连通状态。 |
| `src/process/codex-host-hub.ts`（新，核心侧） | 接受 `/codex/host` 连接；给 `CodexBackend` 提供 `request` / `isConnected` / `onNotification`；可见客户端快照；`tool` 与 `ownsThread` 处理；链路断开时触发 ensure。 |
| `src/process/codex-host.ts`（新） | 宿主入口：锁、配置、app-server、bridge 与 provider bridge、HTTP 面、discovery 写入与删除、信号处理。导出 `runCodexHost(options)` 供测试在进程内装配。 |
| `src/process/ensure-codex-host.ts`（新） | 3.2 的 ensure。 |
| `src/process/ensure-router.ts`、`detach-router.ts`、`runtime-lock.ts` | 导出可复用的等待与代理补全；detach 启动器加追加模式；`RuntimeLock` 加只查不取的 `isHeld`。核心自己的启动路径行为不变。 |
| `src/process/build-id.ts`（新） | 3.6 的构建标识；核心与宿主共用。 |
| `src/backends/codex-backend.ts` | `reportReconnect` 不再记成观测到生命周期（见 3.5 的 `reach` 一行）；其余不改。 |
| `src/process/local-server.ts` | 去掉 bridge 与 provider 端点；加 `/codex/host` 升级；discovery 去掉 `codexEndpoint`。来源守卫函数移到 `http-json.ts` 供宿主 HTTP 面共用。 |
| `src/process/main.ts` | 按 3.5 装配。测试经 `runRouterProcess` 选项替换 ensure，不再 mock `createCodexRuntime`。 |
| `src/process/codex-launcher.ts` | 按 3.5。 |
| `scripts/restart-router.ps1` | 加 `-CodexHost`。 |
| `src/router/dashboard.ts`、`src/process/dashboard.html` | 快照加 `codexHost`；构建不同时显示换代提示。 |
| 文档 | `docs/manual-tests.md`「Codex remote TUI」一节（其中「Router discovery 只含 PID、loopback 地址、Codex endpoint 与 instance ID」要改）、重启语义两节的 Codex 对应记录、新真机用例；`docs/account-switching.md` 的启动环境说明；`docs/README.md` 索引；规范库 `techniques/lane-router.md` 中描述「Router 持有 app-server / `codexEndpoint`」的句子（另一个仓，改完交 design 提交）。 |

## 4. 范围审计

基线：用户要的是「核心关闭期间已开的 Codex 对话继续」；现有流程是 `lane-router-codex` 新建与恢复、看板与 `lane-router-lane open` 恢复、通知唤醒 Codex lane、Codex 内调 lane 工具、账号切换 consumer、provider 端点、重启脚本；信任边界是同一 Windows 用户的 loopback。依据标注「明确」指任务书原文或验收条目，「推断」指本稿推出来的需要。

| 候选 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 | 收口条件 |
|---|---|---|---|---|---|---|
| 宿主进程 | 每次用 Codex | 明确：任务书分层目标 | 核心重启仍断 TUI，目标不成立 | 无 | 保留 | |
| `/codex/host` 链路（单条 WS，双向） | 宿主常连 | 明确：「宿主与核心之间的通道」 | 工具、通知、恢复都断 | `/rpc` 只覆盖单向，见 2.2 | 保留；工具调用并入同一连接，不放宽 `/rpc` | |
| `codex-host.json` 与 `/health` | launcher、ensure、重启脚本 | 明确：「自带锁与 discovery 文件」 | 无法找到活宿主，会重复拉起 | 无 | 保留 | |
| `codex-host.lock`、`codex-host-startup.lock` | 每次 ensure | 明确：验收 3「不产生第二个宿主」 | 并发 ensure 起出两个宿主 | `RuntimeLock` | 保留（复用现有类） | |
| 宿主 `POST /codex/provider-endpoint` | launcher 带 profile 或 provider 时 | 明确：provider 端点随宿主迁移 | 多 provider 启动失败 | 核心旧端点（随本稿删除） | 合并：同一接口从核心搬到宿主，核心不再提供 | |
| 核心 discovery 去掉 `codexEndpoint` | launcher | 推断：端点已不归核心 | 留着会给出过期端点 | — | 删除 | |
| 核心启动与链路断开时 ensure 宿主 | 每次核心启动、宿主退出 | 明确：验收 3「核心能重新拉起或重连宿主」 | 宿主退出后没人补起，Codex 通知与看板模型全部失效 | launcher 的 ensure（只在用户开 TUI 时） | 保留；有限重试，不做常驻监督 | |
| 宿主自动重连核心 | 每次核心重启 | 明确：「核心回来后宿主自动重连」 | 核心重启后 lane 工具永久失效 | 无 | 保留 | |
| `hello` 快照与核心侧补发处理机会 | 每次重连 | 明确：验收 2 | 核心回来后 pending 不提醒，`restorePresence` 错报 | 无 | 保留 | |
| `protocolVersion` 与关闭码 4001 | 部署后宿主仍是旧代码时 | 推断，由明确的独立生命周期直接导出 | 新旧帧格式错配时行为未定义 | 无 | 保留，只做版本号与明确报错 | |
| `hello.build` 与看板「宿主构建与核心不同」提示 | 部署后看看板的人 | 明确：design 审稿回信 `8c65dc73` 第 b 条（role 约定设计取舍归 design） | 协议号相同的宿主修复没人记得换代 | 无 | 保留；只读已有产物算哈希，不加构建戳 | |
| 链路 bearer token | 无现有消费者 | design 回信列为可选 | 无 | loopback 与 `codex-host.lock` | 删除（理由见 3.3） | |
| `restart-router.ps1 -CodexHost` | 部署新构建后需要宿主换代时，低频 | 明确：验收 3「宿主重启时的行为明确」；推断：Windows 上硬杀宿主可能留下 app-server 孤儿，需要连子进程一起停（实测 app-server 会随宿主退出，见第 7 节，清理保留作兜底） | 宿主换代只能手查 pid | 手工 `Stop-Process` | 合并进现有脚本 | |
| `restart-router.ps1 -DataRoot` | 在隔离目录上验证重启脚本；部署照旧用默认值 | 明确：任务书硬约束「真机测试一律 `LANE_ROUTER_DATA_ROOT` 指向隔离目录」，而脚本原先写死 `~/.lane-router`，`-CodexHost` 路径无法在不碰共享 Router 的前提下真跑 | 新加的 `-CodexHost` 路径只能未经真跑就交给部署 | 照脚本步骤手工执行（等于不验脚本本身） | 合并进现有脚本，默认值不变 | |
| 核心启动不再依赖 `codex` | 每次核心启动 | 推断，由互相等待成环直接导出 | 核心与宿主互相等待，谁也起不来 | 无 | 保留；在交接里列为行为变化 | |
| 看板 Codex 模型列表改为链路就绪后取 | 看板 | 推断，同上 | 核心启动时拿不到模型列表 | 无 | 保留 | |
| 宿主 `lastLifecycleAt` 随 `hello` 回填 `reach` | `lane_directory` | 推断：让 Codex 比 Claude 侧更早报 `live` | 核心重启后短时报 `unconfirmed`，与 Claude 侧记录一致 | 下一次 turn 自然补上 | 删除 | |
| 宿主崩溃后自动清理孤儿 app-server | 宿主崩溃时 | 推断 | 孤儿 app-server 继续占着端口和已加载的 thread；今天核心崩溃也一样 | `-CodexHost` 在有意重启时清理 | 暂缓（现状缺口，记入已知边界） | |
| app-server 永久失败时宿主自行退出 | app-server 连续重启失败时 | 推断 | 宿主保持 `failed`，与今天核心里的状态一致 | 重启宿主 | 暂缓 | |
| 新的 npm bin 或宿主管理命令 | 无 | 无 | 无 | ensure 与重启脚本 | 删除 | |
| 宿主优雅关闭 HTTP 端点 | 无 | 无 | 无 | 重启脚本连子进程一起停 | 删除 | |

没有临时验证入口。测试用的进程内装配是 `runCodexHost(options)` 和 `runRouterProcess` 的既有选项，不是新的公开入口。

## 5. 验收标准

每条都要有自动测试或真机记录；括号里是兜底方式。

1. 核心停止期间，经宿主 bridge 已建立的 TUI 连接仍能与 app-server 往返（发 `turn/start` 收到应答和通知）；同一期间该 thread 的 `item/tool/call` 在 1 秒内拿到 `ROUTER_UNAVAILABLE` 错误，核心与工具实现没有收到调用。核心再启动、宿主重连后，同一 thread 的工具调用成功。（进程内集成测试：真实核心装配加真实宿主装配，app-server 用 `tests/fixtures/codex/fake-app-server.mjs`；真机记录用真实 Codex TUI 与真实模型。）
2. 核心重启后，宿主在无人操作的情况下重连；重连前已 attach 的 lane 的 binding id 与 generation 不变；核心启动时已经 pending 的信，在宿主重连后对该 thread 发出一次 `turn/start`。（集成测试；真机记录。）
3. 调用途中核心退出，该调用以 `ROUTER_CONNECTION_LOST` 失败，错误文字说明结果未知。（集成测试。）
4. 宿主退出后，核心把 Codex lane 报为 `reach: no_channel`、`restorePresence: unavailable`，并 ensure 出一个新宿主，新宿主连上后恢复为 `offline` / `online`。并发调用 `ensureCodexHost` 只拉起一个宿主；`codex-host.lock` 被活进程持有时不 spawn；第二个宿主进程因锁退出。（单元测试加集成测试。）
5. 宿主启动日志按追加写；第二次拉起不覆盖前一次的内容，失败报告只取本次追加的部分。（单元测试。）
6. `lane-router-codex` 的新建、`resume`、`--profile`、`--model`、provider 与 transient 路径不回退；默认端点来自宿主 discovery，provider 端点来自宿主 HTTP 面。（修改现有 launcher 测试。）
7. `restorePresence` 在「链路断」「通且可见客户端为 0」「通且为 1」下分别是 `unavailable`、`offline`、`online`；`reach` 在「链路断」「通且未观测」「通且观测过」下分别是 `no_channel`、`unconfirmed`、`live`。看板恢复与 `lane-router-lane open` 用 `resumeInfo` 读到的就是这些值。（单元测试。）
8. 核心关闭不停宿主、不停 app-server；核心在没有可用 `codex` 的环境下照样启动并写出 discovery，Codex 能力报 `unavailable`。（集成测试。）
9. 账号 gate 被持有时，核心经链路发起的 `turn/start` 以 `ACCOUNT_SWITCH_IN_PROGRESS` 返回，核心侧 `notify` 得到 `deferred`；`thread/resume` 所有权：宿主已认领的直接放行，未认领的问核心，链路不通时拒绝。（单元测试。）
10. `hello` 版本号不被认可时，核心以 4001 关闭连接，宿主之后的工具错误带上这句原因。宿主与核心构建标识不同时，看板快照的 `codexHost` 两项不同且页面显示换代提示；相同或链路未连通时不显示。（单元测试与看板渲染测试。）
11. `/codex/host` 握手带 `Origin` 返回 403；宿主 `POST /codex/provider-endpoint` 保留与核心原入口相同的来源与内容类型守卫。（修改现有守卫测试。）
12. `npm test`、`npm run typecheck`、`npm run build` 全过；现有 Codex 相关测试只改不删。
13. 真机验收记入 `docs/manual-tests.md`，全程使用隔离的 `LANE_ROUTER_DATA_ROOT`。

## 6. 验证方法与变异检验

**自动测试**按第 5 节逐条写，先跑出红再实现。集成测试在同一测试进程里装配核心（`runRouterProcess`）和宿主（`runCodexHost`），共用临时 `dataRoot`，宿主的 app-server 命令指向 fake app-server；模拟 TUI 用一个直连宿主 bridge 的 WebSocket 客户端。这样不在测试里拉起 detached 进程，也不碰共享 Router。

**真机验收**只用隔离目录：`LANE_ROUTER_DATA_ROOT` 指向仓库外的临时目录，`CODEX_EXE` 指向本机真实 `codex.exe`，在本工作树 build 出的 `dist/` 上运行。

1. 用 `lane-router-codex` 起一个真实 Codex TUI（交互部分可用 `tests/fixtures/claude/pty-host.py` 同样的 pywinpty 方式驱动，不可用时由用户操作），attach 一条测试 lane。
2. 记下核心与宿主的 pid、两个 discovery 文件的内容。
3. 停核心（按隔离 discovery 的 pid，不碰共享 Router）。在 TUI 里发一句普通对话，确认有模型回复；让模型调 `lane_directory`，确认立即报错。
4. 用 `ensureRouter` 重启隔离核心；等宿主重连后让模型再调一次 `lane_directory`，确认成功、generation 不变。从另一条隔离 lane 发一封信，确认 TUI 被唤醒。
5. 用 `restart-router.ps1 -DataRoot <隔离目录> -CodexHost` 重启宿主，确认 TUI 断开属预期、`resume` 后恢复。
6. 结束时停掉隔离核心、宿主及其 app-server，核对共享 Router 的 pid 与 `~/.lane-router` 未被改动。

**变异检验**（每项改回后对应测试必须变红）：

| 变异 | 应变红的验收 |
|---|---|
| 宿主工具调用在链路断开时改为等待重连 | 1（1 秒内报错） |
| 核心关闭时恢复停 app-server | 8 |
| 去掉 `hello` 后的处理机会补发 | 2（pending 不提醒） |
| ensure 去掉 `codex-host.lock` 活进程检查 | 4（重复 spawn） |
| 日志改回覆盖写 | 5 |
| `restorePresence` 不看链路状态 | 7 |
| 链路请求绕过账号 gate | 9 |
| bridge 恢复同步 `ownsThread`、不问核心 | 9（未认领 thread 的 `resume` 判错） |
| 不校验 `protocolVersion` | 10 |
| 看板提示改为恒不显示 | 10 |

## 7. 已知边界与不做

- 宿主崩溃（不是经脚本停止）原先估计会留下孤儿 app-server。2026-10-19 真机观测（codex 0.154.0，单机）：宿主被硬杀后，它的 app-server 在 200 ms 内自行退出，两次都是这样。所以这个风险比原先估的低，但这是观测，不是 Codex 承诺的行为；`-CodexHost` 仍连子进程一起清理，作兜底。
- 宿主的 app-server 进入 `failed` 后宿主不自行退出，与今天核心里的状态一致，需要重启宿主。登记为 Vikunja #316（以后做）。
- 宿主不做成 Windows 服务或开机任务；共享 Router 的部署与重启归 `lane-router/design` 与用户。
- 不改 Claude、ZCode、DSH、native-codex 后端的语义；不做动态工具热刷新；不动 lane 工具、账号切换功能本身、图资源与议题模块。
- 隔离验收里的宿主仍使用用户真实的 `CODEX_HOME`（与 `TC-LANE-BATCH-CODEX` 相同），测试 thread 会留在本机 Codex 会话记录里。
