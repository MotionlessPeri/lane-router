# 唤醒重通知：连上并通知后没有 lifecycle 且仍有积压 → 有界退避再通知 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/design` 起草。来源是部署后真机验收（`lane-router/inbox`，议题 `205a897d`）发现的现有缺陷，design 取证、inbox 复测确认。Vikunja LR-25。实现归 `lane-router/impl`；只改 Router 核心，上线只重启核心（不带 `-CodexHost`），可与 inbox 的「唤醒 Claude lane 要点确认」文案补丁一批。

## 一、问题与结论

**问题**：恢复一条带积压信的 Claude lane，没人打字它不处理。Router 半边已经对了——Fix 1 把缓冲的通知帧在频道连上 2 毫秒内送出（`lastNotifiedAt = connectedAt + 2 ms`）；但那一瞬会话还在**启动窗口**里（装 transcript、`DevChannelsDialog` 弹窗、REPL 还没开始听频道），Claude Code **不回放启动期间收到的频道通知**，于是帧到了、没起回合（`lastLifecycleAt` 一直 null），信留在 mailbox 里没人读。

**结论**：Router 侧加一条**有界重通知**：lane 连上并被通知后，若一段时间内没观测到它的 lifecycle 事件、而它仍有 pending 邮件，就按退避表再送一次通知帧；观测到 lifecycle、pending 清空或频道断开即停。重的只是通知帧，不重发邮件；不改投递语义、不加工具、不加配置项。

## 二、术语

| 词 | 含义 |
|---|---|
| 通知帧 | Router 经 Claude 频道发给会话的唤醒索引（lane 地址、`pendingPath`、消息 ID 列表），不含正文。`lastNotifiedAt` 记最近一次送出。 |
| lifecycle | lane 的 Claude hook 报给 Router 的回合事件（turn 开始/结束）。`lastLifecycleAt` 非空 ⇒ 会话真的跑过回合。 |
| 积压（pending） | 该 lane mailbox 里尚未 `lane_ack` 的邮件。 |
| 启动窗口 | 会话从进程起来到 REPL 开始处理频道通知之间的时间。本机实测含：装 transcript（59 MB 用了 3 分 50 秒）、`DevChannelsDialog`（每次启动都弹、要人点）。 |

## 三、取证

- 2026-10-20 17:17 inbox 给离线的 `SinglePivotTool/main` 发测试信后 `open`：`claude.exe` 17:17:54 起；两个 MCP 子进程 **17:21:44** 才拉起（Claude Code 先装 transcript 再起 MCP），`connectedAt` 17:21:47，`lastNotifiedAt` 17:21:47.088；之后 `lastLifecycleAt` 一直 null、测试信一直 pending。transcript 59,263,439 字节。
- inbox 复测：再发一封信，几秒内 `lastLifecycleAt` 变非空、两封信一起处理、收到回信 ⇒ 频道健康，丢的只是启动窗口里那一次唤醒。
- 已知平台行为：通用仓 `techniques/lane-router.md:362`「会话刚（重）启动那一瞬间到达的通知不会唤醒它（消息不丢，下一次唤醒会一并带出）」。本稿不改这条平台事实，只在 Router 侧补偿。
- `DevChannelsDialog` 每次启动都弹、无设置可免（impl 查 Claude Code 2.1.304 源码），所以「恢复时就带积压」的 lane 首帧**必然**落在窗口里，不是偶发。

## 四、设计

### 4.1 触发与停止

对每条 **Claude 后端**的 lane，Router 在送出通知帧后启动一个重通知周期：

- **继续重通知的条件（全部成立）**：频道仍连着；自最近一次通知以来没有观测到该 lane 的 lifecycle 事件（`lastLifecycleAt === null` 或 `lastLifecycleAt < lastNotifiedAt`）；该 lane 仍有 pending 邮件；**且会话不在回合中**——「不在回合中」= 最近一次 lifecycle **不是**「有 `UserPromptSubmit` 而其后还没有 `Stop`」。
- **回合中不重发（impl 2026-10-20 审稿指出）**：lane 正在跑一个长回合时，它的 `UserPromptSubmit` 在这一帧之前、`Stop` 要等回合结束，光看「通知后有没有 lifecycle」会把它当成没醒；而 Claude Code 会把回合中途到的通知排队、回合结束再交给会话（`src/process/local-server.ts:220` 的注释），此时重发只会制造最多 4 条重复提醒，且这个场景比启动窗口常见得多。所以：最近一次 lifecycle 是 `UserPromptSubmit` 且其后无 `Stop` ⇒ 回合在跑 ⇒ **不重发并取消本轮**；回合结束的 `Stop` 本来就会让 pump 对未处理的信再发一帧（现有行为），那一帧重新开始一轮。还没有任何 lifecycle（启动窗口）的情况不受影响，照常重发。实现上连接要记「最近一次 lifecycle 的种类」；现有 `busy` 不能用（`notify` 每次发帧都置 true）。
- **停止条件（任一成立即取消剩余计划）**：观测到 lifecycle；pending 清空；频道断开（断开后的重连走 Fix 1 的首帧，周期重新开始）；退避表用尽。

### 4.2 退避表

自最近一次送出起：**15 s → 60 s → 180 s → 600 s**，共 4 次，总约 14 分钟。依据：大多数会话 15–60 s 内就绪；59 MB transcript 这种长尾 3–4 分钟；600 s 给「用户几分钟后才回来点弹窗」留余地。超出即停：此时 lane 要么真空闲但无响应，要么用户不在；下一封进信照常唤醒，页面文案（inbox 补丁）也已告诉用户「再回一句」。常量写死在代码里，不加配置项。

**一轮的起点**：凡是不是重通知计时器自己发出的帧——新信到达、`Stop` 触发的 pump、重连后的首帧——都让这一轮从头开始、计数归零；只有计时器发出的帧才往下走一档；四档用完即停。新信重开一轮不会刷屏：每次重开都对应一帧真实的新通知，且每轮至多 4 次。

实现判据（impl 2026-10-20）：「不是计时器发的帧」= **这一帧带有本轮尚未提醒过的消息 ID**。原因是 pump 一次提醒可能拆成几帧（先 normal、再异步 correction），后几帧不带新 ID，不能当成新一轮。三条真实路径都落在这个判据上：新信带新 ID；`Stop` 之前 lifecycle 处理已把周期清空；重连后连接是新的、周期本来为空。

### 4.3 重发什么

同一种通知帧，内容按**送出时刻**的 pending 集合重算（ID 列表可能比首帧多）。不重发邮件正文；lane 读到已 ack 过的 ID 不当新任务（通用仓 `lane-router.md:230` 已有此纪律）。

### 4.4 快路径：核实不成立，不做

impl 2026-10-20 核实：`src/adapters/claude/lifecycle-hook.ts` 的 `isLifecycleInput` 只认 `Stop` 与 `UserPromptSubmit`，`SessionStart` 不会报给 Router。**本稿不做事件驱动的快路径、不另造 hook**，只做 4.2 的退避。

### 4.5 落点与观测

- 落点：计时器挂在 `ClaudeChannelHub` 的连接上，断开即清（天然只影响 Claude）；按连接保持「上次通知时刻、已重试次数、最近一次 lifecycle 的种类」三项内存状态；**不持久化**（Router 重启 ⇒ 频道全部重连 ⇒ Fix 1 首帧 ⇒ 周期重新开始）。到点时**不发旧帧**，而是像现有的连上、`Stop` 那样触发一次「注意时机」，让 pump 的 `notifyLane` 按当时的积压重算 ID 再发；积压空了 pump 就不发，停止条件「pending 清空」自然成立。绕开 `signal()`——它还会放行等着接管的调用。
- 观测：每次重通知写一条 Router 日志，事件 `channel.renotify`，字段 `laneAddress`、`conversationId`、`attempt`、`sinceFirstMs`（距本轮首帧的毫秒数，与 join 事件的 `deltaMs` 口径一致）、`at`；每行一个 JSON，与 join 事件同路写进 stderr（`router-start.log`）。不往 reach 快照或看板加字段。
- 范围：只针对 Claude 后端的频道路径。Codex 的「thread 未加载 + 开了 TUI 不触发投递」是宿主路径的另一件事（此前 Fix 2 的范围），本稿不碰。

## 五、范围审计

| 候选面 | 使用者/频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 有界退避重通知（4.1–4.3） | 每次恢复带积压的 Claude lane | 真机验收失败 + 复测（explicit） | 「没人打字也处理」做不到 | 用户手动再回一句 | 保留 |
| SessionStart 快路径（4.4） | 同上 | 推断：更准，但未核实 hook 是否报 | 无（退避已覆盖） | 4.2 | 内化为可选，impl 核实后定 |
| reach 快照 / 看板加「重试次数」字段 | 调试 | 无用户需求 | 无 | Router 日志 | 删除 |
| 退避常量可配置 | 无 | 无 | 无 | 写死 | 删除 |
| Codex 路径同类补偿 | — | 不同机制、未取证 | — | 另稿 | 推迟 |

不新增进程、协议、持久状态、公共接口、命令或参数；只有一个内存计时周期 + 日志。

## 六、验收标准

自动测试（node 组，用假后端记录「通知帧送出」次数与时刻，用可控时钟）：

1. 送出首帧后无 lifecycle、pending 非空：15 s、75 s、255 s、855 s 各再送一次，之后不再送（共 5 次含首帧）。
2. 首帧后 20 s 内观测到 lifecycle：不再送任何重通知。
3. 首帧后 pending 被 ack 清空：不再送。
4. 首帧后频道断开：取消剩余计划；重连后首帧重新送出且周期从头开始。
5. 重通知帧的消息 ID 列表包含送出时刻全部 pending（首帧后新到的信也在）。
6. **回合中不重发**：一条正在跑长回合（≥ 15 s）的 lane 在回合中收到信，回合期间不发任何重通知帧（计时取消）；回合 `Stop` 后由 pump 正常发一帧，并从那一帧起重新开始一轮（验收 1 的节奏从这帧重算）。
7. 既有通知/投递/ack 测试全部仍通过（证明没改投递语义）。
8. `npm test`、`npm run typecheck` 全过。

真机（部署后新开/恢复的会话里）：

9. 给一条离线、transcript 大的 Claude lane 发一封信后 `open`，不打字、不补信：在退避表内 `lastLifecycleAt` 变非空、积压被处理、回信到达；Router 日志里能看到重通知记录。记入 `docs/manual-tests.md`。
10. 给一条在线空闲的 Claude lane 发一封信：它立刻处理，日志里**没有**重通知记录；再给一条正在跑长回合的 lane 发一封信：回合期间日志里**没有**重通知记录，回合结束后它处理这封信（证明两种情况都不误触发）。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；主检出不 build。
- 变异（改坏一处看对应用例变红，看完改回）：去掉 lifecycle 停止条件 → 2 变红；去掉 pending 停止条件 → 3 变红；断开不清计时 → 4 变红；退避表少一档或不封顶 → 1 变红；重发帧用首帧的旧 ID 列表 → 5 变红；去掉「回合中不重发」的判断（或改用 `busy` 代替 lifecycle 种类）→ 6 变红。

## 八、边界

- 不改 Claude Code 的行为，不改 lane hook；不重发邮件正文；不加工具、参数、配置、持久状态、页面字段。
- 只覆盖 Claude 后端；Codex 另稿。
- 上线：Router 核心重启即生效，不需要 `-CodexHost`；LR-24（插件路线免弹）上线后长尾会缩短，但本稿不依赖它。
- 文案补丁里「点完没动再回一句」那句，在本稿上线、真机第 8 条通过后由 inbox 删掉。
- **后续（LR-31，2026-10-21 真机发现）**：客户端「排队不丢帧」时（inbox 停在 `/mcp` 菜单 6 小时，解冻后 ~50 帧各起一段回合输入），重通知只会放大涌入。口径：一轮四档都发完、期间无 lifecycle ⇒ 进入静默，之后新信只发它自己那一帧、不再开新一轮，收到 lifecycle 后恢复。本稿不改，记 LR-31。
