# 从问答页开启问答，lane 没开着就唤醒 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/inbox` 起草。讨论在问答议题 `205a897d`「从问答页直接开启问答（选一个 lane 发起）」。

用户的原话：

- 起因：「我在想我们要不要加一个开启问答的功能，让我能在问答页面选一个lane直接开启一个问答……我心里想的长期愿景是后面我就基本不在tui上工作了，转向去问答页面工作。」
- 条目 #4 的回复：「我感觉新问答没啥问题，新问答要是选了离线lane的话就直接唤醒lane就好了。报错信息去tui才能看到这个我觉得没啥问题……不用把报错也搬过来吧，那样就更像我们自己给agent写了个UI？」

inbox 在条目 #5 写明了两个理解，用户在条目 #6 回复「可以，做一下吧」，两条都确认了：

- 网页新开的问答等同于 TUI 输入，lane 可以直接照做。
- 在已有问答里回复离线 lane，也一样唤醒。

稿子写完直接交给 `lane-router/impl`。上线要重启 Router，上线和 push 都等用户说。Vikunja #389。

本稿修订第一版需求（[需求确认稿](2026-10-17-user-issue-inbox-requirements.md)）的三条：

- **R2**：问答页可以选 lane 新开问答。
- **R8**：用户在问答页发出消息时，目标 lane 没开着就由 Router 打开它的窗口。
- **R10**：问答页是用户日常和 lane 讨论的主要入口，但仍然不做 TUI 镜像。报错、工具过程和新建 lane 留在 TUI。

## 一、问题与结论

现在新话题只能在 TUI 里开头，问答页只能接着已有的议题聊（`src/modules/issues/http.ts:22-23` 只有 replies、read、close 三个写入口）。用户发出回复时，如果 lane 没开着，回复就留在信箱里，要等用户自己去运行看板点「恢复 lane」，lane 才会处理。

结论：

1. **新问答**：侧边栏加「新问答」按钮。用户选一个 lane、写下要说的话，发出后建成一条新议题。lane 收到的信写明这是用户本人的话，等同于在 TUI 里说的，答复写在这条议题里。
2. **唤醒**：用户在问答页新开问答或回复以后，如果目标 lane 没开着，Router 用运行看板「恢复 lane」那套逻辑打开它的窗口，接着原来的对话。信已经在信箱里，lane 起来后由通知泵送过去。
3. **不做**：从问答页新建 lane；把报错和工具过程搬到问答页；从问答页打断 lane。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| 新问答不迁移问答库：议题的 `origin_kind` 用 `question`，第一条条目是 `kind=question, author=user, source=user_page`，问题 `askedTo=lane, status=waiting_lane` | 是 | 这些值现有的 CHECK 都允许（`src/modules/issues/schema.ts:10,25-27,43-44`）。`originKind` 只存不读，页面和服务都不靠它分支（全仓只有 `store.ts`、`types.ts` 和 `service.ts:37` 用到）。问答库的校验要求结构和版本完全一致（`schema.ts:110-125`），一旦迁移，就得为 `issue_thread` 重建表并迁移外键，代价远大于收益。谁开的头，看第一条条目的 `author` 就知道。inbox 在议题里说过「要做一次库迁移」，那是写错了，已在议题里更正 |
| 唤醒放在后端：问答模块新增一个窄端口 `wake(laneId)`，由 `main.ts` 用现有的 `ConversationRestorer` 实现 | 是 | 第一版 R11 要求业务规则在后端，换了界面规则也不变。用稳定的 lane ID，不用地址，避免地址被复用后打开错的 lane（A4）。复用 restorer 自带的在线跳过和 30 秒防重复（`conversation-restorer.ts:45-56`） |
| 页面直接调 `/dashboard/lanes/open` | 否 | 能跑通（两页同源，共用 action token），但规则就落在页面里了，而且只能按地址打开 |
| 由投递 worker 在入箱结果为 `offline` 时唤醒 | 否 | 结果只能写进投递记录，要加列（迁移），页面也就拿不到唤醒结果。由问答页的写操作触发，结果当场就能告诉用户 |
| 是否唤醒按 `restorePresence` 判断，不按页面现在显示的 presence | 是 | 页面的 presence 看的是通道（`service.ts:331-335`）。Codex lane 关了窗口时它显示「未确认」，`restorePresence` 才是 `offline`（`codex-backend.ts:150-153`）。判断交给 restorer：`online` 跳过，`unavailable` 报失败 |
| 选 lane 的列表由后端新出一个查询，只给在役、有对话记录的 lane | 是 | 核心现在没有一个查询能同时给出 lane ID 和 `restorePresence`。`dashboardSnapshot` 含归档 lane、没有 lane ID，还带消息正文；`directory` 一次只查一个项目 |
| 标题默认取正文第一行，用户可改 | 是 | 列表要靠标题区分议题；多数时候用户不想另想标题 |
| 新问答发出后切到「进行中」并选中它 | 是 | 新问答在等 lane，不在「待我处理」里。不切过去，用户就看不到自己刚开的问答 |
| 记住上次选的 lane | 是 | 常常连着找同一个 lane。只是本机的便利，存 localStorage，读不到就不预选 |

## 三、设计

### 3.1 后端：新建问答

`IssuesService.create(input)`，输入 `{ operationKey, laneId, title, body }`：

- 校验：`title`、`body` 非空，`title` 去掉首尾空白；不接受多余字段。
- lane 必须在役（`readLane` 不为空，`archivedAt` 为空），并且有绑定（`binding !== null`）。不满足时报 `LANE_UNAVAILABLE`，不建议题。
- 幂等：和 `reply` 一样按 `user:local` 作用域记操作。新操作名是 `create`，载荷 `{ laneId, title, body }`。同键同内容返回原结果，同键异内容报 `OPERATION_CONFLICT`。
- 一个事务里写完以下内容：
  - 议题：`originKind: "question"`、`status: "open"`、`readSeq: 0`。
  - 第一条条目：`kind: "question"`、`author: "user"`、`source: "user_page"`。
  - 问题：`askedTo: "lane"`、`status: "waiting_lane"`。
  - 一条投递记录，复用 `issue_delivery` 和现有的投递 worker。
- 返回 `{ issueId, entryId, entrySeq, questionId, deliveryId }`。

投递正文开头和回复不同，其余结构照抄 `reply`（`service.ts:161-170`）。正文一次写定，重试时不重新拼：

```
用户在问答页新开了一个问答。这是用户本人的话，等同于在 TUI 里对你说的，按你处理用户指令的方式处理，不需要回 TUI 确认。答复写在这条问答里。
议题 ID / 标题 / 所属 lane ID
条目 ID / 投递 ID / 问题 ID
用户的话：<正文>
查询完整议题：lane_issue_read {"issueId": …}
下一步：处理完后，用 lane_issue_append（kind: answer，questionId: <问题 ID>）答复，问题会自动标为已回答；再用 lane_issue_update 的 record_processed（deliveryId: …）记录这次投递；最后用 lane_ack 确认这封邮件。
```

lane 带 `questionId` 答复后，问题自动变成已回答，这是已上线的行为（`service.ts:69`），不用另做。

### 3.2 后端：唤醒

问答模块的端口加一项（`ports.ts` 的 `IssuesServiceOptions`，或单独的 `IssuesWakePort`，由 impl 决定放哪）：

```ts
wake(laneId: string): Promise<IssueWakeResult>
type IssueWakeResult =
  | { status: "launch_requested" | "skipped_online" | "skipped_launching" }
  | { status: "failed"; reason: "no_binding" | "session_not_found" | "invalid_startup_cwd" | "backend_unavailable" | "terminal_launch_failed" }
```

- `main.ts` 用 `state.activeBindingForLaneId(laneId)` 找到绑定，再调同一个 `restore` 实例的 `restore(binding)`，不带覆盖参数。找不到绑定时返回 `no_binding`。必须用同一个实例，防重复的预留才是共享的（`conversation-restorer.ts:36`）。
- 模块对外提供 `wakeOwner(issueId)`：读出议题的 owner lane，调用端口，返回结果。
- HTTP 写入口在 `create` 或 `reply` 成功后调用 `wakeOwner`，把结果放进响应的 `wake` 字段。保存失败时不唤醒。唤醒失败不影响保存结果，响应仍然是 200，只是 `wake.status` 为 `failed`。同一操作重试时再调一次也无害：lane 在线会跳过，正在打开会被预留挡住。
- 没装问答模块，或者没注入唤醒端口时，`wake` 字段省略，页面不显示唤醒提示。
- 关于 Codex：窗口关着但宿主里 thread 还加载着时，通知会用 `turn/start` 在后台照常处理（`codex-backend.ts:118-123`），这时 `restorePresence` 仍是 `offline`，唤醒会再给它开一个窗口，接到同一个 thread 上。这是预期行为：用户能看到 lane 在做什么，不算故障。

### 3.3 后端：选 lane 的列表

`LaneAccess` 加一个查询，由 `RouterCore` 实现：

```ts
listActiveLanes(): readonly { laneId: string; address: string; project: string; backend: BackendName; restorePresence: "online" | "offline" | "unavailable" }[]
```

- 只含在役、有绑定的 lane。不含消息正文、角色说明或对话 ID。
- 排序：项目名、lane 名都按不分大小写的字典序，和运行看板的「恢复 lane」区一致。

### 3.4 HTTP

| 入口 | 说明 |
|---|---|
| `GET /issues/api/lanes` | 返回 `{ result: { items }, actionToken }`，`items` 即 3.3 的结果 |
| `POST /issues/api/threads` | 路径必须完全一致、不带查询串。动作头 `x-lane-router-action: issues-create`，沿用 `readPageAction` 的来源、动作头、类型和令牌四项检查。字段只收 `operationKey`、`laneId`、`title`、`body`（外加 `actionToken`）。返回 `{ result, wake }` |
| `POST /issues/api/threads/:id/replies` | 不变，只是响应多一个 `wake` |

错误码沿用现有映射（`http.ts:59-63`）：`LANE_UNAVAILABLE` 对应 409，字段错误对应 400。

安全：任何能伪造来源头的本机程序，现在就能拿到令牌（`GET /issues/api/threads` 会返回它）并替用户回复。新入口把这件事从「接着已有的事说」扩大到「给任何 lane 开新话题」和「打开终端窗口」。本机程序本来就有用户的全部权限，这不算越权；网页上的恶意站点仍被来源检查和自定义动作头挡住。设计照此接受，不另加凭据。

### 3.5 页面

侧边栏：

- 顶部那一行（`index.html:131`）加「新问答」按钮，放在「问答」标题和「运行看板」之间或右侧，样式用 primary。
- `<h1>` 悬停提示里「议题从 TUI 发起 · 本页可直接继续讨论」改成「可以在这里新开问答，也可以接着已有的问答讨论」。

主区的新问答视图：点「新问答」后，主区不显示议题详情，改显示下面这些。

- 标题栏：「新问答」和一个「取消」按钮。
- 「发给」下拉框：按项目用 `<optgroup>` 分组，每项写「lane 地址 · 状态」。状态的对应：
  - `online`：在线。
  - `offline`：没开着，发出后会打开它的窗口。
  - `unavailable`：Router 打不开它，消息会等它开着时再处理。
  - 2026-10-20 补充（impl 交付时提出，design 同意）：Router 的 restorer 打不开的后端（zcode、dsh、native-codex），只要不在线，`listActiveLanes` 就标成 `unavailable`；在线的照旧标 `online`。否则列表上会写「发出后会打开它的窗口」，实际却打不开。
  - 下拉框会预选上次用过的 lane；那个 lane 已不在列表里时不预选。
- 「标题」输入框：占位文字是「默认取正文第一行」。用户没填时，取正文第一行，去掉首尾空白和行首的 Markdown 标题符号，截到 60 个字符。
- 正文：和回复框同样的多行输入框。
- 发送按钮：没选 lane 或正文为空时不能点。

发送与结果：

- 每份草稿生成一个 `operationKey`。网络失败、结果不明时，沿用回复的做法：「用同一操作重试」和「查看后端历史」（`index.html:164`）。
- 成功后：清掉草稿，切到「进行中」，刷新列表并选中新议题，在状态行显示唤醒结果（下表）。
- 草稿存 localStorage，键和已有的议题草稿分开，比如 `draft:new`；离开页面的提醒沿用已有规则。

唤醒结果的提示（新问答和回复共用，显示在 `#operation-status`）：

| `wake.status` | 提示 |
|---|---|
| 无 `wake` 字段，或 `skipped_online` | 已发送。 |
| `launch_requested` | 已发送。这个 lane 没开着，已经让 Router 打开它的窗口。 |
| `skipped_launching` | 已发送。这个 lane 正在打开。 |
| `failed` | 已发送，但没能打开这个 lane（原因）。消息会等它打开后再处理，可以去运行看板手动恢复。 |

`failed` 的原因写成中文：

- `no_binding`：没有对话记录。
- `session_not_found`：找不到原来的对话。
- `invalid_startup_cwd`：原来的工作目录不在了。
- `backend_unavailable`：这种 lane 不能由 Router 打开，或者 Codex 宿主没连上。
- `terminal_launch_failed`：终端没能启动。

### 3.6 lane 侧指南

Claude Code 给 channel 通知套了一层「这不是用户说的」提示，lane 会先读信，看到 `sender: user:issues` 才知道是用户。现在 lane 把网页回复当用户输入处理，依据的是通用仓 `techniques/lane-router-issues.md` 第 3 步「把网页回复当作原任务中的用户输入处理」。新问答是新话题，不在任何原任务里，所以指南要补一句：问答页新开的问答是用户本人的指令，等同于 TUI 输入，可以直接做；超出 lane 自身角色或全局规则的事，照常按那些规则办。

这一页还有几处要改：开头一段、「用户怎么提出要求」一节（「网页不是另一套任务授权系统」要改写），以及「收到网页回复后怎么处理」。指南由 inbox 改，push 等用户说。

### 3.7 代码落点

| 位置 | 改动 |
|---|---|
| `src/modules/issues/service.ts` | `create`、`wakeOwner` |
| `src/modules/issues/ports.ts`、`types.ts` | 唤醒端口、`IssueWakeResult`、`CreateIssueInput`、lane 列表类型 |
| `src/modules/issues/http.ts` | `GET /issues/api/lanes`、`POST /issues/api/threads`；`replies` 响应加 `wake` |
| `src/modules/issues/index.ts`（模块装配） | 透传唤醒端口 |
| `src/router/lane-access.ts`、`router-core.ts` | `listActiveLanes` |
| `src/process/main.ts` | 用 `restore` 和 `state.activeBindingForLaneId` 实现唤醒端口，注入问答模块 |
| `src/ui/issues/index.html` | 「新问答」按钮、新问答视图、唤醒提示 |
| `tests/modules/issues/*` | 第五节第 1–8 条 |
| `docs/manual-tests.md` | 真机用例 TC-ISSUES-START-1、TC-ISSUES-WAKE-1 |
| 需求稿 `2026-10-17-user-issue-inbox-requirements.md` | 文首加修订说明，指向本稿（inbox 改） |
| 通用仓 `techniques/lane-router-issues.md` | 3.6（inbox 改） |

不改：问答库结构、投递 worker、通知泵、`ConversationRestorer` 本身、lane 工具。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 新问答入口与视图 | 用户，每开一个新话题 | 用户要求 | 只能回 TUI 开话题 | TUI | 保留 |
| 唤醒（新问答和回复） | 用户，发给没开着的 lane 时 | 用户要求「直接唤醒」；回复一并唤醒由用户在条目 #6 确认 | 消息一直等，要手动去看板恢复 | 看板「恢复 lane」 | 保留 |
| 选 lane 列表的新查询 | 页面，每次打开新问答 | 选 lane 必需 | 页面只能自己拼看板快照 | `dashboardSnapshot` 不合适（见第二节） | 保留 |
| 记住上次的 lane | 用户 | 便利 | 每次重选 | — | 保留（只存本机） |
| 唤醒结果提示 | 用户 | 用户要知道 lane 会不会处理 | 看不出没打开 | presence 标记 | 保留 |
| 新建 lane | — | 用户同意留在 TUI | — | TUI | 不做 |
| 报错、工具过程搬到问答页 | — | 用户明确不要 | — | TUI | 不做 |
| 修正页面 presence 和 `restorePresence` 的差异 | 用户看议题标题栏时 | Codex 关窗时显示「未确认」 | 现状不变 | — | 不做，本稿只在选 lane 时用 `restorePresence` |
| 附件、lane 结束问答、默认发问答 | — | 另有议题（`805a3f1b`、`924e24eb`） | — | — | 不在本稿 |

## 五、验收标准

第 1–5 条是 node 组的单元或集成测试，用临时数据目录，唤醒端口用替身；第 6–8 条是浏览器组（Edge/Playwright），后端用替身或临时 Router；第 9–10 条是真机。

1. `create` 成功：一个事务里写出议题、第一条条目、问题和投递，字段值如 3.1 所列；投递正文含新问答开头、各项 ID、用户的话和「下一步」，并且 questionId 正确。随后 lane 带该 questionId 追加 answer，问题变为 `answered`。
2. `create` 拒绝：空标题或空正文、多余字段、未知 lane、已归档 lane、没有绑定的 lane。被拒时库里没有新增任何行。同键同内容返回原结果、不新增行；同键异内容报 `OPERATION_CONFLICT`。
3. HTTP `POST /issues/api/threads`：缺来源、动作头不对、类型不对、令牌不对各返回 403/400，并且不调用 `create`；带查询串不被这个入口处理；多余字段返回 400；成功时返回 `{ result, wake }`。
4. 唤醒：`create` 或 `reply` 成功后，唤醒端口以 owner 的 lane ID 被调用一次，`wake` 原样回到响应里。端口抛错或返回 `failed` 时，响应仍为 200，保存的数据不变。保存失败（例如议题已结束）时端口不被调用。没注入端口时响应没有 `wake`。
5. `GET /issues/api/lanes`：只含在役、有绑定的 lane，按项目名、lane 名不分大小写排序；不含正文、角色说明和对话 ID。`main.ts` 的唤醒实现：没有绑定时返回 `no_binding`；有绑定时调用的是共享的 `restore` 实例（用替身断言）。
6. 页面：点「新问答」，主区显示新问答视图；下拉框按项目分组，三种状态的文字正确；没选 lane 或正文为空时发送按钮不能点；标题留空时按 3.5 的规则取默认值。
7. 页面：发送成功后切到「进行中」，选中新议题，状态行按 `wake.status` 显示 3.5 表中的文字；回复成功后也显示同样的唤醒提示。发送结果不明时出现「用同一操作重试」，重试用同一个 `operationKey`。
8. 页面：新问答草稿刷新后还在，发送成功后清掉；上次选的 lane 被预选，它不在列表里时不预选。已有的浏览器和 happy-dom 用例全部通过。`npm test`、`npm run typecheck` 全部通过。
9. 真机 TC-ISSUES-START-1：上线后，用户在问答页给一个在线的 lane 新开问答。lane 收到后在这条问答里答复，问题自动变成已回答，「进行中」里能看到这条问答。
10. 真机 TC-ISSUES-WAKE-1：用户在问答页给一个没开着的 Claude lane 和一个没开着的 Codex lane 各发一条（新问答或回复都可以）。Router 打开它们的窗口，lane 在**没人在 TUI 里打字**的情况下收到这条信并处理。子代理核对代码时发现，Claude 用 `--resume` 恢复后 channel 的键能不能对上原对话，以及接上以后会不会立刻投递，真机上都还没验过（`docs/superpowers/specs/2026-08-18-lane-open-new-cli.md:153-155`）。Codex 打开 TUI 本身不会触发投递，要等 thread 状态变化（`codex-host-hub.ts:104-110`）。这一条不通过，就是唤醒功能没完成：impl 要查到原因并修好。修复需要改通信核心的，先找 `lane-router/design` 对齐。

    **2026-10-20 补充：** impl 查代码找到两处原因，design 同意了修法（回信 `445dc5d4`、`9e0ad11c`），各做一个独立的 `fix:` 提交，带测试和变异检验：
    - Claude：MCP 客户端在 sink 挂上前收到的通知帧被直接丢掉（`local-client.ts:94`）。改成无 sink 时只留最新一帧，attach 时补交并清空。
    - Codex：thread 卸载后打开 TUI 不触发投递。改成某个 thread 的可见窗口数从 0 变成大于 0 时，对它 offer 一次，只在这次跳变时触发。

    第一处是现有缺陷，运行看板「恢复 lane」和 `lane_restore_project` 打开带积压信的 lane 时同样会丢帧。所以真机再补一项：用运行看板恢复一个有积压信的 lane，没人打字也能收到并处理。交付说明写明这是现有缺陷的修复，覆盖三条路径：问答页唤醒、看板恢复、`lane_restore_project`。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`。主检出不 build；测试一律用临时数据目录，不碰共享 Router。
- 变异检验（每次改坏一处，看对应的测试有没有变红，看完改回）：
  - `create` 不检查绑定 → 2 变红
  - 投递正文漏掉 questionId，或开头用回复的文字 → 1 变红
  - 新入口不过 `readPageAction` → 3 变红
  - 保存失败后仍调用唤醒，或唤醒失败时返回非 200 → 4 变红
  - lane 列表包含归档 lane 或没有绑定的 lane → 5 变红
  - 唤醒实现新建一个 restorer，而不是用共享实例 → 5 变红
  - 发送成功后不切到「进行中」 → 7 变红
  - `launch_requested` 和 `failed` 的提示对调 → 7 变红
  - 重试换了新的 `operationKey` → 7 变红

## 七、边界

- 不改问答库结构，不改投递 worker、通知泵和 lane 工具。
- 不在问答页新建 lane、改 lane 拓扑，也不打断 lane。
- 不把报错、工具过程搬到问答页。
- 唤醒只打开已有对话，不新建对话，也不带模型覆盖参数。
- 上线要重启共享 Router（`scripts/restart-router.ps1`，由 design 执行），时机和 push 都归用户。
