# Lane Router V1 手工验证

自动测试覆盖五项工具、文件 mailbox、SQLite 对账、Claude Channel transport、Codex App Server 协议、按需启动与 launcher 参数。下面各项只验证真实 CLI、模型 provider 和交互式 TUI 的边界，不能用 fake backend 结果代替。

## Claude Channel

前提：已构建 `dist/`，Claude CLI 已启用 Lane Router stdio MCP，并为 `UserPromptSubmit` 与 `Stop` 配置 `dist/adapters/claude/lifecycle-hook.js`。启动 Claude 时启用 `server:lane` Channel。

1. 在新对话调用 `lane_directory`，说明建议并取得用户确认，然后调用 `lane_attach_current`。
2. 从另一条已绑定 lane 发送 normal 消息，确认 Claude 自动获得一次处理机会，并直接读取通知给出的 `pending` 目录。
3. 在 Claude turn 运行期间发送 correction，确认它排入下一 turn，而不是声称 steer 当前 turn。
4. 用一次 `lane_ack` 批量 resolve 已处理消息，确认文件进入 `resolved`。
5. 退出 Claude，再发送一条消息；恢复同一 Claude session 后确认 pending 消息再次得到提醒。
6. 在旧 turn 运行期间从新对话请求接替同一 lane，确认接替等待 `Stop`，随后 generation 增加且旧 session 不能再发送或 ack。

预期：MCP 只列出 `lane_directory`、`lane_attach_current`、`lane_send`、`lane_ack`、`lane_restore_project`。MCP 进程使用 Claude 自动提供的 `CLAUDE_CODE_SESSION_ID`；hook 的 `session_id` 与它对应。通知不携带消息正文，正文只在 mailbox 文件中。

## Codex remote TUI

前提：已构建 `dist/`，`codex --version` 与实验性 App Server schema 检查通过。

1. 运行 `lane-router-codex`，确认它按需启动 Router process、打开 stock Codex remote TUI，并由本地 adapter 在 TUI 的 `thread/start` 中注入五项 dynamic tools；不得先创建空 thread 再 resume。
2. 在对话中查询目录、取得用户确认并 attach 一条 lane。
3. 从另一条 lane 发送 normal 消息。目标 idle 时应由 `turn/start` 唤醒；busy 时应保持 pending，直到 turn 完成事件提供下一次处理机会。
4. 在目标 busy 时发送 correction，确认 App Server 使用 `turn/steer`，且通知只包含 mailbox 路径和 message ID。
5. 退出 TUI 后发送一条消息，确认文件保持 pending。
6. 运行 `lane-router-codex resume <thread-id>`，确认恢复完整 thread 历史，并再次提醒 pending mailbox。

预期：launcher 不提供注册、状态、诊断或管理子命令。Router discovery 只含 PID、loopback 地址、Codex endpoint 与 instance ID。

### Codex launcher 工作目录

**目标：** 验证新 thread 使用调用 `lane-router-codex` 时的目录，不继承长期 Router process 或共享 App Server 的启动目录。

**Fixture：** 一个不在 Lane Router worktree 内的 Git 仓库，例如 `D:\my_projects\agent_coding_guidelines`。

**步骤：**

1. 构建待验证 commit，确保 npm link 指向的 `dist/process/codex-launcher.js` 已更新。本修复只修改 launcher，不需要重启 Router process。
2. 在 fixture 仓库根目录运行 `lane-router-codex`，创建新 thread；不要使用 `resume`。
3. 在新 conversation 中运行 `Get-Location` 和 `git rev-parse --show-toplevel`。
4. 读取该 thread rollout 第一行的 `session_meta.payload.cwd`。

**预期：** 三处路径都指向调用 launcher 的 fixture 仓库；任何一处指向 Lane Router 的 `build-v1` worktree 都算失败。`resume` 继续使用原 thread 已保存的工作目录，不以当前 shell 目录覆盖它。

**最后验证：** 2026-08-08 在 `444c6e3` 上通过。修复前已在 `196f61a` 上复现错误：guidelines thread 的 workspace root 是 `D:\my_projects\agent_coding_guidelines`，但 session cwd 是 Lane Router `build-v1`。修复后从该 guidelines 仓库启动的新 thread 以 generation 2 接替原 binding；rollout cwd 与 Git top-level 都是 `D:\my_projects\agent_coding_guidelines`。

### Windows system proxy 的 Codex WebSocket

**目标：** 验证调用 shell 没有显式代理变量时，新 Router 会继承已启用的静态 Windows system proxy，使 shared App Server 的 Responses WebSocket 不再退回 HTTPS。

**Fixture：** Windows system proxy 指向正在运行的 HTTP CONNECT 代理；Codex 0.147 可以通过该代理访问 `chatgpt.com`。本机验证使用 Clash Verge/mihomo `127.0.0.1:7897`，该地址不是产品默认值。

**步骤：**

1. 构建待验证 commit，确认 npm link 指向更新后的 `dist/process/codex-launcher.js`。
2. 确认没有其他用户连接 Router。读取 `~/.lane-router/discovery.json` 中的 PID，核对该进程确为当前 Router 后受控停止；不要硬编码历史 PID。
3. 新开 PowerShell，删除当前 shell 的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，确认 Windows Internet Settings 中 `ProxyEnable` 为 `1`，`ProxyServer` 是当前有效的静态代理。
4. 从该 PowerShell 运行 `lane-router-codex`，让 launcher 创建新的 Router、shared App Server 和 Codex TUI。
5. 发起一个真实 Codex turn，检查日志中没有 Responses WebSocket timeout、Windows `10054` 或 HTTPS fallback；同时确认本地 Router WebSocket 仍可连接。

**预期：** 新 Router 自动把 system proxy 转成 `HTTP_PROXY` 和 `HTTPS_PROXY`，并让 `NO_PROXY` 包含 `localhost` 与 `127.0.0.1`。真实 turn 直接使用 Responses WebSocket。已经运行的 Router 不会被 launcher 自动重启或更新环境。

**最后验证：** 2026-08-08 在 `d7c3f8c` 上由用户通过真实 `lane-router-codex` 新 conversation 验证。调用 shell 未手动设置代理变量；Codex WebSocket 正常连接，没有再次出现连接失败、`10054` 或 HTTPS fallback。修复前，environment-validation 已在同一环境复现 timeout/`10054`，并验证手动设置标准代理变量后可以成功。

### Router 不随启动它的会话一起死

**目标：** 直接回答「结束一条会话，Router 活不活」。这是 gap B 唯一无法自动化的一步——自动测试用真实进程验过启动器的机制（对照组被杀、处理组存活），但「Claude Code 关闭 MCP server 走的是不是杀树」只能由真实会话回答。

**前提：** 已构建 `dist/`，且所有旧 Router 已停止（按 `discovery.json` 的 pid 核对后停止，不要硬编码历史 pid）。

**步骤：**

1. 只开一条会话，调一次任意 lane 工具，让它冷启动 Router。
2. 记下 Router 的 pid 与 ppid：

   ```powershell
   $pat = 'dist' + [char]92 + 'process' + [char]92 + 'ma' + 'in.js'
   Get-CimInstance Win32_Process |
     Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$pat*" } |
     ForEach-Object { 'pid={0} ppid={1}' -f $_.ProcessId, $_.ParentProcessId }
   ```

   确认那个 ppid 对应的进程**已经不存在**（`Get-Process -Id <ppid>` 查不到）——它是已经退出的启动器。
3. 另开一条会话并 attach 一条 lane，作为观察者。
4. 结束第 1 步那条会话。
5. 检查 Router 的 pid 是否仍在；从观察者那条会话发一条消息，确认通知照常。

**预期：** Router 存活，观察者发送成功。

**失败时的含义（重要）：** 若 Router 仍随会话消失，说明 MCP server 的关闭路径**不是**杀树（例如用了带 kill-on-close 的 Job 对象）。此时**不要去加启动器的层数**——三组对照实验已经排除该方向（中间进程只要还活着，孙进程照样被杀，多一层不改变这一点）。应当回来重新取证。

### Router 启动失败诊断

**目标：** 新 Router 在 ready 前退出时，`lane-router-codex` 显示子进程 stderr，而不是等待 15 秒后只报告 `Router process did not become ready`。

**最后验证：** 2026-08-08 在本提交上使用独立临时 data root，把当前 probe PID 写入 `router.lock` 后调用构建产物的 `ensureRouter`。真实 detached Router 在 219ms 后返回 `Router process failed: Another Router process is already running`。验证没有连接、停止或重启用户正在使用的 Router；其 instance ID 保持不变。

2026-08-10 加入启动器之后按同样方式复验：同一句原文在 **490ms** 后返回，`router-start.log` 已写入。多出的时长是启动器那一次 Node 启动。这条用例现在同时覆盖「Router 的 stderr 经由启动日志而非直连管道回到调用方」这条新链路。

### 带原因的健康检查：真实客户端才能验的两类原因

自动测试覆盖了四种通知结果、`reach` 三态、schema 1 → 2 迁移，以及「记录结果不改变投递时机」这条不变量。下面两类原因依赖真实 Claude 客户端与真实 hook，fake backend 代替不了。

**前提：** 已构建 `dist/`，Router 进程已重启到包含本改动的版本（`lane_directory` 返回 `binding` 与 `reach` 两个字段即说明生效）。

#### 组织策略在客户端丢弃通知

**目标：** 通知发得出去、但从来没有引发 turn 时，`reach` 能把它跟「链路正常」分开。

**步骤：**

1. 确认 `C:\Program Files\ClaudeCode\managed-settings.json` 当前是 `{ "channelsEnabled": true }`，目标会话在运行且已 attach 一条 lane。
2. 临时把该文件改名（需管理员），重启目标会话，让它在 channel 被关掉的状态下重连。
3. 从另一条 lane 发一条 normal 消息。
4. 调 `lane_directory`，看目标 lane 的 `reach`。

**预期：** 消息的 `notification_state` 是 `sent`（帧确实发出去了），而 `reach.lastNotifiedAt` 持续前进、`reach.lastLifecycleAt` 始终停在通知之前或为空。判据是这两个时间戳的先后，不是任何单一字段。恢复该文件并重启会话后，`lastLifecycleAt` 应重新跟上。

#### 身份分叉：channel 身份与 lifecycle 身份不一致

**目标：** 验证 `unconfirmed` 能标出这种状态；同时这是**验证成因假说**的机会。

**背景（2026-08-10 已查明成因，此前的假说是错的）：** 分叉**不是**「中途重连 MCP server」引起的，干净的会话启动就会发生——MCP server 拿到的 `CLAUDE_CODE_SESSION_ID` 跟会话其余部分（Bash 工具、hook）看到的不是同一个值。实测同一条对话里两者并存：hook 侧 `bb75097f…`，MCP server 侧 `ce334584…`。设计与修法见 `specs/2026-08-10-durable-conversation-identity.md`。

**步骤（验证 join 是否修好了它）：**

1. 一条已 attach 的会话，记下 `lane_directory` 给出的 `binding.generation`。
2. 重启这条会话，**不要**重新 attach。
3. 让它跑一个 turn（随便发一句话），使 hook 上报一次。
4. 再调 `lane_directory`。

**预期：** `binding.generation` 未变、`reach.state` 为 `live`。此时从另一条 lane 发一条消息，目标应能收到。**若 generation 变了或 `reach` 是 `no_channel`，说明 join 没成**——检查 hook 是否仍在 `settings.json` 里、以及 `CLAUDE_PID` 在 hook 进程中是否存在。

**放行卡死的接替：** 分叉状态下 `waitUntilReplaceable` 会一直等。对**确知空闲**的那条会话报一次 Stop 即可放行：

```bash
curl -s -X POST http://127.0.0.1:<port>/claude/lifecycle \
  -H "content-type: application/json" \
  -d '{"conversationId":"<binding 里的 id>","event":"Stop"}'
```

返回 `{"accepted":true}` 说明 Router 确实持有那条连接；拿一个不存在的 id 作对照应返回 `false`。只在确知目标没有在跑 turn 时用，否则可能让接替落在别人的 turn 中间。

#### 判别路径整体走通

对当前每条 lane 各调一次 `lane_directory`，按设计稿《带原因的健康检查》的判别流程图核对给出的原因与实际情况一致。这一步是人按图判断，没有机器 oracle。

### Router 被换掉之后，已开着的会话不必轮换

**目标：** 直接回答「Router 换了，别的会话还能不能用 lane 工具」。这是 RPC 重新解析唯一无法自动化的一步——自动测试用两个真实 HTTP 服务器和一次真实的拒绝连接验过客户端侧的机制，但「一条真实 Claude 会话的 MCP server 能不能跟过去」只有真实会话能回答。

**前提：** 已构建 `dist/`，且**参与验证的会话都是构建之后新起的**。这一条不能省：MCP server 的代码在进程启动时就已载入，构建之前起的会话仍然跑旧代码，拿它验只会验出旧行为。

**步骤：**

1. 起一条新会话并 attach 一条 lane，调一次 `lane_directory` 确认正常，记下 `~/.lane-router/discovery.json` 里的 `pid` 与 `url`。
2. 按那个 pid 停掉 Router（不要硬编码历史 pid）。
3. 在**同一条**会话里再调一次 `lane_directory`。
4. 重新读 `discovery.json`。

**预期：** 第 3 步直接成功返回，不需要重启或轮换这条会话；第 4 步读到的 `url` 与第 1 步不同，说明它接的是接替者而不是原来那个。若第 3 步报 `fetch failed`，就是本修复没生效——先确认这条会话确实起于构建之后。

⚠️ **这一步验不掉通知路径，别顺手当它也过了。** 本条只证明 RPC 跟过去了。**通道是另一条重连路径，2026-08-25 实测它没跟过去**——见下面那条独立记录。

**已于 2026-08-18 验证。** 借 lane open/new 真机验收的受控重启完成：一条构建后新起的真实 Claude 会话在 Router 两次被替换（pid 27528 → 40724 → 5836，`discovery.json` 的 url 每次变化）后，同一会话的 `lane_directory` 直接成功返回，无需重启或轮换该会话；期间 6 条在线 lane（均为当日新起会话）保持可用。原记录保留供背景——2026-08-12 实现当天没有跑这条：当时另外 10 条 lane 全部运行构建之前的代码，停 Router 会把它们一起打断。

**2026-08-25 再次确认（第二次）。** 受控重启：两个 Router（5836 与孤儿 32808）一并停掉、起新的 71528（url 由 `:52784` 变为 `:50579`）；同一条 08-25 20:30 起的会话随后调 `lane_directory` **直接成功**，无需重启或轮换。

**顺带一条环境限制：** Router 启动时无条件要求一个能用的 `codex`（`main.ts` 的 `await codex.start()` 在服务器启动之前）。在拿不到 `codex` 的 shell 里起不了 Router；2026-08-12 与 08-25 两次都以 `Unable to fingerprint Codex executable/version` 退出。**2026-08-25 找到了它**：`C:\Users\xiedong\.codex\.sandbox-bin\codex.exe`（`codex-cli 0.144.2`），不在 PATH 上。⇒ 要从这类 shell 起 Router，设 `CODEX_EXE` 指向它即可（`main.ts` 读 `CODEX_EXE ?? "codex"`），已实测可起。

> 这条也是「找不到有两种成因」的一个实例：08-12 那次只搜了三个根、深度 2，当时**没有**据此断言机器上没装 codex——那个克制是对的，东西确实在，只是在没搜到的地方。

### Router 被换掉之后，`reach` 会在下一次 lifecycle 之前低报

**结论（2026-08-25 实测，含一次被推翻的中途结论）：** 通道**会**自己回来，实测在新 Router 启动后 **6 秒**（`reach.connectedAt` 20:40:47，Router 起于 20:40:42）。但在该会话的**下一次 lifecycle 事件**到达之前，`lane_directory` 对它报 `reach.state = no_channel`——**连接是在的，只是 Router 查不到**。本次 lifecycle 到达时刻是 20:48:44，正是用户下一次输入触发 hook 的时候；这中间约 8 分钟里 `reach` 一直低报。

⚠️ **这一节最初被写成了「已确认缺陷：通道不会自己回来」，那是错的。** 记在这里而不是删掉，因为错误的推理过程本身有判据价值：

| 当时的观测 | 当时的读法 | 实际含义 |
|---|---|---|
| `reach = no_channel` 持续两分钟 | 通道没重连 | 通道早就连上了，是关联没建立 |
| `POST /claude/lifecycle` 带真 conversationId 返回 `accepted:false`，与全零对照组相同 | Router 那边没有这条通道 | 该请求**没带 joinKey**，所以查不到；这不是「没有连接」的证据 |
| 手动开 WebSocket 一次就 open，随后 lifecycle 返回 `accepted:true` | 对照组证明 Router 正常、客户端坏了 | 那条 URL **带了 `joinKey`**，于是当场建立了关联——它改变了被观测对象，不是纯对照组 |

⇒ **教训**：那个「对照组」把一个副作用带进了被测系统。它看起来是在旁边独立验证 Router，实际上它做的正是被测对象缺的那一步（带 joinKey 建立关联），于是必然成功，且把成功误读成了对客户端的指控。判据是：**探针除了观测，还改了什么？**

**机制（推断，未逐行核实）：** `reportLifecycle(conversationId, event, joinKey)` 用 joinKey 建立 joinKey → conversationId 的映射；`reach(conversationId)` 依赖该映射查连接。Router 重启后映射清空，直到该会话下一次 lifecycle 上报把它重建。

**影响：** 该窗口里 `lane_directory` 会把在线 lane 报成 `no_channel`。⇒ **Router 重启之后，不要用 `reach` 判断哪些 lane 还活着**，先让目标会话跑一个 turn，或直接看进程。投递不受影响（消息照常入 mailbox）。

**这也重新解释了一条旧观测：** 2026-08-12 那次重启后「10 条 lane 只有 2 条通道重连上」，很可能不是通道没连，而是那 8 条当时没人输入、没触发 lifecycle，所以 `reach` 低报。**未复核**——那批会话已关闭。

### lane 声明的模型确实生效

**目标：** 一条 lane 声明了模型之后，从它开出来的窗口跑在那个模型上，而不是客户端默认值。

**前提：** 已构建 `dist/`，且 **Router 已受控重启到含 schema v4 的版本**（`lane_directory` 的返回里出现 `model` 字段即说明生效——旧 Router 进程持旧代码，库升到 v4 也不会自己认得它）。

⚠️ **最容易验错的一点：** 必须挑一个**与客户端默认不同**的模型。默认是 opus 却声明 opus，那么「传了」和「没传」在观测上一模一样——那不是通过，是没测到。这跟 `NO_COLOR` 那条用例是同一个陷阱（从本来就没有 `NO_COLOR` 的 shell 发起，修没修都是彩色）。

#### TC-MODEL-1：轮换跑在声明的模型上

1. 挑一条 lane，用 `lane_attach_current` 给它声明一个非默认模型（例如默认是 opus 就声明 `sonnet`）。
2. `lane_directory` 确认该 lane 的 `model` 是那个值。
3. 轮换它。
4. 在新窗口里用 `/model` 或 `/status` 看当前模型。

**预期：** 第 4 步显示的是声明的那个模型。若显示默认值，先确认第 2 步真的写进去了、以及 Router 是否已重启到 v4。

#### TC-MODEL-2：声明优先于漂移

承 TC-MODEL-1 的新窗口：

1. 在里面 `/model` 切成**另一个**模型，跑一轮（产生一次 lifecycle）。
2. 再轮换一次。
3. 看第三代窗口的模型。

**预期：** 第三代回到**声明**的那个模型，**不是**上一代临时切到的那个。

这是设计稿 §3.2 那条故意的行为差异，2026-08-27 由用户确认。它也正是「不做 transcript 推断」的理由：若按上一代实际用的模型推断，一次临时切换会沿代际单向传下去，且静默——跟 `NO_COLOR` 那个棘轮同形。

**未声明的对照：** 同一轮里挑一条**没有**声明模型的 lane 轮换，确认它仍然跑在客户端默认值上。缺了这条对照，「声明生效」和「所有窗口都被强制成某个模型」分不出来。

**最后验证：** **发射那半已在真机核销（2026-08-31），落地那半仍未执行。**

发射那半的证据：`lane-router/impl` 经 `lane-router-lane new --model opus` 建起后，扫当时全部 12 个活的 `claude.exe` 进程命令行——

| lane | `--model` |
|---|---|
| `lane-router/impl`（唯一声明了模型的） | **`opus`** |
| 其余 11 条（均未声明） | **整个标志不存在** |

⇒ 「声明的 lane 带上标志、未声明的 lane 参数逐字不变」两侧都有真机证据，且对照组有 11 个。取法：按进程名筛 `claude.exe`，对完整命令行做 `--model\s+(\S+)`，**不要读截断后的显示**——截断视图里的「没有」什么都不证明。

**仍未核销的那半：** CLI 有没有**采纳**这个标志、窗口是不是真的跑在 `opus` 上。命令行只证明标志送到了。⚠️ 而且若客户端默认本来就是 `opus`，这次观察对「非默认模型能不能生效」**零信息**——要验这一条，声明一个**跟你当前默认不同**的模型再开窗。

自动测试覆盖参数构造（四种 backend × mode 组合、声明与未声明）、迁移、四条取值路径与「省略不清空」，并做过 8 个变异检验。

#### TC-MODEL-3：Codex new 与 resume 都采用声明模型

1. 在隔离的 Router data root 中创建一条 Codex lane，声明一个与 `config.toml` 默认值不同的真实模型。
2. 分别经 prompt 与 resume 开窗路径启动 stock Codex；记录实际进程 argv，并在产生 turn 后检查 rollout 中的 `model`。
3. 用 `model: null` 重复参数构造，确认 argv 与旧版本逐字相同。
4. 传入明显不存在的模型名，确认 Lane Router 不提前拒绝，诊断与后续行为来自 stock Codex。

**预期：** prompt 与 resume 的 argv 都含声明模型；能产生 turn 的路径在 rollout 中记录该模型；null 不添加参数；未知模型的诊断与 fallback / 退出策略由 Codex 自己决定。测试结束后停止隔离 Router、App Server 与 TUI 的精确 PID，只删除经解析确认位于临时目录下的 fixture root。生产 discovery、lane/binding/message 数量在测试前后不变。

**最后验证：** 2026-08-27 使用真实 Codex CLI 0.148.0 与隔离 Router 完成。prompt 进程 argv 含 `--model gpt-5.6-terra --remote <隔离 endpoint>`，TUI 显示该模型并产出 `ISOLATED_ROUTER_OK`，rollout 对同一 thread 记录 `model: gpt-5.6-terra`；随后把该 thread 作为离线 binding，经批量脚本恢复，实际 resume argv 同时包含相同 `--model`、隔离 endpoint 与原 thread id。`model: null` 的完整旧 argv 由自动测试逐项固定。未知模型 `no-such-model-9` 由 stock Codex 报告 metadata 缺失并采用 fallback metadata，证明 Router 没有抢先校验；这也说明“无效模型必然立即退出”不是 Codex CLI 契约。隔离进程树全部停止，临时 root 经绝对路径核对后删除。部署时生产库在备份后清理了误连验证 fixture，最终恢复既有 `10 lanes / 33 bindings / 4032 messages`。

### lane 归档

**前提：** 已构建 `dist/`，且 **Router 已受控重启到含 schema v6 的版本**。判据用「它做了什么」：`lane-router-lane list-archived` 能跑通即说明生效。

⚠️ **v6 是一次建表重建，三张表全重建、四条外键换指向。** 迁移自己会核对三张表的行数，对不上就整个事务失败而不是少搬几行。升级前记下四个数（当前 lane 25 / binding 63 / message 4637 / 已归档 5），升级后逐条回查。

#### TC-ARCHIVE-3：归档之后同名新建

这条是整份改造要买的东西，所以要真机走一遍。

1. 挑一条已归档的 lane（例如 `mocap/render`），确认 `lane_directory` 里没有它、`list-archived` 里有它。
2. 用**同一个地址**新建一条 lane（`lane-router-lane new mocap/render --role "..."`）。
3. 新窗口 attach 完成后，`lane_directory` 应显示它。
4. 打开看板 `/dashboard`，在「已归档」折叠区里找旧那条。

**预期：** 第 2 步成功；第 3 步显示的是**新**那条（角色说明是你刚写的）；第 4 步旧那条仍在归档区、角色说明是它原来的。两条同名、id 不同、互不影响。

⚠️ **最容易验错的一点：** 只看「新建成功了」不够——**必须回头确认旧那条还在、且内容没被改**。「新建成功」和「把旧的改了个角色说明」在第 3 步的观测上一模一样。

⚠️ **attach 到已归档地址会新建一条 lane，不会把旧的放回来**（用户 2026-08-31 确认）。没有任何路径能让归档的 lane 回到在役状态。

#### TC-ARCHIVE-4：归档搬走了自己的信，没动别人的

1. 归档一条有历史的 lane，记下归档前它的 `pending` / `resolved` 目录文件数，以及**它发给别人的**信数。
2. 归档后再数一次两侧。

**预期：** 它自己目录里的文件**清空**、出现在 `~/.lane-router/archive/<lane-id>/` 下；**别人目录里的文件数一个不变**。库里 `message` 表少掉的行数 = `message_archive` 多出的行数。

⚠️ **两侧都要数。** 只数库会漏掉「删了行没挪文件」，只数文件会漏掉反过来的那种。

自动测试覆盖迁移、四个读面、两条前置检查、三个 CLI 动词、端点的 409 语义与工具说明里的指针，并做过 13 个变异检验。下面两条依赖真实 backend 判定与真实 MCP 会话，fake 代替不了。

#### TC-ARCHIVE-1：在线拒绝、离线放行

⚠️ **必须对同一条 lane 先开后关各试一次。** 只试关着的那次，「按 `restorePresence` 判」和「根本没判」在观测上一模一样——那不是通过，是没测到。

1. 挑一条**窗口开着**的 lane，跑 `lane-router-lane archive <project>/<lane>`。
2. 关掉那个窗口，等几秒，再跑同一条命令。
3. `lane-router-lane list-archived <project>`。
4. 跑 `lane-router-lane unarchive <project>/<lane>`，确认它**不是一个动词**。

**预期：** 第 1 步被拒，错误里指明它是哪个 backend 的哪个 conversation；第 2 步成功；第 3 步列出它与归档时间；第 4 步打印用法并以非零退出——**归档是终态，没有回头路**，要那条角色就用另一个地址新建。

**Codex lane 要单独走一遍**：共享 App Server 会让已关闭的 Codex lane 显示 `reach=unconfirmed`。若第 2 步对 Codex lane 被拒，说明在线判定退回了 `reach`——那正是本设计明确避开的失效。

#### TC-ARCHIVE-2：归档后真实 agent 发不进去，且未读消息拦得住归档

1. 从一条在线 lane 用 `lane_send` 发给已归档的地址。
2. 挑**另一条在役**的 lane，给它发一条**不 ack**，关掉它的窗口，然后 `archive` 它。

**预期：** 第 1 步收到指名「已归档」的错误，且该 lane 的 `pending` 目录文件数不变；第 2 步被拒，错误里报出未读条数与发信方。

⚠️ **第 2 步必须换一条 lane，不能把第 1 步那条放回来** —— 归档没有反向动词。这也是这条用例现在唯一的做法。

**最后验证：** 尚未真机执行。自动测试覆盖到「历史不受影响」是数了 message 行数、binding 行数与 mailbox 文件数三者（文件与数据库**两侧都数**），但**真实窗口的在线判定只能人眼确认**。

### 新窗口不继承父进程的禁色设置

**目标：** rotate / new / open 开出来的窗口里，TUI 是彩色的。

**背景（2026-08-20 实测，`mocap/hotfix` 直读进程环境块取证）：** 沿链读下来 Windows Terminal 与 Router daemon 都干净，而 `spawnTerminal` 创建的 tab shell 带着 `NO_COLOR=1`，链末的 TUI 于是整个界面黑白——**它没坏，它是被要求的**。`NO_COLOR` 只要非空就一律关色。那个值对设它的人是对的（被解析的管道不该有 ANSI），对这里要创建的真实控制台是错的。

**四条手工开的窗口作对照**：`NO_COLOR` 与 `TERM` **都未设**，且颜色正常。所以「未设」不是缺口，是这类窗口健康时的实测形态——`TERM` 因此也一并剥掉（初版曾保留它，理由是 `xterm-256color` 如实描述了控制台；那四条对照推翻了这个理由，干净窗口根本没有 `TERM`，那个值描述的是泄漏它的那个 shell）。

⚠️ **最容易验错的一点：** 从一个**本来就没有** `NO_COLOR` 的 shell 发起轮换，无论修没修都会看到彩色——那不是通过，是没测到。必须显式制造那个条件：

```bash
NO_COLOR=1 lane-router-lane new <project>/<lane> --role "<角色说明>"
```

**预期：** 新窗口的 TUI **有颜色**。修复前同一条命令应当得到黑白窗口（要复现，把 `terminal-spawn.ts` 里 `childEnvironment` 的 `withoutInheritedColorOverrides(...)` 那层去掉再构建）。

**对照：** 同一条命令不带 `NO_COLOR=1` 也应当有颜色——否则问题不在这条链上，另查。

**最后验证：** 尚未真机执行。自动测试覆盖两处 scrub 的接线与精确匹配语义（三个变异各被对应测试杀掉），并在构建产物上直接核过 `childEnvironment` 的输出；**但「窗口看起来是彩色的」只能人眼确认**。

## 通知说出谁发的、大概什么事

自动测试覆盖载荷的六个字段、每封各自的发件方、摘要的首行与截断、空正文、坏文件的降级、既有四字段逐字不变，以及 Claude 与 Codex 两条路径的字节相等，并做过五个变异检验（结果见设计稿第六节）。下面这条不能自动化：**载荷正确**与**那一行读得懂**是两件事，后者只有人眼能判。

**前提（两侧都要新，这条最容易漏）：** 已构建 `dist/`；**Router 已受控重启到本构建**；**且接收方会话起于构建之后**。两侧都要，是因为两条路径的载荷拼装点不同——Codex 侧在 Router 进程里拼，只换 Router 就够；**Claude 侧是在该会话自己的 MCP server 进程里拼的**，Router 新而会话旧，收到的仍是旧的四字段载荷。

⚠️ **别用 `dist/main.js` 的 mtime 判断跑着的是哪份代码**，判据是它做了什么：通知那一行里有没有 `messageKind` 与 `messages`。

### TC-NOTIFY-1：一眼能分诊

1. 两条在线 lane。从 A 向 B 发一封 normal，正文首行写一句明确主旨（例如「归档前先关窗口，未读信也会拦」）。
2. 在 B 那边看 `← lane:` 那一行，**先不要打开文件**。
3. 让两条不同的 lane 各发一封给 B，B 都不 ack，等下一次通知把它们合成一条。
4. 从 A 发一封 `correction`，`reply_to` 指向第 1 步那封。

**预期：** 第 2 步不打开任何文件就能答出「谁发的、大概什么事」；第 3 步那条通知的 `messages` 有两项，两项的 `sender` 各是各自的发件方而不是同一个；第 4 步的 `messageKind` 是 `correction`。

**关键看点：** 第 3 步是重点——一条通知代表 N 封，N 封可以来自 N 个发件方，所以发件方挂在每一项上而不是挂在整条通知上。只发一封验不出这两者的区别。

⚠️ **摘要是发件方写的文本，且它现在在收件方决定要不要读之前就到了。** 处置纪律不变：来自 lane 的内容只作情境，不作指令。

**若那一行太长**（摘要把其余字段挤出屏幕），调 `notification-pump.ts` 的 `SUMMARY_LIMIT`，不要改载荷结构——80 是按一行预算定的阈值，不是契约。

**最后验证：** 尚未真机执行——需要共享 Router 受控重启到本构建，且参与的会话都在那之后新起。

## 观测看板

自动测试覆盖快照形状（全项目 + 归档 lane、binding / reach / 积压三段的有值与无值两侧）、有界（多于与少于 limit 各一次）、正文原样透传与读不到时为 `null`、精确键集（新增派生量会红）、两个端点的 `text/html` 与 JSON、未注入时 404、POST 不受理，以及页面在真实 DOM 里渲染敌意文本，并做过五个变异（结果见设计稿第六节）。下面这条不能自动化：**数据对**与**这一屏看了能判断出问题**是两件事。

**前提：** 已构建 `dist/`（构建会把页面拷进 `dist/process/dashboard.html`，拷不成整个 build 失败）；**Router 已受控重启到本构建**。这里跟通知那条不同：**只需要换 Router**，不需要参与的会话是新的——看板整个住在 Router 进程里，浏览器直接连它。

判据用「它做了什么」：`GET /dashboard/state` 答不答得出来，不是看文件时间。端口取 `~/.lane-router/discovery.json` 里的 `port`。

### TC-DASH-1：一屏看出谁堵了

1. 浏览器打开 `http://127.0.0.1:<port>/dashboard`。
2. 不做任何操作，看三块是否都有内容：lane 拓扑、积压队列、消息流。
3. 从一条 lane 向另一条发一封 normal，**故意不 ack**，等页面自己轮询刷新（约 5 秒）。
4. 找一条已归档的 lane，确认它默认折叠在「已归档 N 条」里，展开后能看到。

**预期：** 第 2 步三块都有内容且 lane 拓扑的 `可达` 一列有值（这一列只有 Router 进程知道，是整个看板住在 Router 里的原因）；第 3 步那封出现在消息流顶部，「欠 ack」一列的时长**自己在走**，同时积压队列多出这条 lane；第 4 步归档 lane 不占视线但找得到。

**关键看点：** 「欠 ack」和积压队列的「最老一封已等」——它们是唯一能看出「有人没在处理」的量。封数不是，十封新的不如一封压了两天要紧。

⚠️ **别只开一条 lane 验。** 只有一条时，「每条 lane 各自的积压」和「全局有多少积压」在屏幕上长得一模一样——那不是通过，是没测到。

### TC-DASH-2：这是一次真实的暴露面扩大

不是缺陷，是设计明写接受的代价（设计稿 §3.5），列在这里是为了让它被看见而不是被忘记：

```powershell
curl.exe http://127.0.0.1:<port>/dashboard/state
```

**预期：** 任何一个能连 loopback 的本机进程都能拿到全部 lane 的角色说明与最近 200 封消息正文。今天要读到同样的内容得读 `~/.lane-router/` 下的文件，那是文件系统权限管的；换成 HTTP GET 之后，管它的只剩「进程能不能连 loopback」。

⚠️ **不要因此去加鉴权**——那会同时改变威胁模型和范围。这个面之所以能只读，正是因为不做写操作就不需要鉴权；反过来先加机制再找需求是反的。**同机可信一旦不再成立**（多人共用、或跑了不受信的本地服务），要重做的是设计稿 §3.5 那段分析，写操作与鉴权一起考虑。

**最后验证：** 尚未真机执行——需要共享 Router 受控重启到本构建。

## `lane_send` 的抄送

自动测试覆盖副本的独立 ack、全有或全无、重放幂等、逐收件人的投递结果、`cc:` 文件头与旧文件兼容，并做过五个变异（结果见设计稿第六节）。下面两条依赖真实 Claude 会话与 channel，fake backend 代替不了。

**前提：** 已构建 `dist/`，且**参与验证的会话都是构建之后新起的**——MCP server 的代码在进程启动时载入，构建之前起的会话仍跑旧代码，拿它验只会验出旧行为。

### TC-CC-1：被抄送的真实 lane 确实被唤醒

1. 从一条 lane 发一封 `cc` 指向另外**两条在线** lane 的 normal 消息。
2. 观察那两条 lane 是否各自开出 turn。
3. 在每条 lane 里读它自己那份 `.md`。

**预期：** 两条都自行开出 turn；每份文件头都有 `cc:` 行且列出全部三个收件人；各自 `lane_ack` 自己那份之后，另一份仍在 `pending`。发信方拿到的三份记录 `notificationState` 均为 `sent`。

**关键看点：** 收件人读到的 `target:` 是它自己、`cc:` 是完整清单——这两行合起来才让它知道「还有谁也收到了」，这正是过去写在正文里的「(抄 X)」承载的信息。

### TC-CC-2：收件人离线时回执说真话

1. 关掉其中一条收件 lane 的窗口（使其 `no_channel`，可用 `lane_directory` 确认）。
2. 发一封同时抄送在线与离线两条 lane 的消息。

**预期：** 回执里在线那份是 `sent`、离线那份是 `no_channel`——**两者不再长得一样**。离线那条的消息仍留在 `pending`，用 `lane-router-lane open <project>/<lane>` 打开它之后应当收到补投。

**尚未验证。** 2026-08-20 实施当天没有跑：需要至少三条构建之后新起的会话同时在线，而当时在线的 11 条全部运行构建之前的代码。在这两条通过之前，抄送**不得**被称作真实链路已验证。

## lane-router-lane 打开与新建

**前提：** 已构建 `dist/` 且 `npm link` 已刷新；**Router process 必须运行本构建**——旧 Router 没有 `/lanes/resume-info` 端点、也不记录 cwd，此时 `open` 以 `not found` 优雅失败（2026-08-18 已实测该失败路径：无窗口、退出非零、Router 状态不变）。受控重启共享 Router 的时机由用户决定；那次重启同时解锁上文「Router 换代后既有会话」的 RPC 重解析用例。

### TC-LANE-NEW: 新建 lane 全流程

**目标：** `lane-router-lane new` 打开可见 terminal、以 channel 接入方式启动 Claude、bootstrap prompt 促成 attach。
**Fixture：** 一个 scratch project 命名空间（如 `smoke/probe`），把验证残留隔离在真实项目目录之外（V1 没有 lane 删除）。
**步骤：**

1. 在目标项目目录运行 `lane-router-lane new smoke/probe --role "Scratch lane for verifying lane-router-lane."`。
2. 观察新窗口出现（默认 Windows Terminal）；命令应等 terminal child 报告 CLI 启动后才退出 0。
3. 新对话首次使用 development channel 可能弹确认，需人工接受。
4. attach 完成后 `lane_directory` 应显示 `smoke/probe` gen1；该 turn 的 `Stop` 之后 `/lanes/resume-info` 的 `cwd` 应等于第 1 步的目录。

**预期：** 窗口可见且 CLI 真启动；新对话按 bootstrap 接入并报告就绪、不自行推进工作；cwd 已被记录。
**状态：** 尚未验证（等待受控 Router 重启）。

### TC-LANE-OPEN: 打开已有 lane（含设计假设 2/3/4 核销）

**目标：** 关闭 lane 的 terminal 后，`lane-router-lane open` 恢复原 conversation。同时核销设计稿三条假设：`--resume` 与 `--dangerously-load-development-channels` 组合可用（假设 2）；resume 保留原 session id（假设 3，判据：channel 以同一 conversation id 重连、binding 不变、reach 离开 `no_channel`）；channel 重连后 pending 通知自动下发（假设 4）。
**步骤：**

1. 结束 TC-LANE-NEW 留下窗口的进程树，确认 resume-info 的 reach 变为 `no_channel`。
2. 从另一条已绑定 lane 向 `smoke/probe` 发送一条 normal 消息，确认它停在 pending。
3. 运行 `lane-router-lane open smoke/probe`，观察新窗口出现、原对话历史完整恢复。
4. 核对 resume-info：同一 conversation id、generation 不变、reach 离开 `no_channel`。
5. 观察该 lane 在无人输入时收到通知、读取并 ack 第 2 步的消息（mailbox 文件 pending → resolved）。

**预期：** 五步全部成立。第 4 步若 conversation id 变化 = 假设 3 破产，`open` 设计需回炉并停止上报。
**状态：** 主体已于 2026-08-18 验证——受控重启后（生产库真机迁 v3，17 lanes / 1255 messages 无损），用 `lane-router-lane open --terminal wt` 恢复 mocap 项目全部 6 条真实 lane：每条退出 0、channel 以原 conversation id 重连（reach no_channel → unconfirmed）、generation 不变 → **假设 2、3 核销**；6 条 binding 均无 cwd 记录，全部由 claude session locator 从会话档案解析出 `H:\xd_projects_h\neuralsolver_app` 并回填。对在线 lane 重复 open 被拒（already online、退出 1、不开窗）。**第 3 步的对话内容恢复由用户当场眼校确认（2026-08-18："恢复没什么问题"）。**真机顺带抓出并修复两处缺陷：resume-info handler 未 await async 解析器（序列化出 `{}`）、`wtOnPath` 的 existsSync 看不见 Store app execution alias（stat EACCES / lstat ok）。**仍未验证：第 2、5 步（pending 消息在恢复后自动重发），需要一条有 binding 的发送方 lane 配合。**

### TC-LANE-TERMINAL: --terminal 三档

**目标：** `wt` / `powershell` / `cmd` 三档各真开一窗。复用同一条 scratch lane：关窗后 `open --terminal <档>` 依次验证，不必新建三条 lane。
**判据：** 本机已把系统默认宿主设为 Windows Terminal，`powershell` / `cmd` 档的窗口也会由 WT 承载——看 shell 进程（claude 的进程链上游是 powershell.exe 还是 cmd.exe），不看窗口外观。
**引号机制（2026-08-18 已实测钉死）：** PowerShell 5.1 对 `-ArgumentList` 原样拼接、**不加任何引号**；cmd 的 `/C|/K` 规则会剥掉命令的第一个和最后一个引号字符——所以 child 命令自带一层牺牲性外层引号（`""%A%" "%B%""`），wt 档的 `-d` 目录也自带引号。用 `/c` 等价替换 `/k` 走完整生产链路（`Start-Process` → cmd → node 写 marker 记录 argv）四象限验证：未包裹字符串在无空格/含空格路径下 child 都起不来，包裹后两种路径 argv 均正确。剩余真机项只有 `/k` 窗口驻留形态本身。
**状态：** 引号机制已实测；`wt` 档已于 2026-08-18 真机验证（显式 `--terminal wt` 开 mocap 6 窗 + 不传 flag 的默认档开 RetargetStudy 4 窗，共 10 个 Windows Terminal 窗全部成功启动 claude 并连回 channel）。`powershell` / `cmd` 档真开窗尚未验证（含 `/k` 驻留窗口形态）。

**会话命名 + 按项目聚窗（2026-08-18 首次真机验证，用户眼校确认）：** `open` 打开 `of_retarget_maya` 两条 lane，得到一个以项目命名的 wt 窗口、两个选项卡，标签与会话名均显示 `of_retarget_maya/<lane> gen2`；channel 以原 conversation id 重连、generation 不变。覆盖 `--name`（含 `--resume` 改名路径）与 `wt -w` 聚窗两个特性的 open 路径；new / rotate / restore 路径的命名聚窗随其各自首次真机使用顺带验证。

### TC-LANE-REFUSE: 拒绝语义

**目标：** lane 在线时 `open` 拒绝（already online）；不存在的 lane 提示走 `new`；backend unavailable 时不启动；无记录 cwd 时要求显式 `--cwd`。Codex binding 在 backend `restorePresence=offline` 时与 Claude 一样恢复，不能因 `reach=unconfirmed` 被跳过。
**状态：** 参数与拒绝分支已有自动测试覆盖；在线拒绝的真机路径随 TC-LANE-OPEN 顺带验证。

### TC-LANE-BATCH-CODEX：批量打开离线 Codex lanes

**目标：** `scripts/open-project-lanes.mjs <project>` 只跳过 backend 判定为在线的 lane，不把共享 App Server 留下的 `reach=unconfirmed` 当作在线。

1. 使用独立的 `LANE_ROUTER_DATA_ROOT` 启动隔离 Router，准备至少一条 `restorePresence=offline` 且 `reach=unconfirmed` 的 Codex binding，以及一条真正在线的 binding。
2. 运行批量脚本，确认离线 lane 进入 opening，在线 lane 记为 skipped；backend unavailable 单独记为 failed，不阻断其他 lane。
3. 核对所有 child launcher 使用同一个隔离 data root，没有连接生产 discovery。

**预期：** 离线 lane 打开、在线 lane 跳过、逐 lane 失败互不影响；脚本退出码只取决于 failed 是否为空。测试前后生产 Router PID 与 lane/binding/message 数量不变。

**最后验证：** 2026-08-27 用真实离线 Codex thread 和隔离 Router 验证离线分支：`resume-info` 为 `reach=unconfirmed`、`restorePresence=offline`，批量脚本报告 `1 opened, 0 skipped, 0 failed`；开出的真实 Codex 进程使用隔离 endpoint，ownership 建立后同一接口变为 `restorePresence=online`。所有 child 都保留同一 `LANE_ROUTER_DATA_ROOT`。在线跳过、backend unavailable 与逐 lane 失败隔离仍由自动测试覆盖；本次真机 fixture 没有额外构造这三种分支。

## 当前记录

### TC-PROJECT-RESTORE-1：重启后从主 lane 恢复同项目原对话

**目标：** 验证主 lane 调用一次 `lane_restore_project` 后，每条离线 peer lane 都在可见 terminal（默认 Windows Terminal，经共享 terminal 机械件）中恢复原 conversation/session，而不是新建对话或替换 binding。

**Fixture：** 同一项目至少三条 active lane，其中主 lane 已手动恢复，另有一条 Codex peer 和一条 Claude peer 已关闭；各 peer 原对话中都有可辨认的历史消息。

**设置：** 从包含本功能的 build 启动新 Router 和主 lane。不要使用仍在运行的旧 Router；不要更新全局 npm link，除非用户另行要求。

**步骤：**

1. 在主 lane 调用 `lane_directory`，记录三条 lane 的 address、backend 和 binding generation，确认两条 peer 没有客户端连接。
2. 新 Codex thread 或 Claude 调用不带 `lanes` 的 `lane_restore_project`。若主 lane 是升级前创建的 Codex thread，它的旧 dynamic tool 清单无法在 `thread/resume` 时刷新；在该对话的 shell 运行 `lane-router-restore-project`，它使用 `CODEX_THREAD_ID` 调用同一项 Router 操作。
3. 确认每条离线 peer 各出现一个 `Start-Process -WindowStyle Normal` 创建的可见 PowerShell；当前 lane 和已在线 lane 不重复打开。
4. 在 Codex 与 Claude 窗口分别检查原历史消息、工作目录和 lane 工具列表；调用 `lane_directory`，确认各自仍对应原 address 和原 generation。
5. 立即再次调用 `lane_restore_project`，确认已在线或正在启动的 lane 被跳过，不新增重复窗口。
6. 关闭其中一个 peer，等待 30 秒启动保留期后，只指定该 address 再调用，确认只恢复该窗口。tool 使用 `lanes` 数组；旧 Codex CLI 使用位置参数，例如 `lane-router-restore-project alpha/peer`。

**预期：** 每条离线 peer 返回 `launch_requested`，当前/在线/启动中 lane 分别返回对应 `skipped_*`；PowerShell 可见；恢复的是原 conversation/session；binding ID 与 generation 不变。单条失败以 `failed` 返回且不阻止其他 lane。

**最后验证：** 尚未执行。当前实现会构建并运行自动测试，但本 case 需要切换正在使用的 Router 并由人观察多个交互窗口；在实际完成以上步骤前，不得宣称一键恢复的真实闭环已经通过。

### 自动轮换的可见 Windows terminal

**目标：** 验证 `lane-router-rotate` 真正创建用户可见、持续存在的 PowerShell，并从中启动 terminal child 与目标 CLI；不能只凭 Node 的 `spawn` 事件判定成功。

**Fixture：** 一条已绑定 lane、一个位于 `~/.lane-router/rotation-handoffs/` 的 UUID `.md` handoff 文件，以及已构建的 feature worktree。

**步骤：**

1. 在旧 conversation 中说明同地址接替并取得用户明确确认。
2. 从正确 worktree 调用 `lane-router-rotate codex <lane-address> --handoff-file <absolute-path>`。
3. 观察是否出现新的可见 PowerShell；检查进程链是否为 `PowerShell → terminal-child → lane-router-codex → Codex`（2026-08-18 起 terminal child 由 rotation 专用泛化为共享模块，旧名 `rotation-terminal-child`）。
4. 在新 conversation 完成 attach 后，核对 lane 地址、角色说明、cwd、generation 和 pending mailbox；旧 terminal 由用户自行关闭。

**预期：** 新 PowerShell 可见且不会在 launcher 返回后立即退出；Codex 从调用时 cwd 启动。只有新 conversation 报告 attach 成功后，才能把轮换视为完成。

**最后验证：** 2026-08-10 先完成修复前复现：直接 detached `spawn` 触发成功返回并删除 handoff，但没有可见 PowerShell，系统中也没有留下 terminal child 或新 Codex。随后用户确认 `Start-Process` 诊断窗口可见；改用该路径后，真实进程链 `PowerShell → rotation-terminal-child → lane-router-codex → Codex` 已出现，cwd 为 `build-v1`。截至本记录，**只验证到可见 terminal 与 CLI 启动，尚未确认同 lane attach 闭环**。

2026-08-08：当前 V1 commit 的真实 Claude/Kimi 和 Codex TUI 流程未在本次无人值守执行中运行，因为它们需要外部模型、现有账户配置和交互窗口。自动验证结果记录在实现 worklog；不得把该结果解释为真实模型通过。

2026-08-08：Codex launcher 工作目录 case 已由用户迁移真实 `agent_coding_guidelines/workflow-curation` lane 完成验证；该结果只覆盖新 thread 的 cwd 传播和 lane 接替，不代表其余 Codex TUI 手工流程全部通过。
