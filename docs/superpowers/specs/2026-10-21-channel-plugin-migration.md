# Claude lane 的通道改走插件：免点「开发通道确认」—— 需求与设计

**状态：** 需求与设计合一稿，2026-10-21 由 `lane-router/design` 起草；用户在问答 `3ade2628` 批准隔离实测、管理员改托管设置，并于 09:52 回「没问题，出稿并推进吧」。取证见 `2026-10-21-channel-plugin-research.md`（文档调研 + 第 3 / 4 步实测）。Vikunja LR-24。**前置：LR-30 先修**（同会话两个 lane 服务器互挤）。实现：`lane-router/impl`（插件打包、launcher、测试、安装脚本、文档）；`lane-router/design`（规范仓、Router 说明文字核对、两台机器的安装与真机验收）；`lane-router/inbox-impl`（问答页文案，由 inbox 派）。

## 一、问题与结论

用户原话（9ee7440d）：「这个每个开发通道要点一下感觉很吃力啊？能不能有什么办法不点这个啊？这样 lane 的创建就能全自动了。」

现状：Claude lane 用 `claude --dangerously-load-development-channels server:lane` 启动，Claude Code 2.1.304 对这个开发标志**每次启动都弹** `DevChannelsDialog`，没有任何设置能跳过；弹窗期间 MCP 服务器不启动、通知进不来，所有自动开 lane / 唤醒 / 换代都卡在人点一下上（今晚实测 probe-b 等了 4 分钟、probe-b 恢复窗口等了 3 小时）。

**结论**：把 lane 的通道改成由**插件**提供——Claude Code 只对托管白名单里的插件通道免弹窗。实测（第 4 步）：白名单生效后 `claude --channels plugin:lane@lane-local` 起的会话不弹任何框、通道注册成功、发信 6 秒内无人打字起回合、通知标签 `source="plugin:lane:lane"`。本稿把这条路做成生产路径：插件随仓库走、launcher 换启动参数、撤掉用户级 `lane` 注册、把写死旧名字的几处改掉，并给出两台机器的上线顺序与回滚。

## 二、术语

| 词 | 含义 |
|---|---|
| 开发标志 | `--dangerously-load-development-channels server:<名>`：把一个用户级 MCP 服务器当通道用，每次启动弹框。 |
| 插件通道 | 由插件的 `.mcp.json` 提供的 MCP 服务器，以 `--channels plugin:<插件>@<marketplace>` 启用；列在托管 `allowedChannelPlugins` 里才注册、不弹框。 |
| `lane-local` / `lane` | 本仓 `tools/channel-plugin/` 里的本地 marketplace 名与插件名；Claude 里服务器名 `plugin:lane:lane`，工具名 `mcp__plugin_lane_lane__<tool>`。 |
| 用户级 `lane` | `claude mcp add -s user lane -- node <dist>/mcp/lane-mcp-server.js` 注册的那一个，和插件跑的是同一份代码。 |

## 三、取证（摘要，细节在调研笔记）

- 白名单是必经一步：未列入时 MCP 日志 `Channel notifications skipped: plugin lane@lane-local is not on the approved channels allowlist`；列入后 `Channel notifications registered`。`allowedChannelPlugins` 只在托管来源生效、替换官方默认列表（本机不用官方 channel 插件，无损失）；本机 `C:\Program Files\ClaudeCode\managed-settings.json` 已写入。
- 用户级 `lane` 与插件**不能并存**：同一会话两个服务器同 joinKey + conversationId，Router 每 ~110 ms 一条 `join.channel_connected`，`lane_attach_current` 挂不上 → LR-30。`--strict-mcp-config` 会连插件一起关掉，不能用作隔离。
- 改名落点（grep `source="lane"` / `server:lane` / `mcp__lane__`）：用户 `settings.json` **0 处**（权限规则、hooks 都没按全名写）；规范仓 `techniques/lane-router.md` 3 处；本仓 `src/process/terminal-child.ts:58-59`、`tests/process/terminal-spawn.test.ts`（8）、`scripts/open-vm-lane.ps1`（2）；其余在历史 docs。`LANE_ROUTER_INSTRUCTIONS` 与工具描述只用短名（`lane_send` 等），Codex 宿主、zcode、lifecycle hook（joinKey 仍是 `CLAUDE_PID`）都不涉及。
- 本地目录 marketplace **原地加载、不复制**，`${CLAUDE_PLUGIN_ROOT}` 指向仓库里的插件目录；改源码下次会话生效。目录信任框与通道无关，每个新目录仍弹一次。
- 插件装在 local scope（某目录的 `.claude/settings.local.json`）只影响该目录的会话；生产要用 user scope。

## 四、设计

### 4.1 插件打包（随仓库）

`tools/channel-plugin/`（骨架已提交 `c0ecedd`，第 4 步用的就是它）：

- `.claude-plugin/marketplace.json`：`name: "lane-local"`，一条插件 `lane`，`source: "./plugins/lane"`。
- `plugins/lane/.claude-plugin/plugin.json`：`name: "lane"`，`channels: [{ server: "lane", displayName: "Lane Router" }]`。
- `plugins/lane/.mcp.json`：**改成可移植**——`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.mjs"]`（现在写死的绝对路径作废）。
- `plugins/lane/server.mjs`（新增，一行）：`import "../../../../dist/mcp/lane-mcp-server.js";`——按文件位置解析，不在 `args` 里用 `..`，不依赖机器路径；仓库搬家也跟着走。
- 名字就用 `lane-local` / `lane`（用户未提异议）。`claude plugin validate tools/channel-plugin` 必须通过。

### 4.2 每台机器一次性安装：`scripts/install-channel-plugin.ps1`

顺序固定，幂等，可重复跑：

1. `claude plugin validate <repo>\tools\channel-plugin`；
2. `claude plugin marketplace add <repo>\tools\channel-plugin`（已存在则跳过）；`claude plugin install lane@lane-local`（**user scope**）；
3. 读 `C:\Program Files\ClaudeCode\managed-settings.json`：含 `allowedChannelPlugins` 里的 `{ marketplace: "lane-local", plugin: "lane" }` 则继续；否则**不写**（要管理员），把应写入的完整 JSON 打印出来并退出非零——这一步由用户以管理员做（本机已做；家里那台要一次 UAC）。
4. `claude mcp get lane` 若显示用户级注册存在 → `claude mcp remove lane -s user`（**必须**，否则并存触发 LR-30）；
5. 打印收尾提示：开着的 Claude lane 要关掉再 `lane-router-lane open` 一次才吃到新参数。

脚本不碰 Router、不碰任何 lane、不碰托管文件。

### 4.3 launcher 换启动参数

- `src/process/terminal-child.ts:58-59`：两处 `"--dangerously-load-development-channels", "server:lane"` → `"--channels", "plugin:lane@lane-local"`（`new` 与 `--resume` 两条路）。
- `scripts/open-vm-lane.ps1`：**本次不动**（2026-10-21 impl 开工时发现、design 定）：它在 Linux 虚拟机上起 `claude`，那份 Claude Code 是独立安装、用自己的用户级 `lane` 注册，插件没装、托管白名单要写 `/etc/claude-code/managed-settings.json`、`server.mjs` 要指到虚拟机的 `dist`；照改会让虚拟机 lane 没有通道。脚本继续用开发标志，并写一句原因；虚拟机迁移见 Vikunja LR-58（用户下次要在虚拟机开 lane 时做）。
- `tests/process/terminal-spawn.test.ts`：期望改为新参数，并断言**不再**含开发标志。
- `rotation-launcher` / `lane-launcher` 走 terminal-child，不另改。
- 手工起会话的写法同步进规范（4.5）。

### 4.4 迁移顺序（每台机器）

1. **LR-30 上线**（Router 拒绝同 joinKey + conversationId 的第二条连接；客户端收 4409 不重连）。
2. `npm run build`，部署含 4.3 的核心（重启核心即可；说明文字未改则不需要 `-CodexHost`）。此时开着的 lane 仍用旧服务器照常工作；**在用户级注册撤掉前不要开新 lane**。
3. 跑 `scripts/install-channel-plugin.ps1`：装插件、核白名单、撤用户级注册。
4. 新开 / 唤醒 / 换代的 Claude lane 从此走插件通道，不弹框。开着的旧会话逐条关掉再 `open`（重开已免弹）；不必一次全重开，旧会话继续能用。
5. 规范与文档改口径（4.5），问答页文案（4.6）随 inbox 的批次上线。

家里那台：拉代码 → 同样 1–4；托管白名单那步用户自己提权写一次。

### 4.5 规范与文档（design）

- `agent_coding_guidelines/techniques/lane-router.md`：`:59` 启动命令改 `claude --channels plugin:lane@lane-local`，安装一节加「装插件 + 托管白名单 + 撤用户级注册」三步与 `install-channel-plugin.ps1`；`:62` 改成「插件通道不弹框；开发标志仅调试用」；`:362` 故障排查改成：没通知先看 MCP 日志 `mcp-logs-plugin-lane-lane` 有没有 `Channel notifications registered`，有 `not on the approved channels allowlist` ⇒ 托管白名单没写；工具名写法改 `mcp__plugin_lane_lane__*`，通知标签 `source="plugin:lane:lane"`。
- 本仓 `docs/manual-tests.md` TC-LANE-NEW 第 3 步「每次启动都弹」改成「不弹；目录信任框仍每个新目录一次」；`docs/README.md` 索引加本稿。
- 调研笔记保持为取证记录，不改。

### 4.6 问答页（inbox-impl，由 inbox 派）

- 新问答的 lane 列表：没开着的 Claude lane 后面的「窗口打开后要你在窗口里点一下确认」删掉，与 Codex 写法一致。
- `wakeNotice`：Claude `launch_requested` / `skipped_launching` 里「请在窗口里点『I am using this for local development』」删掉（`CLAUDE_NUDGE` 半句已在 LR-25 批次删）。
- `IssueWakeResult.backend` 保留。
- `2026-10-20-issue-wake-claude-confirm.md` 标「插件迁移后作废」。

### 4.7 不做

- 不保留「开发标志 / 插件」双路径开关：切换是一次性的，回滚靠 revert（4.8）。
- 不改 Router 协议、不改 lifecycle hook、不改 Codex / zcode 路径。
- 不做自动替用户点回车的过渡方案。
- 不把插件装成 local / project scope 做生产（只在隔离实测用过）。

### 4.8 回滚

任一台机器出问题：`claude mcp add -s user lane -- node <repo>\dist\mcp\lane-mcp-server.js` 放回用户级注册 → `claude plugin uninstall lane@lane-local` → revert 4.3 的提交并重建、重启核心 → 开着的 lane 关掉重开。托管白名单可留（无害）。调研笔记里有第 4 步前后的所有命令与读数。

## 五、范围审计

| 候选面 | 使用者/频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 插件目录 `tools/channel-plugin/` + `server.mjs` | 每台机器一次 | 原话「不点这个」（explicit）；白名单只认插件（取证） | 回到每次弹框 | 无 | 保留 |
| `${CLAUDE_PLUGIN_ROOT}/server.mjs` 间接层 | 同上 | 两台机器路径不同（explicit：家里也用） | `.mcp.json` 写死路径，每台机器改一次且不能提交 | 写死绝对路径 | 保留（一行） |
| `scripts/install-channel-plugin.ps1` | 每台机器一次、回滚时一次 | 两台机器 + 顺序错了会撞 LR-30（取证） | 手敲四条命令、漏撤注册即风暴 | README 列命令 | 保留，幂等、不碰托管文件 |
| launcher 参数改 `--channels plugin:lane@lane-local` | 每次开 lane | 原话（explicit） | 不弹框做不到 | — | 保留 |
| 撤用户级 `lane` 注册 | 每台机器一次 | 并存即 LR-30（取证） | 风暴 | — | 保留（脚本做） |
| 开发标志 / 插件双路径开关 | — | 推断（回滚方便） | 回滚要 revert + 重建 | revert | 删除 |
| 自动替用户点回车 | — | 用户没要 | — | — | 删除 |
| 规范 / 文档改口径 | 所有 lane | 名字变了不改会误导（取证：3 处 + 若干 docs） | 新 lane 按旧名字找工具 | — | 保留 |
| 问答页文案 4 处 | 用户 | inbox 列出（explicit） | 页面继续叫用户点不存在的框 | — | 保留（inbox-impl） |
| 托管白名单写入脚本（提权） | — | 用户已自己提权一次；家里再一次 | 脚本要 UAC 流程 | 用户手写 / 粘贴 JSON | 删除（脚本只打印 JSON） |

不新增 Router 路由、协议、持久状态、工具、参数。

## 六、验收标准

自动测试：

1. `tests/process/terminal-spawn.test.ts`：`new` 与 `--resume` 两条命令行都含 `--channels plugin:lane@lane-local`，**不含** `--dangerously-load-development-channels`；`scripts/open-vm-lane.ps1` 里的两处**保持**开发标志（本次不迁，见 4.3）；若既有的逐字节核对用例把它和 TS 绑在一起，改成只核对 Windows 那条路。
2. 插件清单测试（node 组）：读取 `tools/channel-plugin` 的 `marketplace.json` / `plugin.json` / `.mcp.json`：marketplace 名 `lane-local`、条目名与 `plugin.json.name` 都是 `lane`、`channels[0].server === "lane"`、`.mcp.json` 的 `args` 为 `${CLAUDE_PLUGIN_ROOT}/server.mjs`；`server.mjs` 存在且 import 的相对路径解析到仓库里的 `dist/mcp/lane-mcp-server.js`（构建后）。
3. `server.mjs` 冒烟（node 组，构建后跑或标 build 组）：用 stdio 起它、发 MCP `initialize`，返回 `serverVersion.name === "lane-router"` 且 `capabilities.experimental["claude/channel"]` 存在——证明间接层起的是同一个服务器。
4. 既有 launcher / terminal-child / rotation 测试全过；`npm test`、`npm run typecheck` 全过。

脚本（手工，记 manual-tests）：

5. `install-channel-plugin.ps1` 在已装好的机器上重复跑：全部「已存在，跳过」、退出 0；在托管白名单缺失的环境跑：打印 JSON、退出非零、不写文件；`claude mcp get lane` 从「存在」到「不存在」。

真机（本机，LR-30 上线后）：

6. 跑脚本后 `lane-router-lane new lane-router/<probe>`：**不弹开发通道框**（目录已信任的前提下无任何点击），MCP 日志 `mcp-logs-plugin-lane-lane` 有 `Channel notifications registered`，`mcp-logs-lane` 没有新文件；attach 成功；发信无人打字起回合、回信标签 `source="plugin:lane:lane"`。
7. 一条旧会话 lane 关掉后 `lane-router-lane open`：命令行含新参数、不弹框、重连后处理 pending。
8. `lane-router-rotate` 一次：成功换代、不弹框。
9. Router 日志里这三条会话各只有一条 `join.channel_connected`、无 `duplicate_refused`、无重连循环。
10. 家里那台机器按 4.4 走一遍 6–8（用户提权写白名单那一步由用户做），结果由用户在问答回一句。
11. 规范 `techniques/lane-router.md` 三处改好，`scripts/kb/kb.py lint` 不报错；问答页四处文案改好（inbox 验收）。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；插件清单与 `server.mjs` 冒烟在构建后跑（主检出不 build，构建归部署）。
- 变异：launcher 任一处换回开发标志 → 1 红；`.mcp.json` 写回绝对路径 → 2 红；`server.mjs` import 错路径 → 2、3 红；marketplace 条目名与 `plugin.json.name` 不一致 → 2 红；脚本漏掉 `claude mcp remove` → 5 红（且真机 9 会出现循环，前提 LR-30 已上，则为 `duplicate_refused`）。

## 八、边界

- 只动：插件目录（`.mcp.json` 改可移植、加 `server.mjs`）、`terminal-child.ts` 两处参数、`open-vm-lane.ps1` 只加一句注释（不改参数）、一个安装脚本、测试、规范与文档、问答页四处文案。
- 不动：Router 协议与路由、lifecycle hook、Codex / zcode 后端、`lane-mcp-server.ts`（LR-30 的客户端退避是另一稿）。
- 顺序硬约束：LR-30 → 本稿；每台机器先撤用户级注册再开新 lane。
- 上线：build + 重启核心；可与 LR-27 / LR-28 / 问答分组同批（那批要 `-CodexHost` 与账号后台重启，本稿不额外要求）。
