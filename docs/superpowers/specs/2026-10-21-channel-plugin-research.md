# Claude lane 启动免点「开发通道确认」：插件路线调研笔记

**状态：** 调研笔记，2026-10-21 由 `lane-router/design` 整理，依据是官方文档（`code.claude.com/docs`，由 design 的文档调研子代理 04:2x 逐条查证并给出来源）和本机只读检查；**没有在本机实测**，隔离实测另记。Vikunja LR-24；用户在问答 `3ade2628` 已准：做隔离实测、托管设置那步可用本机管理员身份。本机 Claude Code 2.1.304。

## 一、要解决的事

lane 用 `claude --dangerously-load-development-channels server:lane` 启动，每次都弹 `DevChannelsDialog`，要人点。正规免法：把 lane MCP 做成插件，列进托管设置的 `allowedChannelPlugins`，用 `--channels plugin:lane@<marketplace>` 启动。

## 二、文档给的事实（每条带来源页）

### 插件怎么声明 channel

- 目录：`<plugin>/.claude-plugin/plugin.json`（只有 `name` 必填）+ `<plugin>/.mcp.json`（`{"mcpServers": {...}}`，也可内联进 plugin.json）。`plugins/manifest-reference#mcpservers`、`plugins/components#mcp-servers`
- 「是 channel」由服务器自己在 MCP 初始化时声明 `capabilities.experimental['claude/channel']: {}`，配置文件里没有 channel 字段；plugin.json 可选 `channels: [{ server, displayName?, userConfig? }]`，用于配置项弹窗，文档未说注册是否必需。`channels-reference#server-options`、`plugins/manifest-reference#channels`
- stdio + `command`/`args` 可用，官方示例 `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"]`。`plugins/components#mcp-servers`
- 插件名不能以 `claude-` / `anthropic-` 开头。

### 本地 marketplace 与安装

- `<marketplace 根>/.claude-plugin/marketplace.json`：`name`、`owner.name`、`plugins[]` 必填；条目 `source` 为相对路径须以 `./` 开头、不能含 `..`。`plugins/marketplace-reference`
- `claude plugin marketplace add <本地路径>`（Windows 的 `.\`、`C:\` 都行）→ `claude plugin install lane@<marketplace>` → `claude plugin validate <路径>` 校验。`plugins/cli-reference`
- 安装记录在 `%USERPROFILE%\.claude\plugins\`（`known_marketplaces.json`、`installed_plugins.json`）；**本地目录 marketplace 的相对路径插件原地加载、不复制**，改源码下次会话或 `/reload-plugins` 生效。`plugins/loading`
- 离线：文档没明说，但启动从本地记录加载、本地 marketplace 安装前不刷新 ⇒ 预计不需要 GitHub，实测时断网核一次。
- marketplace 条目名和 plugin.json 的 `name` 要一致，否则 `Plugin ... not found`。

### `allowedChannelPlugins` 与 `channelsEnabled`

- 格式 `[{ "marketplace": "<名>", "plugin": "<名>" }]`；**语义是替换**——「Replaces the Anthropic-maintained list when set」，默认列表是 `claude-plugins-official` 里的 channel 插件，设了之后默认项全失效。`channels-reference#package-as-a-plugin`、`channels#restrict-which-channel-plugins-can-run`
- **只在托管来源生效**（`managed-settings.md#keys-only-a-managed-source-can-set`）：Windows 是 `C:\Program Files\ClaudeCode\managed-settings.json` 或 `managed-settings.d\`，或 HKLM `SOFTWARE\Policies\ClaudeCode` 的 `Settings` 值；写进用户 settings 无效；**不读 `C:\ProgramData\ClaudeCode`**。
- 限制型 allowlist 从最高优先级的托管来源整体取值，不与低层合并。
- 空数组阻止全部，但 `--dangerously-load-development-channels` 仍可绕过。
- `channelsEnabled` 是总开关，本机托管文件现在就一行 `{ "channelsEnabled": true }`，没有 `allowedChannelPlugins`、没有 `strictKnownMarketplaces`。
- 未文档化：Pro/Max 个人账号是否受 allowlist 约束（一处说个人用户跳过检查，一处说 `--channels` 只收白名单插件）。实测要看。

### `--channels` 语法

- `claude --channels plugin:<条目名>@<marketplace> [更多]`。只列出 `plugin:` 形式；`server:` 只在开发标志里出现。`cli-reference#cli-flags`
- 与开发标志可同时出现，但绕过只作用于开发标志自己的条目。`channels-reference#test-during-the-research-preview`
- `-p` 模式下开发标志被忽略；`--channels` 与 `-p` 的组合未说明。

### 工具名、权限、source 标签（迁移代价）

- 插件 server 注册名 `plugin:<plugin>:<server>`，`/mcp` 里显示 `plugin:lane:lane`；**工具名 `mcp__plugin_lane_lane__<tool>`**（非 `A-Za-z0-9_-` 的字符换 `_`）。`mcp#plugin-provided-mcp-servers`
- 权限规则写 `mcp__plugin_lane_lane__*`；hook matcher 只写裸 server 名不匹配插件 server。
- `<channel source="…">` 标签从 `lane` 变成 `plugin:lane:lane`（官方 fakechat 示例 `source="plugin:fakechat:fakechat"`）——**规范、Router 发的说明文字、任何写死 `source="lane"` 的地方都要改**。
- 用户级 `lane` 与插件 `lane` 可以并存（名字不同），并存行为未说明；迁移时删用户级注册。

### 启动对话框与通知

- 开发标志：全屏警告，必须选「I am using this for local development」。
- 白名单插件：文档只描述启动画面一行「messages from plugin:… inject directly in this session」，未安装 / 未批准时多一行警告；**没有写「需要确认」，也没有明确写「不弹任何对话框」**——这正是隔离实测要回答的第一个问题。`channels#quickstart`
- 通知协议一套：`notifications/claude/channel`（`content` + `meta`），能力 `claude/channel`，权限转发 `claude/channel/permission`；插件与开发 channel 协议无差异，可见差异只有 source 标签和启用条件。
- **协议版本陷阱**：v2 MCP 运行时下协商 `2026-07-28` 的 channel 服务器不会被注册为 channel；stdio 服务器默认会被要求协商该版本；`MCP_PROTOCOL_NEGOTIATION=legacy` 或 `MCP_SDK_GENERATION=v1` 可回旧握手。lane 服务器现在用 SDK 1.30.0 能跑，升到 2.x 时要留神。`mcp#push-messages-with-channels`、`mcp#mcp-client-runtimes`

### Windows

- 没有 channel 的 Windows 专属限制；需要 claude.ai 或 Console API key 认证（不支持 Bedrock / Vertex / Foundry）。
- 插件路径变量在 Windows 上用正斜杠；组件路径统一用 `/`。
- stdio 服务器在 Windows 上关闭时先关 stdin、300 ms 后结束进程树（2.1.296 起）——与 LR-27 里「结束 claude.exe 不留孤儿 MCP」的实测相符。
- link 模式的 command 源插件在 Windows 被拒；本地相对路径插件不受影响。

## 三、隔离实测计划（design 做，不碰生产 Router）

1. 建 `E:\xd_projects\lane-router\tools\channel-plugin\`（或 scratch 目录）：`.claude-plugin/marketplace.json`（name `lane-local`）+ `plugins/lane/.claude-plugin/plugin.json`（name `lane`）+ `plugins/lane/.mcp.json`（stdio，`node <dist>/mcp/lane-mcp-server.js`，用绝对路径或 `${CLAUDE_PLUGIN_ROOT}` 下的副本）。`claude plugin validate` 过。
2. `claude plugin marketplace add` + `claude plugin install lane@lane-local`。
3. **不改托管设置**先起一次 `claude --channels plugin:lane@lane-local`：预期启动画面提示「未在批准列表」、channel 不注册——证实白名单缺口。
4. 用管理员身份把 `C:\Program Files\ClaudeCode\managed-settings.json` 改成 `{ "channelsEnabled": true, "allowedChannelPlugins": [{ "marketplace": "lane-local", "plugin": "lane" }] }`（改前贴给用户看；注意它替换默认列表——本机没用官方 channel 插件，无损失），再起一次：看 ① 弹不弹对话框；② `/mcp` 里 `plugin:lane:lane` 是否带 channel；③ 工具名是否 `mcp__plugin_lane_lane__*`；④ 发一封信，`<channel source>` 是什么、能否唤醒；⑤ 旧的用户级 `lane` 同时在时会不会双挂。
5. 结果贴问答 `3ade2628`，再定改名迁移（launcher 参数、权限规则、规范、Router 说明文字里的 source 标签）。

## 五、实测进度

- 2026-10-21 05:57：第 1、2 步做完。插件骨架在仓库 `tools/channel-plugin/`（marketplace `lane-local` → 插件 `lane`，`.mcp.json` 用绝对路径指向主检出 `dist/mcp/lane-mcp-server.js`，`plugin.json` 带 `channels: [{ server: "lane" }]`）；`claude plugin validate` 通过。为了不影响生产会话，marketplace 与插件都以 **local scope** 装在 scratch 目录 `C:\Users\xiedong\AppData\Local\Temp\claude\E--xd-projects-lane-router\96be6be9-8f0f-4739-b827-90c1f1307ee1\scratchpad\plugin-test\`（它的 `.claude\settings.local.json` 写了 `extraKnownMarketplaces.lane-local` 与 `enabledPlugins["lane@lane-local"]`），只有在那个目录开的会话才会加载这个插件。
- 2026-10-21 09:17–09:35，第 3 步做完（三个会话 `lr24-step3` / `3b` / `3c`，都在 scratch 目录，用户只点了一次目录信任）：
  - **不弹开发通道框**（没带 `--dangerously-load-development-channels`）。
  - **白名单是必经一步**：MCP 日志（`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<cwd>\mcp-logs-plugin-lane-lane\*.jsonl`）明写 `Channel notifications skipped: plugin lane@lane-local is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`；同会话的用户级 `lane` 则记 `skipped: server lane not in --channels list for this session`。
  - **工具名** `mcp__plugin_lane_lane__<tool>`，服务器名 `plugin:lane:lane`；两段 MCP instructions 与用户级逐字相同。
  - **两套并存出事**：用户级 `lane` + 插件同时在一个会话里，Router 进入每 ~110 ms 一次的 `join.channel_connected` 循环（两会话各 2266 / 2325 行，日志 0.2 → 0.7 MB），`lane_attach_current` 报「lifecycle channel is not live」——记 LR-30（Router 拒绝同 joinKey + conversationId 的第二条连接；客户端收 4409 不重连 + 退避）。**插件路线上线前必须先修 LR-30，且迁移时必须撤掉用户级注册。**
  - `--strict-mcp-config --mcp-config <空>` 会把插件服务器也关掉（3c 会话没有任何 lane 工具、没起 MCP 子进程），不能用它做「只挂插件」。
- 2026-10-21 09:44–09:48，**第 4 步通过**（用户在问答 3ade2628 回「可以A」）：
  - 09:44:26 提权（UAC，用户点）把 `C:\Program Files\ClaudeCode\managed-settings.json` 写成 `{ "channelsEnabled": true, "allowedChannelPlugins": [{ "marketplace": "lane-local", "plugin": "lane" }] }`（旧内容 `{ "channelsEnabled": true }` 备份在 design 的 scratch `managed-settings.backup.json`）。**白名单现在长期生效**；本机没用官方 channel 插件，替换默认列表无损失。
  - 办法 A：`claude mcp remove lane -s user` → 起会话 → 看到插件 MCP 子进程后 `claude mcp add -s user lane -- node E:\xd_projects\lane-router\dist\mcp\lane-mcp-server.js` 放回（`claude mcp get lane` 核对：Scope User、stdio、node、同一路径、无 env）。用户级注册缺席 50 s（09:44:50–09:45:40），期间 `/dashboard/state` 里没有任何 lane 的 `attachedAt` 落在这个区间。
  - 会话 `lr24-step4`（claude.exe 70808，conversation `60d6bfb9`）：09:45:11 起、只挂插件服务器（`mcp-logs-lane` 没有新文件）；**没有任何弹窗**，09:45:27 自己起回合；MCP 日志 `Channel notifications registered`（01:45:25Z）；Router `join.channel_connected` 一条、`UserPromptSubmit` adopted，无重连循环。
  - 它用 `mcp__plugin_lane_lane__lane_attach_current` 挂成 `lane-router/lr24-probe` gen 1，09:45:44 发就绪信；design 09:47:03.986 发信 `d704aaf7` → `lastNotifiedAt` 09:47:03.995 → 09:47:09.848 `UserPromptSubmit`（没人打字）→ 09:47:21 回信：`source` 属性原文 **`plugin:lane:lane`**。
  - 收尾：结束 70808，`lane-router-lane archive lane-router/lr24-probe`；无孤儿 MCP 进程。
- 结论：插件路线可行且**完全免点**（目录信任框仍是每个新目录一次，与通道无关）。上线前置：LR-30（双服务器互挤）先修；迁移时撤掉用户级 `lane`。迁移稿待用户回「出稿」。

## 六、迁移稿改动范围（预收集，等用户回「出稿」后成稿）

- 前置：LR-30（同会话双服务器互挤）先修；LR-27 的 `lane_finish` / `close` 上线与否不影响本迁移。
- Router / launcher（impl）：`terminal-spawn.ts` / `terminal-child.ts` / `rotation-launcher.ts` / `scripts/open-vm-lane.ps1` 的启动参数 `--dangerously-load-development-channels server:lane` → `--channels plugin:lane@lane-local`；Router 发给 lane 的说明文字、`LANE_ROUTER_INSTRUCTIONS` 里任何写死的工具全名或 `source="lane"`；lifecycle hook 不变（joinKey 仍是 `CLAUDE_PID`）。
- 插件打包：`tools/channel-plugin/` 随仓库；`.mcp.json` 的服务器路径要可移植（`${CLAUDE_PLUGIN_ROOT}` 相对 dist，或部署脚本按机器写绝对路径）；每台机器 `claude plugin marketplace add <repo>/tools/channel-plugin` + `claude plugin install lane@lane-local`（user scope）+ 托管白名单（家里那台要管理员）。
- 撤用户级注册：`claude mcp remove lane -s user`（与装插件同一步做，避免并存）。
- 改名清单（2026-10-21 09:51 grep `source="lane"` / `server:lane` / `mcp__lane__` 的实测落点）：用户 `~/.claude/settings.json` **0 处**（权限规则和 hooks 都没按工具全名写，不用改）；规范仓只有 `techniques/lane-router.md` 3 处（启动命令、故障排查）；本仓代码只有 `src/process/terminal-child.ts` 2 处、`tests/process/terminal-spawn.test.ts` 8 处、`scripts/open-vm-lane.ps1` 2 处；其余 9 处在 docs（历史稿子不改，`manual-tests.md` 与 `issue-wake-claude-confirm.md` 改口径）。通知标签 `source="lane"` → `source="plugin:lane:lane"` 在代码里没有写死的匹配。
- 问答页（inbox 2026-10-21 列）：新问答的 lane 列表里「窗口打开后要你在窗口里点一下确认」删掉、与 Codex 写法一致；`wakeNotice` 的 Claude `launch_requested` / `skipped_launching` 里「请在窗口里点『I am using this for local development』」删掉（`CLAUDE_NUDGE` 那半句 LR-25 这批已先删）；`IssueWakeResult.backend` 保留；`2026-10-20-issue-wake-claude-confirm.md` 标「插件迁移后作废」。`techniques/lane-router-issues.md` 只写短名，不用动。
- 上线：build + 重启核心（+ `-CodexHost` 若说明文字改了）；所有 Claude lane 关掉再 `open` 一次吃新参数（重开已免弹）。
- 回滚：老路径不删——`claude mcp add` 回用户级注册、launcher 换回开发标志；白名单可留。

## 四、已知代价清单（给用户拍板用）

- 工具全名变 `mcp__plugin_lane_lane__*`：权限放行规则、hooks、规范和文档全部改名。
- `<channel source="lane">` 变 `plugin:lane:lane`：Router 的说明文字、规范改。
- 用户级 `lane` MCP 要撤，手工开的会话换 `--channels plugin:lane@lane-local`。
- 每台跑 lane 的机器：装插件 + 管理员改托管设置（替换默认 channel 插件列表）。
- Codex 侧不受影响。
