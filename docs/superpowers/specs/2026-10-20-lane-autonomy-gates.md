# lane 自主性：放宽拓扑确认与开工等待 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/design` 起草，用户已在问答定口径（议题 `9ee7440d` 开新/唤醒/轮换确认、`5fed7f03` 开工等待）并要求推进。稿子过 gate 后交 `lane-router/impl` 实现 src/ 与测试；规范仓文档由 design 改。Vikunja LR-18、LR-19。

## 一、背景与结论

用户两条诉求（原话）：

- 议题 `9ee7440d`：「现在开新 lane 和唤醒 lane 都要我显式同意，我觉得这个规范有点过时了，需要去掉」。追问后定：「轮换可以去掉确认。我很需要一个 agent 连续工作很长时间后自己 rotate 再继续」；「接替和改说明先留着」。
- 议题 `5fed7f03`：「lane 开了不自动工作要我手动开工一下……是不是也要去掉」。定：「没有被授权任务就绪，或者 bootstrap prompt 明确要求不继续再停」。

**结论（锁定口径）：**

| 动作 | 现在 | 改成 |
|---|---|---|
| 开新 lane | 要用户确认 | **放行** |
| 唤醒 / 恢复离线 lane | 只在用户明确要求时 | **放行** |
| 轮换（同角色、换代续自己） | 要用户确认 | **放行** |
| 接替（抢占一条另有 live 会话的别的 lane） | 要用户确认 | **保留确认** |
| 改一条已有 lane 的角色说明 | 要用户确认 | **保留确认** |
| 新建/恢复的 lane 开工 | 一律「报就绪后等指令、不自己干活」 | **有已授权的活就接着干；没有就读透现状报就绪；prompt 显式要求停才停** |

**关键取证结论（决定了本稿的形态）：这道确认闸不是代码闸，是给 agent 的指令文字。** 普通 MCP 工具路径 `src/tools/tool-service.ts:28-30` 调 `attachCurrent` 时不传 `rejectTakeover`，即默认就会接管；`ATTACH_CONFIRMATION` 末句明写「不要加确认参数」。真正让 agent 停下来问用户的，只有工具描述和 `LANE_ROUTER_INSTRUCTIONS` 里这段指令文字。而且 `attachCurrent` 接管前先 `waitUntilReplaceable`，不会顶掉一个**正在忙**的持有者。

所以放宽这道闸 = **改指令 / bootstrap prompt / 规范文档的文字，不在 `router-core` 里加任何谓词**。这比加代码闸风险低，也和现有「不加机械确认参数」的设计一致。「轮换 vs 接替」由 agent 自己分（它知道自己是在续自己的角色，还是在抢别人的 lane），指令把判据讲清即可。

## 二、术语

| 词 | 含义 |
|---|---|
| 开新 lane（create） | attach 到一个还没有 lane 行的地址（归档地址也算空），新建一条 lane。`router-core.ts:265-276`。 |
| 轮换（rotate / self-continuation） | 同一个角色换一代续自己：要么同一会话重新 attach 同地址（`router-core.ts:250-263`，不升代），要么上下文满了之后新开一个进程/会话 attach 回同地址同角色（走接管路径、升一代）。 |
| 接替 / 抢占（takeover） | 一个会话把一个**由另一条 live 会话持有**的地址拿过来。默认 `waitUntilReplaceable` 等持有者空闲后 CAS 换绑、升一代（`router-core.ts:277-326`）。 |
| 改角色说明（change role） | attach 时带一个与现存不同的 `role_description`，改写这条 lane「是干嘛的」。只有同会话续自己那条分支会把它识别为「改动」（`router-core.ts:254-256`）。 |
| 唤醒 / 恢复（wake / restore） | 为离线 lane 重开可见终端、恢复原会话。`lane_restore_project` 工具或 CLI `open`。它不是拓扑变更、不升代。 |

## 三、现状取证

### 3.1 确认闸是指令，不是代码

- `src/tools/tool-contract.ts:17` `ATTACH_CONFIRMATION` = 「Before creating, replacing, rotating, or changing the role description of a lane, explain the proposed topology change and obtain the user's explicit confirmation in the conversation. Do not add a confirmation argument.」—— 把四个动作捆在一句话里。
- 被 `:21`（`lane_attach_current` 描述）和 `:27`（`LANE_ROUTER_INSTRUCTIONS`）引用。
- `src/tools/tool-service.ts:28-30`：普通 MCP 工具路径调 `attachCurrent` 不传 `options`，即**默认接管**。只有 Host 托管后端（DSH `local-server.ts:704`、native `native-host-service.ts:64-66`）才传 `rejectTakeover: true`。
- 所以 Claude/Codex/zcode 交互式调 `lane_attach_current` 时，代码层面能力上就允许接管，唯一拦着的是这段**指令文字**让它先问。

### 3.2 接管已经等空闲，不顶忙的

`router-core.ts:277-326`：地址已被别的会话绑着时，默认 `await backends.require(observed.backend).waitUntilReplaceable(observed, signal)`，等持有者可替换（空闲、无未投递）后再 `replaceBinding`（CAS，变了就 `BINDING_CHANGED`）。只有传 `rejectTakeover` 才直接报 `LANE_ALREADY_BOUND`。换绑后 `pump.notifyLane` 让接过来的积压跑一轮。

### 3.3 轮换和接替在工具层同形，由 agent 区分

Router 对「新开进程/新会话 attach 到一个占用地址」不区分是自续还是抢占——两者都走 `:277-326`、都升代（`generation = (observed?.generation ?? 0) + 1`，`:292`）。唯一天然能被 Router 认出的「自续」是**同一个会话身份**重新 attach（`:250-263`，走 `activeBindingForConversation`，不升代）；但那是幂等重连/改角色，不是上下文满了换代的轮换。换代轮换和接替的区别只有「attach 的会话是不是原持有者那个逻辑 agent」，Router 自身没有这个信号。→ **这正是为什么判据放在指令里由 agent 自己把握，而不是放在代码里。**

### 3.4 liveness 信号（给指令措辞做依据）

- `ReachState`（`router-core` 相关 `types.ts:15`）= `"live" | "unconfirmed" | "no_channel"`：`no_channel` 无连接；`unconfirmed` 有连接但没观测到 lifecycle；`live` 观测到过 turn。
- `believedBusy`：Router 的判断（DSH/zcode/native 有，Codex 恒为 `null`——要问 app-server）。
- 判断「地址当前被另一条活着的会话占着」的现成复合式（接替 idle 门禁 `router-core.ts:374` 用的就是它）：`reach.state === "live" && reach.believedBusy !== false`，再把持有者 `binding.conversationId` 和自己的身份比，确认是「别人」。
- 这些是**给指令措辞做参照**，不是要在工具路径里新加判断。

### 3.5 唤醒的现状

`tool-contract.ts:24` `lane_restore_project` 描述含「Call only when the user explicitly asks to reopen lanes.」；CLI `open`（`lane-launcher.ts:152-178`）只恢复已有 active binding，拒绝 missing/archived/unbound/online。唤醒用的是 `restorePresence`（`backend.ts:4`，`online|offline|unavailable`），与 `reach` 有意分开（Codex app-server 关了 TUI 仍留着 thread）。

### 3.6 开工等待的现状

- 新建 lane 的 bootstrap prompt，`lane-launcher.ts:289-294` `creationPrompt`，结尾：「Afterwards report that the lane is ready and wait for direction; do not start feature work on your own.」开头：「This is an approved creation of the new lane …」。
- zcode 版 `:278-287` `zcodeIntroPrompt`，结尾：「…confirm in one short line that you are ready and wait for direction.」
- 恢复/打开的 lane：`open` 不注入新 prompt，直接恢复原会话；其「等指令、不另造工作」的行为来自规范（`agent_coding_guidelines/techniques/lane-router.md` 部署恢复一节 `:347-349`「原本等用户决定或没有新任务的，恢复原等待状态，不另造工作」）和唤醒后处理 mailbox 的机制（刚修的唤醒 bug 就是让被唤醒的 lane 能处理 pending mailbox）。

## 四、设计

全部是文字改动。分四处落点：`src/tools/tool-contract.ts`、`src/process/lane-launcher.ts`、`scripts/open-vm-lane.ps1`（VM 上建 lane 用的 creation prompt 副本，`:138`，impl 2026-10-20 发现）、规范仓 `agent_coding_guidelines/techniques/lane-router.md`。**不动 `router-core`、不加工具参数、不改接管/等空闲/升代的代码行为。**

### 4.1 `ATTACH_CONFIRMATION` 收窄（`tool-contract.ts:17`）

把四合一那句改成只保留「接替 live 的别的 lane」「改已有角色说明」两种要确认，其余明说放行。建议文字（英文，因为是 agent 读的指令）：

> Creating a lane, waking or restoring an offline lane, and rotating yourself to a fresh generation of the same lane (keeping its role) do not need the user's confirmation. Before taking over a lane that a different, still-live conversation holds, or before changing an existing lane's role description, explain the change and obtain the user's explicit confirmation in the conversation. If you are unsure whether an attach would rotate your own role or displace someone else's live lane, treat it as a takeover and confirm. Do not add a confirmation argument.

- 它仍被 `:21`（工具描述）和 `:27`（`LANE_ROUTER_INSTRUCTIONS`）复用，一改两处同时生效，单一事实源不变。
- 「拿不准就当接替、要确认」是安全兜底：真正的忙持有者有 `waitUntilReplaceable` 挡着不会被顶，这句再给空闲持有者一层人判。

### 4.2 `lane_restore_project` 去掉「只在用户要求时」（`tool-contract.ts:24`）

把「Call only when the user explicitly asks to reopen lanes.」改成按需唤醒、别成批投机：

> Call when you need to reach offline peer lanes for the current task; wake only the lanes you actually need, not speculatively in bulk.

其余（omit lanes / 跨项目用 CLI `open`）不变。

### 4.3 开工等待改成分情况（`lane-launcher.ts`）

**`creationPrompt`（`:293`）**：开头「approved creation」改成中性「creation」（开新 lane 不再需要用户批）；结尾从一刀切改成：

> Afterwards, make sure you understand what this role covers and the project's current state, then report that the lane is ready. You have no assigned task yet, so do not invent feature work on your own — wait for direction, or for work addressed to you through your mailbox or 问答.

**`zcodeIntroPrompt`（`:286`）** 结尾同口径：

> Read the repository AGENTS.md if present, make sure you understand your role and the project's current state, then confirm in one short line that you are ready. You have no assigned task yet, so wait for direction or for work addressed to you rather than inventing work.

**`scripts/open-vm-lane.ps1:138`**：这里有一份 `creationPrompt` 的逐字副本（「This is an approved creation …」「…wait for direction; do not start feature work on your own.」），用于在 VM 上建 lane。按同一口径改成与上面 `creationPrompt` 完全一致的文字。该脚本没有自动测试：验收为逐字对照 + PowerShell 能解析（验收第 4 条附带）。

说明：全新 lane 本就没有被授权任务，落在口径的「没有被授权任务 → 读透现状后报就绪」一支，所以新建 prompt 的净变化是：措辞从「干等」改成「读透现状再报就绪」，并去掉「approved」。口径里「有已授权的活就接着干」主要作用于**恢复/打开**的 lane（见 4.4）。保留一条硬停杠杆：bootstrap prompt 里若显式写了「停下等指令、先不要继续」，就按它停——措辞上保留「wait for direction」字样，使创建方想让某条 lane 建好即停时仍可表达。

### 4.4 恢复/打开的 lane 自动续活（规范）

`open` 不注入新 prompt，所以这部分是**规范口径**（`agent_coding_guidelines/techniques/lane-router.md`），不是代码：

- 部署恢复一节 `:347-349`：把「原本等用户决定或没有新任务的，恢复原等待状态，不另造工作」补成：**被唤醒/恢复的 lane 先处理 pending mailbox 和 pending 问答（已点名的活），并自动接着自己停机前已授权、有 ETA 的任务继续；只有在没有任何已授权的活时才恢复等待状态；都不自己发明新功能活。**
- `:199`（`new` 是拓扑变更一段）里「报告就绪后等待指令」同步成 4.3 的新措辞。
- `:80 / :83 / :85` 三行按 4.1 / 4.2 的新口径改：拓扑确认只覆盖「接替 live 的别的 lane」和「改角色说明」；开新、唤醒、轮换放行；`lane_directory` 查重、能复用就复用、只为长期角色建仍作为习惯保留（非闸）。

### 4.5 规范仓一并校正的相邻过期内容

改 `lane-router.md` 时顺带不扩大范围：只改上述几行与确认/等待口径直接相关的文字，其余不动。（LR-17 记的 role 说明过期是另一条，不在本稿。）

## 五、范围审计

按 `auditing-plan-scope`。基线：用户要「开新/唤醒/轮换不再要我确认」「lane 开了能自动接着已授权的活干」。

| 候选面 | 使用者/频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 收窄 `ATTACH_CONFIRMATION` 文字 | 每条 lane 每次 attach | 用户原话（9ee7440d，explicit） | 开新/轮换仍被挡着问 | 无 | 保留（改文字） |
| `lane_restore_project` 去「只在用户要求时」 | 每条 lane 唤醒 peer 时 | 用户原话（explicit） | 唤醒仍要先问 | 无 | 保留（改文字） |
| 两个 bootstrap prompt 改措辞 | 新建 lane 首轮 | 用户原话（5fed7f03，explicit） | 新 lane 仍被叫「干等」 | 无 | 保留（改文字） |
| 规范恢复一节补「自动续已授权任务」 | 恢复/打开的 lane | 用户原话（explicit） | 恢复的 lane 仍停着等人 | 无 | 保留（改文档） |
| **在 `router-core` 加「轮换 vs 接替」代码谓词** | — | 无（现有代码已默认接管+等空闲；确认本就是指令） | 无（删了也满足全部需求） | 指令 + `waitUntilReplaceable` | **删除**（不做） |
| **给 `lane_attach_current` 加 rotate/confirm 参数** | — | 无；且与「不加确认参数」相违 | 无 | 指令判据 | **删除**（不做） |
| 改接管/等空闲/升代的代码行为 | — | 无 | 无 | 现状已足够 | **删除**（不做） |

一屏小结：**不新增任何进程、协议、持久状态、公共接口、命令或参数**；三处纯文字改动 + 一处规范文档。两个「本可以加但不加」的代码面（轮换判据、attach 参数）已显式否掉——取证表明它们不被任何需求支撑，加了反而和现有设计冲突。

## 六、验收标准

1. `ATTACH_CONFIRMATION` 新文字：含「creating / waking or restoring / rotating yourself … do not need the user's confirmation」且含「taking over a lane that a different, still-live conversation holds, or … changing an existing lane's role description … obtain the user's explicit confirmation」，且仍含「Do not add a confirmation argument」。自动测试断言该常量包含这几段、不再含旧的「Before creating, replacing, rotating, or changing the role description … obtain …」四合一句。
2. `LANE_ROUTER_INSTRUCTIONS` 与 `lane_attach_current` 描述都复用新常量（断言两者都包含新片段）。
3. `lane_restore_project` 描述不再含「Call only when the user explicitly asks to reopen lanes」，改含「wake only the lanes you actually need」。
4. `creationPrompt` 输出：不再含「do not start feature work on your own」这类无条件句、不含「approved creation」；含「You have no assigned task yet」与「wait for direction, or for work addressed to you」。`zcodeIntroPrompt` 同口径（断言两者的新片段）。
5. 代码行为未变：针对 `attachCurrent` 的既有测试（接管等空闲、CAS `BINDING_CHANGED`、`rejectTakeover` 报 `LANE_ALREADY_BOUND`、创建要 role、同会话改角色识别为改动）全部仍通过——证明只改了文字、没碰逻辑。
6. 规范 `agent_coding_guidelines/techniques/lane-router.md` 的 `:80/:83/:85/:199` 与恢复一节按 4.4 改好；`scripts/kb/kb.py` 查链接/字段不报错。
7. `npm test`、`npm run typecheck` 全过（高负载偶发超时按 LR-11 的办法处理，不把超时算过）。
8. 真机（部署后新开/恢复的会话里；这批改的是指令+prompt，Claude 要新开/恢复会话、Codex 要 `-CodexHost` 才生效）：
   - a. 开一条新 lane，它读透 AGENTS.md/现状后报就绪、不自己开干、也没要用户先批创建；
   - b. 一条 lane 唤醒一个离线 peer，不再停下来问用户要不要唤醒；
   - c. 一条长跑 lane 换代轮换（新会话 attach 回同地址同角色）接着干，不要用户确认；
   - d. 一条 lane 尝试改另一条已有 lane 的角色说明，或接替一条还 live 的别的 lane，仍会先向用户说明并等确认；
   - e. 一条被恢复的 lane 自动处理 pending mailbox/问答、并接着之前已授权的任务继续，而不是停着等「开工」。
   - 结果记入 `docs/manual-tests.md`。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；主检出不 build（build 的时机归部署那一步，和问答、图一批走）。
- 变异检验（改坏一处看对应用例变红，看完改回）：
  - 把 `ATTACH_CONFIRMATION` 还原成旧四合一句 → 验收 1、2 变红。
  - `lane_restore_project` 保留「only when the user explicitly asks」 → 3 变红。
  - `creationPrompt` 保留「do not start feature work on your own」 → 4 变红。
  - 真改了 `attachCurrent` 的接管/等空闲逻辑 → 5 里对应的既有用例变红（证明本稿不该碰它）。

## 八、边界

- 只改指令 / bootstrap prompt / 规范文字；不改 `router-core`、不加工具参数、不动接管/等空闲/升代。
- 「轮换 vs 接替」靠 agent 自判 + `waitUntilReplaceable` 兜底，不做代码区分；若日后真需要代码级区分（例如换代轮换也要免问但接替要硬拦），那是另开一稿的事，本稿显式不做。
- 终端里 Claude Code / Codex 对 CLI 命令本身的权限弹窗是另一层（权限设置），不在本稿；用户若要，可单独给 `lane-router-lane new/open` 加白名单。
- 生效需重新 build + 新开/恢复会话（Claude）+ `-CodexHost`（Codex），与问答、图这批一起部署。
