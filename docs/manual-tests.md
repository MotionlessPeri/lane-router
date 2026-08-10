# Lane Router V1 手工验证

自动测试覆盖四项工具、文件 mailbox、SQLite 对账、Claude Channel transport、Codex App Server 协议、按需启动与 launcher 参数。下面两项只验证真实 CLI、模型 provider 和交互式 TUI 的边界，不能用 fake backend 结果代替。

## Claude Channel

前提：已构建 `dist/`，Claude CLI 已启用 Lane Router stdio MCP，并为 `UserPromptSubmit` 与 `Stop` 配置 `dist/adapters/claude/lifecycle-hook.js`。启动 Claude 时启用 `server:lane` Channel。

1. 在新对话调用 `lane_directory`，说明建议并取得用户确认，然后调用 `lane_attach_current`。
2. 从另一条已绑定 lane 发送 normal 消息，确认 Claude 自动获得一次处理机会，并直接读取通知给出的 `pending` 目录。
3. 在 Claude turn 运行期间发送 correction，确认它排入下一 turn，而不是声称 steer 当前 turn。
4. 用一次 `lane_ack` 批量 resolve 已处理消息，确认文件进入 `resolved`。
5. 退出 Claude，再发送一条消息；恢复同一 Claude session 后确认 pending 消息再次得到提醒。
6. 在旧 turn 运行期间从新对话请求接替同一 lane，确认接替等待 `Stop`，随后 generation 增加且旧 session 不能再发送或 ack。

预期：MCP 只列出 `lane_directory`、`lane_attach_current`、`lane_send`、`lane_ack`。MCP 进程使用 Claude 自动提供的 `CLAUDE_CODE_SESSION_ID`；hook 的 `session_id` 与它对应。通知不携带消息正文，正文只在 mailbox 文件中。

## Codex remote TUI

前提：已构建 `dist/`，`codex --version` 与实验性 App Server schema 检查通过。

1. 运行 `lane-router-codex`，确认它按需启动 Router process、打开 stock Codex remote TUI，并由本地 adapter 在 TUI 的 `thread/start` 中注入四项 dynamic tools；不得先创建空 thread 再 resume。
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

## 当前记录

### 自动轮换的可见 Windows terminal

**目标：** 验证 `lane-router-rotate` 真正创建用户可见、持续存在的 PowerShell，并从中启动 terminal child 与目标 CLI；不能只凭 Node 的 `spawn` 事件判定成功。

**Fixture：** 一条已绑定 lane、一个位于 `~/.lane-router/rotation-handoffs/` 的 UUID `.md` handoff 文件，以及已构建的 feature worktree。

**步骤：**

1. 在旧 conversation 中说明同地址接替并取得用户明确确认。
2. 从正确 worktree 调用 `lane-router-rotate codex <lane-address> --handoff-file <absolute-path>`。
3. 观察是否出现新的可见 PowerShell；检查进程链是否为 `PowerShell → rotation-terminal-child → lane-router-codex → Codex`。
4. 在新 conversation 完成 attach 后，核对 lane 地址、角色说明、cwd、generation 和 pending mailbox；旧 terminal 由用户自行关闭。

**预期：** 新 PowerShell 可见且不会在 launcher 返回后立即退出；Codex 从调用时 cwd 启动。只有新 conversation 报告 attach 成功后，才能把轮换视为完成。

**最后验证：** 2026-08-10 先完成修复前复现：直接 detached `spawn` 触发成功返回并删除 handoff，但没有可见 PowerShell，系统中也没有留下 terminal child 或新 Codex。随后用户确认 `Start-Process` 诊断窗口可见；改用该路径后，真实进程链 `PowerShell → rotation-terminal-child → lane-router-codex → Codex` 已出现，cwd 为 `build-v1`。截至本记录，**只验证到可见 terminal 与 CLI 启动，尚未确认同 lane attach 闭环**。

2026-08-08：当前 V1 commit 的真实 Claude/Kimi 和 Codex TUI 流程未在本次无人值守执行中运行，因为它们需要外部模型、现有账户配置和交互窗口。自动验证结果记录在实现 worklog；不得把该结果解释为真实模型通过。

2026-08-08：Codex launcher 工作目录 case 已由用户迁移真实 `agent_coding_guidelines/workflow-curation` lane 完成验证；该结果只覆盖新 thread 的 cwd 传播和 lane 接替，不代表其余 Codex TUI 手工流程全部通过。
