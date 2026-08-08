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

**最后验证：** 待本次实现完成并重启空闲 Router 后执行。修复前，environment-validation 已验证同一环境不显式设置代理时会 timeout 或收到 `10054` 并 fallback，手动设置标准代理变量后一次成功。

## 当前记录

2026-08-08：当前 V1 commit 的真实 Claude/Kimi 和 Codex TUI 流程未在本次无人值守执行中运行，因为它们需要外部模型、现有账户配置和交互窗口。自动验证结果记录在实现 worklog；不得把该结果解释为真实模型通过。

2026-08-08：Codex launcher 工作目录 case 已由用户迁移真实 `agent_coding_guidelines/workflow-curation` lane 完成验证；该结果只覆盖新 thread 的 cwd 传播和 lane 接替，不代表其余 Codex TUI 手工流程全部通过。
