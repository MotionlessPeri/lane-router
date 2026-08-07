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

## 当前记录

2026-08-08：当前 V1 commit 的真实 Claude/Kimi 和 Codex TUI 流程未在本次无人值守执行中运行，因为它们需要外部模型、现有账户配置和交互窗口。自动验证结果记录在实现 worklog；不得把该结果解释为真实模型通过。
