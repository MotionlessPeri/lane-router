# lane 结束问答，lane 默认把要用户回答的问题发到问答 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/inbox` 起草。讨论在问答议题 `924e24eb`「要不要让 lane 默认把要你回答的问题发到问答」。

用户的原话：

- 起因：「现在我要显式说注册登记到lane lane才会登记，是不是我们要写一个guideline让lane把问题都注册登记到问答啊」
- 条目 #4：「我觉发到问答没问题，不过这样就更要支持lane能结束问答了。比如有问题我在tui里回复了，lane就应该把相关的问答关掉。我觉得我们可以写到agent_coding_guideliens吧，让他们遵守规则之类的？」
- 条目 #8，回复 inbox 在条目 #7 提的四点结束规则：「我觉得没啥问题。先做吧」
- 条目 #28，在两套口径里选定：「我也觉得 后面那条好 11:43那套」

**口径冲突已了结（2026-10-20）：** 同一天用户还在 design 的议题 `5b7c60df` 第 2 条（10:01）定过一套更严的规则：有未读内容不能关，关了不能重开。inbox 在 `924e24eb` 第 27 条把两套并排列给用户，用户选了本稿这套（11:43），`5b7c60df` 那套作废。design 同意，Vikunja LR-13 指向本稿。

改由 `lane-router/inbox-impl` 实现（原定 `lane-router/impl`）。本稿和[附件稿](2026-10-20-issue-files.md)的 3.2、3.3 改的是同一批文件：问答库升级、`reply`、页面回复区。两份由同一条 lane 先后做，就不会互相冲突，impl 也能腾出来做图那边的活。本稿先做，附件稿接在后面，沿用本稿的升级路径。

上线：用户在 `205a897d` 第 12 条说「你和graph对一下，把相关需求做完一起部署新版吧」。所以本稿、附件稿和 graph 那边要一起上线的稿子都合进 master 后，一次构建、重启。重启要连 Codex 宿主一起重启，见 3.5「生效时机」。push 仍等用户说。Vikunja #391。

本稿修订第一版需求（[需求确认稿](2026-10-17-user-issue-inbox-requirements.md)）的两条：

- **R6**：除了用户，lane 也能结束议题，但议题里不能还有等待中的问题。
- **A5**：结束后用户仍然可以回复，回复会让议题重新打开。lane 不能重开。

## 一、问题与结论

现状：

- lane 只能把单个问题标成已回答或无需回答，结束整条议题只有两种方式：用户在页面上点「结束议题」，或者 lane 用 `record_tui_close` 记下用户在 TUI 里说「结束」的原话（`tool-schema.ts:31`：「Only the user can end an issue」）。
- 结束以后，任何人都不能再追加（`service.ts:236,244,273-275`）。
- 结果是做完的议题没人关。2026-10-20 中午，inbox 自己发的九条议题里只有两条被关了，其余七条的事早已做完、上线、push，还开着。
- lane 只在用户明说时才发问答（通用仓 `techniques/lane-router-issues.md`「用户怎么提出要求」）。lane 在 TUI 里停下来等用户拍板时，用户不在 TUI 前面就看不到。
- 本机 Codex 不读个人仓和通用仓的指南（没有 `~/.codex/AGENTS.md`，也没设 `CODEX_HOME`）。只写进指南的规则，Codex lane 收不到。

结论：

1. **lane 结束议题**：议题里没有等待中的问题（等用户的、等 lane 的都没有）时，lane 可以结束它，必须写原因。
2. **回复即重开**：已结束的议题，用户仍然可以回复。回复会让它重新打开，照常投递给 lane。lane 不能重开。
3. **看得出谁结束的**：持久记下结束方是用户还是 lane，列表和详情里显示出来。lane 结束时如果还有用户没读过的 lane 内容，这条议题继续留在「待我处理」，直到用户读过。
4. **默认发问答**：问答模块自带一段使用说明，Router 装上问答模块时拼进 Lane Router 的说明里。Claude 走 MCP 的 instructions，Codex 走 `developerInstructions`，所以每个 lane 开局都会收到。通用仓的指南同步改写。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| lane 结束的条件是：没有 `waiting_user`，也没有 `waiting_lane` 的问题 | 是 | 用户点头的四点里写的是「没有等你回答的问题」。这里再加一条「没有等 lane 的问题」，比那四点更严：用户的回复还没得到答复时，lane 不能关掉议题把它带走。lane 要先答复（带 questionId 会自动标为已回答），或者把问题标成无需回答。这一条在议题里向用户说明 |
| 结束原因必填，写进历史 | 是 | 用户回头看时要知道为什么关的；关错了也能看出来 |
| 用户回复让议题重开，不区分是谁结束的 | 是 | 用户点头的第 3 点是「结束以后你仍然可以在里面回复」。用户自己关的议题，后来想补一句，同样不该被拒 |
| lane 不能重开，结束后 lane 的追加仍然拒绝 | 是 | 第一版 A5 的本意是不让 agent 自己把讨论续上，这一点保留 |
| 用一个持久字段记结束方，不从历史条目推断 | 是 | 结束和解决问题都写 `kind=event` 的条目，靠正文或 `related_entry_id` 是否为空来区分太脆弱 |
| 问答库只做加法迁移，版本升到 2 | 是 | 记结束方需要一个新字段（加列或加表，由实现 lane 选）。现在的校验要求结构和版本完全一致（`schema.ts:110-125`），所以要补一段 v1 到 v2 的升级。只加不改，旧表的 CHECK 不动。附件稿还要加附件表，会沿用这条升级路径 |
| 默认发问答的规则写进产品说明，由问答模块提供，装配时拼接 | 是 | 产品说明是唯一同时能到达 Claude 和 Codex lane 的地方：MCP 用 `LANE_ROUTER_INSTRUCTIONS`（`lane-mcp-server.ts:62`），Codex 的 `developerInstructions` 用同一个常量（`codex-runtime.ts:130`）。说明由模块提供，再按目录拼接（目录已经是这样分层的：`builtin-tools.ts:12-14`），这样通信核心不用认识问答，第一版 R12 的分层不变 |
| 只写进通用仓指南 | 否 | 本机 Codex lane 收不到 |
| 不复制每个 TUI 答复到问答 | 是 | 用户在 TUI 里正聊着的时候会出现两遍，问答列表也会被塞满。用户在条目 #4 只要求「问题」默认发 |

## 三、设计

### 3.1 lane 结束议题

工具 `lane_issue_update` 加一种填法：`{ operationKey, issueId, action: "close", reason }`。

服务方法 `closeByLane(context, { operationKey, issueId, reason })` 走 `agentWrite`，所以调用方身份、owner 校验和幂等的规则都与其他 lane 写操作一样。

- 议题必须属于调用方 lane，并且还开着。
- 议题里任何问题处于 `waiting_user` 或 `waiting_lane` 时，拒绝结束，错误码新增一个，比如 `QUESTIONS_WAITING`。错误信息要写明怎么办：先答复（带 questionId），或者把问题标成 `not_needed`。被拒时不写任何东西。
- 成功时写一条事件条目：`kind: "event"`、`author: "lane"`、`source: "agent"`、正文「lane 结束：<原因>」。同时议题置为结束，`closedAt` 取这条事件的时间，结束方记为 `lane`。
- `record_tui_close` 不变，结束方记为 `user`。页面上的「结束议题」也记 `user`。

工具说明改写，不再写「Only the user can end an issue」。改成：

- 议题的事情办完、里面没有等待中的问题时，用 `close` 结束，并写明原因。
- 用户在 TUI 里说结束，用 `record_tui_close` 记下原话。
- 不要只因为答复了一轮就结束议题。

### 3.2 回复即重开

`reply` 遇到已结束的议题时，不再报 `ISSUE_CLOSED`，在同一个事务里依次：

1. 议题改回 `open`，清掉 `closedAt` 和结束方。
2. 写一条事件条目：`author: "user"`、`source: "user_page"`、正文「用户回复，议题重新打开」。
3. 照常处理回复：回复对象、问题状态、投递都按现有规则。
4. 投递正文开头加一句：「这条问答原先已结束（由 lane / 用户结束），用户的回复让它重新打开了。」

不变的部分：

- lane 对已结束议题的 `append`、`resolve_question` 和 `close` 仍然报 `ISSUE_CLOSED`。
- `record_processed` 仍然允许，现状就是这样（`service.ts:114`）。
- `markRead` 仍然允许。

### 3.3 记下结束方

- 新字段的取值是 `user` 或 `lane`。议题开着时为空，结束时必填。
- 升级时，已结束的旧议题一律回填 `user`：v1 只有页面结束和 `record_tui_close` 两种途径，都是用户。
- 读接口（议题列表、详情，以及 lane 的 `lane_issue_read`）都返回这个字段，比如 `closedBy`。

问答库从 v1 升到 v2：

- 打开数据库时，发现是 v1 就升级。
- 升级前先把数据库文件复制成 `issues.sqlite.v1.bak`，文件已存在就不覆盖。复制失败就不升级，按问答模块不可用处理（现有的 `ISSUES_UNAVAILABLE` 路径）。
- 升级在一个事务里完成：加字段、回填、改版本号。完成后跑 `foreign_key_check` 和结构比对，结果必须与 v2 期望的完全一致。
- 是 v2 就直接按 v2 校验。其他结构或版本照旧拒绝。
- 回退：旧版 Router 不认 v2，会以 `Unsupported issues schema version` 拒绝打开。回退时停 Router，用 `.v1.bak` 换回数据库，再启动旧版。升级之后新写的数据会丢失，回退说明里要写清这一点。

### 3.4 「待我处理」与显示

- 「待我处理」的条件，在原来的「开着并且（有等用户的问题，或有未读 lane 内容）」之外，加一种情况：lane 结束的，并且还有未读 lane 内容。这时 `attentionReasons` 含 `unread_lane_content`。用户读过以后它就离开「待我处理」。
  - 这样处理是因为 lane 可能答复完立刻结束议题。不这样做，这条答复就会直接沉进「已结束」，用户永远看不到。
  - 用户自己结束的议题，规则不变。
- 列表徽标：用户结束的显示「已结束」，lane 结束的显示「lane 已结束」。
- 详情元信息：「已结束（你结束的）」或「已结束（lane 结束的）」。
- 已结束议题的回复区不再写「议题已结束」。改成正常的回复框，上方一行提示：「这条问答已经结束（由 lane / 你结束）。回复会重新打开它。」「结束议题」按钮照旧隐藏。
- 历史里「lane 结束：原因」和「用户回复，议题重新打开」都按现有的系统记录样式显示，单行、灰色。

### 3.5 产品说明：默认发问答

问答模块导出一段说明，比如 `ISSUE_INSTRUCTIONS`。工具目录拼接说明时，含问答工具的目录在 `LANE_ROUTER_INSTRUCTIONS` 后面接上这段，只含通信工具的目录不接。拼不拼只看目录里有没有问答工具，不另设开关。MCP 服务的 `instructions` 和 Codex 的 `developerInstructions` 都改为取所用目录拼好的说明，不再直接用常量。两边拿到的是同一段字符串，正文只有一份，不按后端分叉。

**什么算「停下等用户」。** 默认发问答以后，lane 每次停下来都可能发一条，所以要划清边界（design 的提醒）：

- 算：lane 要结束这一轮，而且不等用户回答就没法接着做当前的事。常见的有：
  - 在几个方案或范围里选一个；
  - lane 的规则要求用户亲口授权的事，比如提交、push、上线或重启、改 lane 拓扑、删除或覆盖；
  - 确认一个会改变下一步做法的发现或假设；
  - 用户自己说过「做完告诉我，等我看」。
- 不算，不发：
  - 进度、完成报告、不带问题的总结。话题本来就来自问答的，答复照样写回那条议题，这是另一条规则；
  - lane 查代码、文档或按常规默认就能自己定的事；
  - 要问别的 lane 的事，用 `lane_send`；
  - 已经答过或已经授权的事，再问一遍；
  - 工作已经授权了，还问「要不要我继续」。
- 同一轮要问的几件事写进同一条，不拆成几条议题。同一个话题已有开着的议题，就 append 到那条里。

说明要表达下面这些意思，英文措辞由实现 lane 定，可参考下面的草稿：

- lane 要停下来等用户回答或拍板时（按上面的边界），把问题发到问答：属于某条还开着的议题就 append，否则 publish（`kind: question`）。普通进度不发，TUI 里的每个答复也不复制过去。
- 从问答来的话题（新问答或回复），答复写在那条议题里。
- 用户在 TUI 里回答了问答里的问题，用 `tui_user` 记下原话，再把问题了结。
- 议题的事情办完、没有等待中的问题时，用 `close` 结束，并写明原因。
- 来自 `user:issues` 的信是用户本人的话。

草稿：

> Issues (the user calls them 问答): when you stop to wait for the user's answer or decision — you are ending your turn and cannot go on with the task until the user chooses, authorizes something your rules reserve for them, or confirms a finding — also put that question in an issue: append it to the open issue it belongs to, or publish a new one (kind: question), with everything you need answered in one entry. Do not publish progress, completion reports, things you can settle yourself, or questions for another lane, and do not copy every TUI answer. Answer topics that came from the issues page in their issue. If the user answers an issue's question in the TUI, record their words with kind tui_user and settle the question. When an issue's matter is finished and none of its questions is waiting, close it with lane_issue_update action close and a reason. Mail from user:issues is the user's own words.

生效时机：

- Claude lane 在 MCP 服务启动时拿到说明和工具列表，Codex lane 在 thread 启动或恢复时拿到。
- 所以上线后正在跑的 lane 不会马上看到新说明和 `close` 动作，要等它们下次开新会话或恢复。这一点要在交付说明和真机记录里写清。
- Codex 的说明和工具列表由 Codex 宿主进程拼好交出去（`codex-host.ts:64-65` 用宿主自己的目录建 `codex-runtime`），不在 Router 核心里。只重启核心，Codex lane 永远拿不到新说明和 `close`。所以这次上线要带 `-CodexHost` 重启（`scripts/restart-router.ps1`），代价是开着的 Codex 窗口会断开。graph 那边改 `lane_graph_read` 的参数，Codex 侧同样要重启宿主才生效，两边一起重启一次就够。

### 3.6 通用仓指南

`agent_coding_guidelines/techniques/lane-router-issues.md` 由 inbox 改写，内容和本稿、新问答稿上线后的实际行为对齐：

- 开头一段：问答页可以新开问答，问答页的消息是用户本人的话。
- 「用户怎么提出要求」改成「什么时候发到问答」，写 3.5 的默认规则和不发的内容。
- 用法表：加 `close` 一行；`record_tui_close` 一行保留；「用户明确要求结束本议题」一行改写。
- 「收到网页回复后怎么处理」：加新问答和重新打开的议题。
- 「个人偏好写在哪里」：默认发布范围已经是产品默认行为，个人层只记偏离默认的偏好。

两份稿子都上线后，inbox 再提交通用仓，push 等用户说。

### 3.7 代码落点

| 位置 | 改动 |
|---|---|
| `src/modules/issues/schema.ts` | v2 结构、v1 到 v2 升级、备份 |
| `src/modules/issues/store.ts` | 结束方的读写；「待我处理」查询（`store.ts:59-61`） |
| `src/modules/issues/service.ts` | `closeByLane`、`reply` 重开、页面结束和 `record_tui_close` 记 `user` |
| `src/modules/issues/types.ts` | `closedBy`、新错误码 |
| `src/modules/issues/tool-schema.ts`、`tools.ts` | `close` 填法、工具说明、`ISSUE_INSTRUCTIONS` |
| `src/application/tool-catalog.ts`、`builtin-tools.ts` | 目录带上拼好的说明 |
| `src/mcp/lane-mcp-server.ts`、`src/adapters/codex/codex-runtime.ts` | 改用目录的说明 |
| `src/ui/issues/index.html` | 徽标、元信息、已结束议题的回复区 |
| `tests/…` | 第五节第 1–9 条 |
| `docs/manual-tests.md` | 真机用例 TC-ISSUES-LANECLOSE-1 |
| 需求稿 | 文首修订说明加 R6、A5，指向本稿（inbox 改） |

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| lane 结束议题 | lane，每件事办完 | 用户要求 | 做完的议题堆积 | 用户手动关 | 保留 |
| 回复即重开 | 用户，关早了或想补一句 | 用户点头的第 3 点 | lane 关早了，用户没法接着说 | 无 | 保留 |
| 持久记结束方，加 v2 升级 | 用户看列表 | 用户点头的第 4 点 | 看不出谁关的 | 无 | 保留 |
| lane 结束后未读内容仍在「待我处理」 | 用户 | 防止答复沉底 | 最后一条答复可能没人看 | 无 | 保留 |
| 产品说明 | 所有 lane，每次开局 | 用户要「让他们遵守」；Codex 不读指南 | Codex lane 不知道规则 | 指南（只有 Claude） | 保留 |
| 通用仓指南改写 | Claude lane、人 | 用户要求 | 文档和行为不一致 | — | 保留 |
| 复制每个 TUI 答复 | — | 用户没要求 | — | — | 不做 |
| 超时自动结束 | — | 无 | — | lane 结束 | 不做 |
| lane 重开议题 | — | A5 保留 | — | 用户回复重开 | 不做 |

## 五、验收标准

第 1–8 条是 node 组测试，用临时数据目录；第 9 条是浏览器组；第 10 条是真机。

1. lane 结束成功：问题都已了结的开着的议题，`close` 后变为已结束，结束方为 `lane`，历史多一条「lane 结束：原因」事件，作者是 lane。同键同内容重试返回原结果，不新增条目。
2. lane 结束被拒，并且库里没有任何变化：有 `waiting_user` 的问题；有 `waiting_lane` 的问题；不是本 lane 的议题；议题已结束；原因为空。
3. 重开：lane 结束的议题和用户结束的议题，用户回复后都变回开着，`closedAt` 和结束方清空，历史依次是重开事件、回复，投递正文含「原先已结束」那句。重开后 lane 可以再次结束。lane 对已结束议题 `append` 仍然报 `ISSUE_CLOSED`。
4. 结束方：页面结束记 `user`，`record_tui_close` 记 `user`，`close` 记 `lane`；列表、详情和 `lane_issue_read` 都返回它。
5. 升级：一个含开着和已结束议题的 v1 数据库（按现在的 v1 结构建库并写入数据作夹具），被新代码打开后变成 v2，备份文件存在，所有行都在，已结束的议题结束方都是 `user`，`foreign_key_check` 为空。再打开一次不再升级，也不覆盖备份。被改过的 v1 结构、未知版本仍然拒绝。备份失败时不升级，模块报不可用。
6. 待我处理：lane 结束并且有未读 lane 内容的议题出现在「待我处理」，原因是 `unread_lane_content`；`markRead` 读到末尾后消失。用户结束的议题不出现。
7. 工具：`lane_issue_update` 的平表 schema 含 `close` 和 `reason`，组合说明里有 `action="close": operationKey, issueId, reason` 这一行；工具说明不再含「Only the user can end an issue」。契约测试覆盖。
8. 说明：用含问答工具的目录启动 MCP 服务时，`initialize` 返回的 instructions 含问答那段；只用通信目录时不含。Codex 的 `developerInstructions` 与 MCP 的说明一致。
9. 页面：「lane 已结束」和「已结束」两种徽标；详情元信息写明谁结束的；已结束议题显示回复框和提示，发送后议题变回「进行中」。已有的浏览器和 happy-dom 用例全部通过。`npm test`、`npm run typecheck` 全部通过。
10. 真机 TC-ISSUES-LANECLOSE-1，上线后：
    - inbox 开新会话，或重连 MCP，拿到新的工具和说明后，用 `close` 结束自己那七条早已做完的议题，每条写明原因。
    - 用户在「已结束」里看到这七条显示「lane 已结束」。
    - 用户在其中一条里回复，议题重新打开，inbox 收到信，信里有「原先已结束」那句。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`。主检出不 build；测试一律用临时数据目录，不碰共享 Router 和真实 `issues.sqlite`。
- 变异检验（每次改坏一处，看对应的测试有没有变红，看完改回）：
  - 去掉 `waiting_lane` 的检查 → 2 变红
  - `reply` 对已结束议题仍报 `ISSUE_CLOSED` → 3 变红
  - 重开时不清结束方 → 3 变红
  - lane 的 `append` 能写进已结束议题 → 3 变红
  - 升级不回填 `user` → 5 变红
  - 升级前不备份 → 5 变红
  - 「待我处理」不含 lane 结束的未读议题 → 6 变红
  - 用户结束的议题也进「待我处理」 → 6 变红
  - 只含通信工具的目录也拼上问答说明 → 8 变红
  - 两种徽标对调 → 9 变红

## 七、边界

- 迁移只做加法，不改旧表的 CHECK，也不删列。
- lane 不能重开议题，不能结束有等待中问题的议题。
- 不做超时自动结束，不复制每个 TUI 答复。
- 产品说明只加问答的使用规则，不改通信部分的说明。
- 上线要重启共享 Router，连 Codex 宿主一起（`scripts/restart-router.ps1 -CodexHost`，由 design 执行）。用户已同意等相关需求都做完后一起上线；重启会断开开着的 Codex 窗口，执行前告诉用户。push 归用户。上线前确认 `issues.sqlite.v1.bak` 能正常生成。
