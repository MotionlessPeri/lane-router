# 本机统一账号切换

`lane-router-accounts` 提供独立账号页。用户通过官方 ChatGPT 页面授权后，可以保存多个账号，再将 Company 和 Router 管理的 Codex lane 切到所选账号。切换等待正在运行的回合结束，保留会话与任务绑定；只有两边读回身份一致才显示“全部已同步”。

此功能需要三个组件共同接入：账号后台、Router、Company owned Host。只安装账号页不能让未接入的 Company 自动切换。后台停止时，已接入的运行端保持当前回合，暂停接纳新回合。

## 安装和启动

部署人员在独立安装目录构建，不在共享主工作树构建。需要 Node.js 22.12 及以上，Windows NTFS 本地目录和可用的系统凭据库。

```powershell
npm ci
npm run build
node .\dist\accounts\main.js --codex-exe 'C:\path\to\codex.exe'
```

后台默认监听 `http://127.0.0.1:47839`，启动时打印实际页面地址。默认数据目录为 `%USERPROFILE%\.lane-router-accounts`，可用 `--root <absolute-path>` 和 `--port <number>` 覆盖。该目录及其祖先不能是符号链接或目录联接。后台拒绝无法限制权限的目录，不自动降低凭据保护要求。

后台在自己的目录内写 `connection.json`。该文件含运行端连接凭据，供同一 Windows 用户的本机后端读取；不能复制到网页、聊天、日志或仓库。Codex 的模型凭据由官方 Codex keyring 保管，不在这个 JSON 中。Claude 账号的 setup token 存在同一受限目录的 `claude-profiles.json` 里（Claude Code 没有可供后台使用的 keyring），只用来读各账号的余量，见下文「Claude 账号余量」。

### 持续运行与故障恢复

部署时使用独立监督入口，以便账号后台退出后自动恢复：

```powershell
node .\dist\accounts\supervisor.js --root 'E:\path\to\account-state' --port 47839 --codex-exe 'C:\path\to\codex.exe'
```

监督进程只管理自己启动的账号后台，不停止 Router、Company 或其他账号进程。每个数据目录只允许一个监督者，账号后台仍使用原有单实例锁。后台退出后首次等待 2 秒再启动；连续快速退出时退避至最多 30 秒，稳定运行 30 秒后恢复初始间隔。启动、Windows ACL 核实和 consumer 重连也需要时间，因此 2 秒不是完整恢复耗时的保证。配置错误不会触发无间隔重启。

后台 stdout/stderr 追加到受限数据目录的 `service-stdout.log`、`service-stderr.log`，重启保留旧记录。登录失败记录固定阶段和错误码，不记录原始 RPC 错误、OAuth URL 或凭据。当前没有日志轮转；部署人员按实际大小维护。停止监督者会停止其自有后台；监督者本身退出后没有第二层看门狗，本命令也不会自动注册 Windows 开机任务。

旧后台已运行时，由外部部署对话在约定窗口停止旧实例，再以相同 root 和端口启动监督入口。不要另开一个数据目录来绕过锁。后台重启会重新生成内部连接凭据；consumer 每次重连重读原连接文件，不需要修改 Router gate 或重启 Router。后台断线期间，原有 gate 保护保持生效。

### 登录失败、取消与未登记目录

每次授权都使用新 slot，只有身份核实及元数据事务成功才登记到 profiles。失败、取消或超时不会增加该 profile，也不会选择新账号或覆盖原有账号。登录拥有者的清理异常会被记录并收口，不再作为未处理 Promise 拒绝杀死整个后台；持久化成功的替换结果在清理旧拥有者前进入内存，避免清理异常使磁盘与内存指向不同账号。

未登记 slot 可能来自取消、失败或进程异常退出。当前策略是保留并隔离：初始化不把它们导入 profiles，后续授权另建 slot，不调用可能撤销有效授权的 `account/logout`。目录中没有 `secrets` 不能证明系统凭据库没有授权，不能据此自动递归删除。清理仅由维护人员在后台停止、核实所有者已退出、确认目录未被 profiles 引用且不含需保留的本机授权后进行；当前功能不包含自动凭据库清理。诊断只读目录/引用元数据，不读取或输出凭据内容。

首次部署时，外部运行人员在约定的空闲窗口接入两端。Router 一侧的 consumer 在 Codex 宿主进程里（2026-10-19 起 app-server 归宿主所有，见 [Codex 宿主独立进程](superpowers/specs/2026-10-19-codex-host-process.md)），所以要设在宿主的启动环境里。宿主由 Router 核心或 `lane-router-codex` 拉起，继承拉起方的环境；最稳妥的是设成用户级环境变量，再用 `restart-router.ps1 -CodexHost` 换代宿主：

```powershell
$env:LANE_ROUTER_ACCOUNTS_CONNECTION = Join-Path $env:USERPROFILE '.lane-router-accounts\connection.json'
```

也可以写进 Router 数据目录的 `config.json` 的 `accounts.connectionFile`，核心和宿主读同一份配置。Company 使用它的接入候选，将同一路径传给 `startCompanyRouter({ accountConnectionFile })`。Company 和 Host 的准确提交与启动参数以部署交接为准，不能把这项配置加到尚未实现该入口的旧版本。已有进程不会因修改环境变量自行接入。首次安装可能需要空闲重启宿主；日常换号不要求重启。

## 日常使用

1. 从 Lane Router dashboard 顶部的“账号切换”打开账号页，或直接访问 `http://127.0.0.1:47839/`。导航使用固定默认端口；自定义 `--port` 时使用后台打印的页面地址。点“添加账号”后，后台打开官方授权页面，用户自行完成登录。
2. 回到账号页，按完整邮箱及工作区选择目标，点“同步切换”。添加授权和在页面上选中目标本身不会切换运行端。
3. 等待现有回合结束。页面分别显示 Company 和 Codex lane 的状态；两边核实成功后显示“全部已同步”。

后续已保存的账号可直接选择。授权失效时，选中该账号点“重新授权”；如果登录了另一个用户或工作区，后台会拒绝替换。需要增加另一身份时使用“添加账号”。同邮箱不代表同一账号，后台按用户与工作区共同区分。

“运行端当前账号”分别显示 Company 和 Codex lane 实际读回的身份，匹配的已保存账号标注对应运行端“正在使用”；选中按钮的边框只表示待切换目标。尚未执行过同步切换也会读取当前身份，当前账号没有保存在此页时仍可显示身份，但不能借此向它提供其他账号的刷新凭据。页面读取不触发登录、切号、令牌刷新或等待回合；慢读取不阻塞页面，读取失败或断线会清除失效显示。实际身份缺少邮箱时，已匹配的保存账号提供邮箱显示。

不要在已接入运行端的 TUI 中单独执行登录或登出。统一账号模式会拒绝这些入口以及普通客户端的令牌导出请求。独立启动、没有接入 Router 的 CLI 不在统一切换范围内。

## Claude 账号余量

账号页下方的「Claude 账号余量」一节列出已添加的 Claude 账号，以及每个账号 5 小时窗口与 7 天窗口各用掉了多少、何时重置、何时读的。它只显示，不切换：Claude Code 没有从外部给运行中的会话换号的办法，要换号就在 lane 窗口里 `/login`。

1. 对每个要看的 Claude 账号，在终端运行一次 `claude setup-token`，在打开的浏览器页面授权，复制它输出的 token（以 `sk-ant-oat` 开头）。
2. 在账号页点「添加 Claude 账号」，填一个邮箱（只用来在页面上区分账号，后台不核对）并粘贴 token，点「保存」。token 只在这一次请求里经过网页，页面和 `/api/state` 都不再含它。
3. 点账号行的「刷新」（或「全部刷新」）。后台用该账号跑一次极小的非交互会话，几秒后这一行显示读数。没读过的账号显示「未查询」。

读法：后台以该账号运行 `claude -p "Reply with exactly the single word ok" --model haiku --output-format stream-json --verbose`，从输出里最后一个 `rate_limit_event` 的 `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` 取数。这个会话：

- token 经 `CLAUDE_CODE_OAUTH_TOKEN` 传入，`CLAUDE_CONFIG_DIR` 指向后台受限目录里该账号自己的 `claude-config\<账号 id>`，工作目录也是它，**不读写用户的 `~\.claude`**。
- 后台进程自己继承的 `CLAUDE*` 变量与 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 都不传给它，免得读到别的账号。
- 程序用 `CLAUDE_EXE` 指定；没指定时用 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（PATH 上的 `claude` 是 `.cmd`，后台不经 shell 启动不了它）。
- 2 分钟没结束就终止，记为超时。

边界：

- 每次刷新花该账号一点点额度，所以只在点按钮时读，不定时轮询。同一账号已在读时再点不会重复发起。
- 余量字段来自 Claude Code 非交互输出，**不在官方稳定接口清单里**；CLI 升级可能改格式，读不到时这一行显示「没有余量信息」，需要跟着改读法。
- 读失败（token 失效、超时、找不到 claude）只记在该账号上，保留它上一次成功的读数，不影响别的账号。
- token 一年到期。页面不提醒到期；到期后刷新会报错，重跑 `claude setup-token`，删掉旧账号再添加新的。
- 删除账号会一并删掉它的 `claude-config` 目录。

存储：

| 位置（都在后台的受限数据目录） | 内容 |
|---|---|
| `claude-profiles.json` | `{ version: 1, selectedId: null, profiles: [{ id, email, token, createdAt, usage?, usageError? }] }`。`usage` 是最近一次成功读数，`usageError` 是此后最近一次失败。`selectedId` 恒为 `null`，只为让 2026-10-19 那版仍能读这个文件 |
| `claude-config\<账号 id>\` | 读余量时该账号的 Claude 配置目录 |

文件用与 `connection.json` 相同的 owner + SYSTEM ACL 原子写出。2026-10-19 曾有一版在开 Claude 窗口时按页面上选中的账号注入 token（`d93c8fa`），因只对新开窗口生效、帮不上「工作到一半换号」而回退。那一版留下的 `claude-launch.json` 在后台启动时删除，它保存的账号原样留用。

后台要重启到含此功能的构建，页面才有这一节。

## 状态与恢复

| 页面情况 | 行为及处理 |
|---|---|
| 等待现有回合 | 新回合暂缓接纳，当前回合继续。首次应用前可取消等待；恢复部分切换时不能取消后放开不一致账号。 |
| Codex 内部队列非空或活动目标 | 本次准备失败，尚未应用且两端原先一致时恢复接纳。待队列或目标结束后重试。Company 尚未派发的 FIFO 保留，切换后沿原调度器继续。 |
| 有运行端离线 | 不显示全部同步。恢复对应运行端连接后重新核实；不会自动重启服务或重放输入。 |
| 一边已切换、一边失败 | 两端继续暂停新回合，页面显示分别的结果。再次同步目标账号，全部核实后才恢复。 |
| 授权失效 | 对对应保存账号重新授权，再重试同步。 |
| 认证或模型请求结果未知 | 保持暂停。普通重连和取消不能抹掉未知效果；由外部运行人员确认并替换对应 app-server 进程后再恢复。不要直接重放原输入。 |
| 账号后台停止 | 原运行回合继续；新回合暂停。重启后台后读取已保存的目标，并等待两端重新核实。 |

重新授权会关闭旧登录拥有者，保留其不再使用的系统凭据库条目。当前没有账号删除或凭据库清理功能；不能用官方 `account/logout` 代替本机清理，因为它可能撤销仍在使用的授权。

## 接入契约

`src/accounts/` 分离后台业务、运行端接入和网页。五个可复用运行端模块是 `contracts.ts`、`identity.ts`、`peer-rpc.ts`、`switch-gate.ts`、`consumer.ts`。Company owned Host 与 Router 各使用一个长期 `AccountConsumer`；Router 的那一个（`id` 仍为 `"router"`）随 app-server 的原始连接一起在 Codex 宿主进程里，核心经宿主链路发起的模型请求同样先过这道 gate。临时诊断连接不能充当刷新拥有者。

- `AccountConsumer.start()` 非阻塞并立即关闭接纳；后台核实后释放。Host 在第一次通知派发前启动 consumer，Company 首次创建 Lead 前等待同一门就绪。
- 所有模型入口使用同一 `AccountSwitchGate`，覆盖 TUI、后台通知、Company 直接输入与队列。受控入口包括 turn、review、compact、thread 建立/恢复，以及 queue/goal 修改。
- Company 在 claim 前调用 `withAdmission(method, async admission => ...)`，作用域覆盖异步 route 检查、必要的 resume 和最终 RPC。已接纳的请求可以在切换等待期间完成穿过 Host。
- 私有顶层 JSON-RPC 字段为 `accountAdmissionToken`。Host 验证其仍处于同一个 gate 的有效作用域，剥除后才转发官方 app-server；不能放入 params、日志或持久输入，不能用于作用域结束后的订阅请求。
- `enter()` 返回的结束函数在可信响应后调用；丢失响应先调用该函数的 `markUncertain()`。它限定于原进程代际，避免迟到的错误污染替换后的进程。明确未知效果后，即使原作用域令牌仍有效也不能继续派发。
- 长期 raw owner 接收 `account/chatgptAuthTokens/refresh`，交 `consumer.refresh()`；普通客户端无法导出令牌。刷新只允许实际绑定的用户及工作区，不能用目标账号代替尚未切换的运行端身份。
- `runtimeChanged(false)` 处理普通断链；只有确认 app-server 进程已替换才用 `runtimeChanged(true)`。认证应用尚未完成或效果未知时，身份读取、准备和刷新都拒绝，不把 RPC 超时当作远端取消。

页面只获取展示元数据和固定错误码：邮箱完整显示，工作区使用指纹，内部用户/账号键与授权令牌不返回浏览器。HTTP 仅监听 IPv4 回环地址，校验 Host；写请求要求同源 Origin、JSON 和固定操作头。内部 WebSocket 使用受限文件内的随机连接凭据，拒绝带浏览器 Origin 的升级请求。信任边界是同一 Windows 用户及其本机进程，不支持远程、多用户或跨机器账号管理。

## 验证

```powershell
npm run typecheck
npm test -- --reporter=dot --maxWorkers=4
npm run build
node .\scripts\verify-account-protocol.mjs 'C:\path\to\codex-0.163.0.exe' 'C:\path\to\codex-0.161.0.exe'
```

协议脚本只使用临时隔离目录、合成令牌和本地模型 fixture，不读取用户凭据。实际 Codex 0.163.0 与 0.161.0 均已通过：同一 thread 使用 A、切换 B，再收到 401 后以 B 的刷新结果重试，请求身份标签为 `a/b/b/refreshed`。测试还检查官方 external auth 下旧登录入口的拒绝行为。

最终候选限制 4 个测试 worker 后，整体自动测试为 797 项通过、1 项跳过；跳过项是默认不运行的官方 stdio 启动冒烟，已单独对两个指定版本运行通过。默认并行的一次复跑中，既有 `native-shared-integration` 的进程恢复用例超出 5 秒；没有修改该用例或放宽截止时间。构建产物已在全新未登录目录启动，验证单实例锁、空状态和三项静态资源。浏览器工具在本次环境没有可用实例，页面视觉和真实授权交互尚未验收。

另有跨仓组合证据：Company `52fea8d` 的实际启动入口、Host `6e04aca` 和此后台，通过真实认证 WebSocket/HTTP 完成初次 A 同步、页面 API 切 B、同一 Lead 的原输入触发合成 401 刷新；两次应用、一次刷新后保持原 thread 和绑定。Host 验证提交 `db9f787` 保存这一条组合测试及两个 fixture。其上游是固定协议进程，不能替代官方二进制探针或真实账号部署验收。

外部部署验收须再次核实：页面一次真实授权；两端绑定和原 thread 不变；忙碌回合自然结束；切换后两边同一账号；过期刷新可继续；断线时不会显示全部完成。合成测试与构建成功不代表已经上线。官方 external auth 是实验接口，本次兼容证据仅覆盖上述两版。

### 登录清理与监督回归（2026-10-18）

`tests/fixtures/account-login-cleanup.ts` 在独立 Node 进程内完成合成账号 A，再令第二次登录失败且拥有者清理拒绝。旧代码从 `runLogin` 的 `finally` 逃出未处理拒绝，进程退出码 1；修复后退出码 0，原 profile 保留。该受控复现证明清理错误路径，不证明无历史 stderr 的现场退出必由同一原因造成。

账号相关测试分批覆盖 91 个不同用例：常规账号回归 88 项通过，默认跳过的官方初始化冒烟另行执行；随后补充官方连续登录启动/取消与替换清理回归，最终聚焦回归 35 项通过。官方 Codex 0.161.0 的两项隔离冒烟通过，没有打开浏览器或授权真实账号。

`tests/accounts/supervisor.test.ts` 会从当前源码独立构建并实际启动后台，不依赖已有 dist。对照组杀死后台后仍离线；监督组杀死自有后台后重启，连接文件轮换、两个真实 consumer 重连、断线 gate 关闭及恢复后 turn 准入均通过。模型请求上游为合成响应，不是生产 Codex 模型验收。真实两账号完成 OAuth、生产 47839 的监督部署及生产 turn 恢复仍需外部部署对话和用户官方授权共同验收。
