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

后台在自己的目录内写 `connection.json`。该文件含运行端连接凭据，供同一 Windows 用户的本机后端读取；不能复制到网页、聊天、日志或仓库。模型凭据由官方 Codex keyring 保管，不在这个 JSON 中。

首次部署时，外部运行人员在约定的空闲窗口接入两端。Router 启动环境设置：

```powershell
$env:LANE_ROUTER_ACCOUNTS_CONNECTION = Join-Path $env:USERPROFILE '.lane-router-accounts\connection.json'
```

Company 使用它的接入候选，将同一路径传给 `startCompanyRouter({ accountConnectionFile })`。Company 和 Host 的准确提交与启动参数以部署交接为准，不能把这项配置加到尚未实现该入口的旧版本。已有进程不会因修改环境变量自行接入。首次安装可能需要空闲重启；日常换号不要求重启。

## 日常使用

1. 打开账号页，点“添加账号”。后台打开官方授权页面，用户自行完成登录。
2. 回到账号页，选择显示的脱敏邮箱及工作区，点“同步切换”。添加授权本身不会切换运行端。
3. 等待现有回合结束。页面分别显示 Company 和 Codex lane 的状态；两边核实成功后显示“全部已同步”。

后续已保存的账号可直接选择。授权失效时，选中该账号点“重新授权”；如果登录了另一个用户或工作区，后台会拒绝替换。需要增加另一身份时使用“添加账号”。同邮箱不代表同一账号，后台按用户与工作区共同区分。

不要在已接入运行端的 TUI 中单独执行登录或登出。统一账号模式会拒绝这些入口以及普通客户端的令牌导出请求。独立启动、没有接入 Router 的 CLI 不在统一切换范围内。

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

`src/accounts/` 分离后台业务、运行端接入和网页。五个可复用运行端模块是 `contracts.ts`、`identity.ts`、`peer-rpc.ts`、`switch-gate.ts`、`consumer.ts`。Company owned Host 与 Router 各使用一个长期 `AccountConsumer`；临时诊断连接不能充当刷新拥有者。

- `AccountConsumer.start()` 非阻塞并立即关闭接纳；后台核实后释放。Host 在第一次通知派发前启动 consumer，Company 首次创建 Lead 前等待同一门就绪。
- 所有模型入口使用同一 `AccountSwitchGate`，覆盖 TUI、后台通知、Company 直接输入与队列。受控入口包括 turn、review、compact、thread 建立/恢复，以及 queue/goal 修改。
- Company 在 claim 前调用 `withAdmission(method, async admission => ...)`，作用域覆盖异步 route 检查、必要的 resume 和最终 RPC。已接纳的请求可以在切换等待期间完成穿过 Host。
- 私有顶层 JSON-RPC 字段为 `accountAdmissionToken`。Host 验证其仍处于同一个 gate 的有效作用域，剥除后才转发官方 app-server；不能放入 params、日志或持久输入，不能用于作用域结束后的订阅请求。
- `enter()` 返回的结束函数在可信响应后调用；丢失响应先调用该函数的 `markUncertain()`。它限定于原进程代际，避免迟到的错误污染替换后的进程。明确未知效果后，即使原作用域令牌仍有效也不能继续派发。
- 长期 raw owner 接收 `account/chatgptAuthTokens/refresh`，交 `consumer.refresh()`；普通客户端无法导出令牌。刷新只允许实际绑定的用户及工作区，不能用目标账号代替尚未切换的运行端身份。
- `runtimeChanged(false)` 处理普通断链；只有确认 app-server 进程已替换才用 `runtimeChanged(true)`。认证应用尚未完成或效果未知时，身份读取、准备和刷新都拒绝，不把 RPC 超时当作远端取消。

页面只获取脱敏元数据和固定错误码。HTTP 仅监听 IPv4 回环地址，校验 Host；写请求要求同源 Origin、JSON 和固定操作头。内部 WebSocket 使用受限文件内的随机连接凭据，拒绝带浏览器 Origin 的升级请求。信任边界是同一 Windows 用户及其本机进程，不支持远程、多用户或跨机器账号管理。

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
