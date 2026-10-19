# 议题问题状态失真修复 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-19 由 `lane-router/inbox` 起草。用户把这件事定为 bug、要求先修（评估议题 `ca0bc5e7` 条目 #4），对下面三条修法回复「可以吧」（议题 `9460be62`），并说过「出了方案直接推进到做完」（议题 `e5f33070`），因此稿子写完直接交给 `lane-router/impl`，不再单独过审。第五节是验收标准。Vikunja #341。

## 术语表

| 词 | 含义 |
|---|---|
| 条目 | 议题里的一条记录（`issue_entry`）。类型有：提问 `question`、答复 `answer`、回复 `reply`、系统记录 `event` |
| 问题记录 | 「球在谁那边」的跟踪项（`issue_question`）。`askedTo` 是 `user` 或 `lane`；状态是 `waiting_user`、`waiting_lane`、`answered`、`not_needed` 之一。列表上的「待我回答」「等待 lane」两个标记，都由它算出来 |
| 回复对象 | 网页回复表单里的选择框 `#reply-question`，决定这条回复关联哪一个问题记录 |

## 一、问题与结论

现在问题记录的状态是怎么变的（`src/modules/issues/service.ts`）：

| 动作 | 效果 |
|---|---|
| lane 发提问（publish 或 append，`kind: question`） | 新建问题记录，`waiting_user`（`:45-46`、`:64`） |
| 用户在网页回复，**选了**回复对象 | 该问题记录改为 `waiting_lane`（`:309-311`） |
| 用户在网页回复，**没选**回复对象 | **新建**一个 `waiting_lane` 问题记录；原来那个 `waiting_user` 不变（`:309-311`） |
| lane 追加解释，带 `questionId` | 该问题记录改回 `waiting_user`（`:66`） |
| lane 追加答复，带 `questionId` | **不改状态**（`:59-68`） |
| lane 调 `resolve_question` | 改为 `answered` 或 `not_needed`，并写一条系统记录（`:71-94`） |

失真有三处：

1. 回复对象默认是「继续讨论（不指定问题）」（`src/ui/issues/index.html:373`）。用户直接回答 lane 的问题时，原问题还挂着「待我回答」，回复本身又多出一个「等待 lane」。真实数据：19 条网页回复里，选了回复对象的是 0 条。2026-10-19 在议题 `2a5887bd` 上复现了两次。
2. lane 带着 `questionId` 追加答复，问题不会变成已回答，lane 还得再调一次 `resolve_question`。真实数据里有 5 个问题已经答了，却仍显示「等待 lane」。
3. 已结束的议题，列表上仍显示「等待 lane」（`index.html:227` 没有判断议题状态）。

结论：

1. 回复对象默认选中本议题里最新一个 `waiting_user` 的问题；没有这样的问题时，才默认「继续讨论」。
2. lane 带 `questionId` 追加**答复**时，如果该问题是 `waiting_lane`，就自动标为 `answered`，效果等同于调一次 `resolve_question`。
3. 已结束的议题不显示「等待 lane」。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| 用页面上的默认值关联问题，不由后端猜 | 是 | 默认值在选择框里看得见，用户可以改。后端把「不指定问题的回复」猜成回答了某个问题，在同时有几个待回答问题时会猜错，而且用户看不到 |
| 默认选**最新**一个待回答的问题 | 是 | lane 通常刚问完就等回答；最新的问题最可能是用户正在回的那个 |
| 默认值只在选中议题时和发送成功后计算，轮询不改 | 是 | 用户正在写回答时，如果 lane 又问了一个新问题，回复对象被悄悄换掉，就会关联错 |
| 只对 `waiting_lane` 的问题自动解决 | 是 | 这时「球在 lane 那边」，lane 的答复就是在回应它。`waiting_user` 的问题还在等用户，lane 的答复不应替用户关掉它，保持现状（不改状态） |
| 自动解决只看 `kind: answer` | 是 | 解释的意思是「用户还没懂」，现状是改回 `waiting_user`，这一点不变 |
| 不加「答复但不解决」的开关 | 是 | 不想结束这个问题，就不带 `questionId`。少一个参数，少一种用错的方式 |
| 自动解决时照样写系统记录 | 是 | 和 `resolve_question` 的事实留痕保持一致（`:87` 的注释：状态会被后来的轮次覆盖，完成事实要留在不可改写的历史里）。系统记录怎么显示得更安静，归 UI 小修（#344） |
| 投递正文写明下一步 | 是 | lane 收到网页回复后要做的事、要带的 ID 都写在正文里，少漏步骤 |

## 三、设计

### 3.1 页面：回复对象的默认值

- 这次选中某个议题时，以及在这个议题里发送成功后，计算默认值：在本议题 `askedTo = user`、`status = waiting_user` 的问题记录里，取提问条目 `seq` 最大的那个；没有就是「继续讨论」。
- 用户手动改过以后，以用户的选择为准，直到发送成功或切换议题。
- 轮询不改回复对象（选项文字和状态标签照常刷新）。
- 选择框的选项不变：仍列出全部问题记录，并带状态标签。

### 3.2 服务：带 `questionId` 的答复自动解决

在 `append` 里，`kind = answer` 且带 `questionId` 时：

- 问题记录是 `waiting_lane`：在同一个事务里把它标为 `answered`，`answerEntryId` 填这条答复，并写一条和 `resolve_question` 同样格式的系统记录。
- 问题记录处于其他状态：不改状态（与现状相同）。
- 用同一个 `operationKey` 重试时，返回原结果，不再多写系统记录（沿用 `agentWrite` 现有的幂等）。

`explanation`、`question`、`tui_user` 的行为都不变。`resolve_question` 保留不动，仍可用于 `not_needed`，或者补标历史上的问题。

### 3.3 列表：已结束议题不显示「等待 lane」

列表项状态为 `closed` 时，不显示「等待 lane」标记（`index.html:227`）。

### 3.4 给 agent 的说明

- `lane_issue_append` 的工具说明加一句：带 `questionId` 的答复，会把等待 lane 的那个问题标为已回答；不想结束这个问题就别带 `questionId`。
- 网页回复的投递正文（`service.ts:163-171`），在「查询完整议题」之后加一段下一步：处理完后，用 `lane_issue_append`（`kind: answer`，`questionId: <问题 ID>`）答复，该问题会自动标为已回答；再用 `record_processed` 记录这次投递；最后 `lane_ack`。
- `docs/manual-tests.md` 第 83–86 行的工具说明与处理流程同步修改。通用仓 `techniques/lane-router-issues.md` 的表格同步修改，由 inbox 另行转给 `agent_coding_guidelines/main`，不在本稿实施范围内。

### 3.5 代码落点

| 位置 | 改动 |
|---|---|
| `src/modules/issues/service.ts` | 3.2；投递正文按 3.4 补充 |
| `src/modules/issues/tool-schema.ts` | `lane_issue_append` 的说明文字 |
| `src/ui/issues/index.html` | 3.1、3.3 |
| `tests/modules/issues/` | 见第五节 |
| `docs/manual-tests.md` | 3.4 |

不改：数据库结构、HTTP 接口、其他工具的参数。

### 3.6 与滚动改动的先后

页面部分（3.1、3.3）和正在实现的滚动改动（`2026-10-19-issue-inbox-scroll-layout.md`）是同一个文件，回复区的结构也会被那份稿子改动。所以页面部分要在滚动改动之后做；服务部分可以先做。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 回复对象默认选最新的待回答问题 | 用户，每次回复 | 真实数据 0/19；今天复现两次 | 「待我处理」继续失真 | 用户手动选（实测没人选） | 保留 |
| 带 `questionId` 的答复自动解决 | lane，每次答复 | 真实数据 5 个问题已答但仍显示等待 | lane 要多调一次，常常漏 | `resolve_question` | 保留 |
| 已结束议题不显示「等待 lane」 | 用户，看列表时 | 代码缺少判断 | 已结束的议题看起来还在等 | 无 | 保留 |
| 投递正文写明下一步 | lane，每次收到网页回复 | 评估第 3 项 | lane 漏步骤 | 工具说明 | 保留 |
| 后端推断「不指定问题的回复」回答了哪个问题 | 无 | 无 | — | 页面默认值 | 删除 |
| 「答复但不解决」开关 | 无 | 无 | — | 不带 `questionId` | 删除 |
| 一次性迁移，自动修正历史上已失真的问题 | 无 | 只有几条 | — | 由各所属 lane 用 `resolve_question` 补标 | 删除（另行协调） |

## 五、验收标准

每条都要有自动测试。

1. 页面：议题里有一个 `waiting_user` 问题时，选中议题后回复对象默认就是它；不动选择框直接发送，请求体里的 `questionId` 就是它的 ID，发送后它变成 `waiting_lane`，并且没有新建问题记录。
2. 页面：有两个 `waiting_user` 问题时，默认选提问条目 `seq` 较大的那个。没有 `waiting_user` 问题时，默认「继续讨论」，发送时不带 `questionId`。
3. 页面：用户把回复对象改成「继续讨论」后发送，请求不带 `questionId`。轮询期间后端新增一个 `waiting_user` 问题，回复对象保持不变；发送成功后，默认值按第 1、2 条重新计算。
4. 服务：问题为 `waiting_lane` 时，带它的 `questionId` 追加 `answer`，问题变成 `answered`、`answerEntryId` 等于这条答复，并且多了一条系统记录。用同一个 `operationKey` 重放，结果相同，不再多写记录。
5. 服务：问题为 `waiting_user`、`answered` 或 `not_needed` 时，带它的 `questionId` 追加 `answer`，状态不变，也没有系统记录。不带 `questionId` 追加 `answer`，所有问题都不变。
6. 服务：`explanation` 仍把问题改回 `waiting_user`；`tui_user` 的行为不变。
7. 列表：已结束的议题即使有 `waiting_lane` 问题，也不显示「等待 lane」。
8. 网页回复的投递正文含有第 3.4 节的下一步说明，并带上本次的问题 ID。`lane_issue_append` 的工具说明含有自动解决那一句。
9. 现有测试不删。断言所测的行为确实变了的（例如「带 `questionId` 的答复不改状态」），可以改，但要在交付说明里逐条列出改了哪条、为什么改。`npm test`、`npm run typecheck` 全部通过。
10. 真机：在跑的 Router 换上新构建、页面也读到新版之后（时机归用户；服务部分要重启 Router 才生效），在一条真实议题上，lane 提问 → 用户不动选择框直接回复 → lane 带 `questionId` 答复，三步之后列表上既没有「待我回答」也没有「等待 lane」。记入 `docs/manual-tests.md`。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`。页面部分用现有的 happy-dom 测试（`tests/modules/issues/ui.test.ts`），这几条不涉及布局。
- 不碰在跑的共享 Router；测试一律用临时数据目录；主检出不 build。
- 变异检验（每次改坏一处，看对应的测试有没有变红，看完改回）：
  - 默认值改回「继续讨论」→ 1、2 变红
  - 默认值取最旧的问题 → 2 变红
  - 轮询时重算默认值 → 3 变红
  - 去掉自动解决 → 4 变红
  - 对 `waiting_user` 也自动解决 → 5 变红
  - 对 `explanation` 也自动解决 → 6 变红
  - 去掉列表上的状态判断 → 7 变红

## 七、边界

- 历史上已经失真的问题不做自动迁移。由 inbox 列出清单，请各所属 lane 用 `resolve_question` 补标；这一步与本稿的实施分开。
- 服务部分要等共享 Router 重启后才生效，时机归用户。页面部分在跑的 Router 按请求读页面，但它依赖服务部分的新行为才完整；两部分一起上线。
- `tui_user` 记录的 TUI 回复，仍然只在 agent 带了 `questionId` 时关联问题，本稿不改。
- 工具参数说明被 Claude Code 改写走样的问题，另有一稿（Vikunja #342）。
