# 问答页「进度」：按 lane 分组的待办表 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-21 由 `lane-router/design` 起草。用户在问答 `c5c595d9` 定口径：14:37「我要的不是把 vikunja 嵌入进来。我要的更像是看一个跟 lane 相关的 todo list，这样我就能看到哪些在做哪些待发布/部署哪些还 pending 了。我在想要做到这个我们的问答是不是要完全跟 vikunja 的任务对上好一点？」；15:00 答两问：「1. 以 lane 为主」，「等你决定」顶上单独一段 design 提议、用户未反对。Vikunja LR-56。本稿替代 `2026-10-21-progress-tab.md` 的 iframe（LR-32 第二步只是过渡，4.1 的配置文件沿用）。实现分三方：`vikunja/main`（字段、令牌、约定）、`lane-router/impl`（Router 读取与路由）、`lane-router/inbox` 出页面稿 → `lane-router/inbox-impl`。

## 一、问题与结论

用户要的是一张表，一眼看到**每条 lane 手上**什么在做、什么做完等部署、什么卡着等他拍板，不用问 lane。嵌进来的 Vikunja 看板是按状态分五列、卡上只印着负责 lane，看不出「每条 lane」；它又是别人的页面，样子改不了。

**结论**：
1. 真相仍然只在 Vikunja 的卡上（LR-20 否掉的「Router 另存工作项」不变）。Router 用一枚只读令牌从 Vikunja 读看板，页面**自绘**一张按 lane 分组的待办表，放在问答页「进度」标签页里，替掉 iframe。
2. **问答和卡不一一对应，做双向链接**。一条问答常拆成几件活（「问答页易用性」`ec5b42f4` 拆成 LR-49、LR-53），也有活没有问答（内部缺陷）。硬对会把问答页变成工单系统。链接够用：卡上加「来源问答」字段（像 `owner_lane` 一样是正式字段），问答正文里的 `LR-n` 已经能点开卡（易用性第二批）。待办表每行两个跳转：开卡、跳到来源问答。
3. 「等你决定」是进度板的一列（某件活卡在用户拍板上），不是问答页的「待我处理」（某条问答有问题等用户回）；两者大多重合。待办表顶上单独一段「等你决定」，不分 lane，每张卡带「去问答」跳转；「待我处理」筛选照旧。

## 二、术语

| 词 | 含义 |
|---|---|
| 卡 | Vikunja 的一个任务，一张卡 = 一件活；lane-router 项目里编号 `LR-n`。 |
| 列 | 看板视图的 bucket：正在做 / 做完待部署 / 已上线 / 等你决定 / 搁置。 |
| 看板 | 某个 lane 项目在 Vikunja 里的 kanban 视图，地址形如 `http://localhost:3456/projects/<项目 id>/<视图 id>`。 |
| `owner_lane` / `source_lane` | 已有的正式字段：负责这件活的 lane / 提出它的 lane，格式 `<project>/<lane>`。 |
| `source_issue` | 本稿新增的正式字段「来源问答」：这张卡来自哪条问答，存问答的完整 id。 |
| 待办表 | 本稿要做的那张表：按项目 → 负责 lane 分组，每条 lane 下分「正在做 / 做完待部署 / 已上线」三段。 |

## 三、取证（2026-10-21）

- 本机 Vikunja 是 `vikunja/main` 维护的定制版 `v2.7.0-lane.3`（`GET /api/v1/info`）。
- **读看板用 v1 接口**：`GET /api/v1/projects/12/views/48/tasks` 返回 bucket 数组，每个 bucket 带 `tasks`（字段含 `id`、`identifier`（`LR-53`）、`title`、`done`、`done_at`、`updated`、`owner_lane`、`source_lane`、`labels`、`description`）。v2 的 `/api/v2/projects/12/views/48/buckets` 只有 bucket 没有 tasks；`/api/v2/projects/12/views/48/tasks` 是扁平任务列表、不带 `bucket_id`。`/api/v2/projects/12/views` 能核对视图 `view_kind === "kanban"`。
- 看板只显示未完成的卡（`done = false`）；「已上线」的卡一周后 design 标完成。
- 令牌：Vikunja 的 MCP 用一枚 API 令牌（在 `~/.claude.json` 里），**Router 不复用它**；Vikunja 可以另发只读令牌（设置页 → API 令牌，勾 projects / tasks 的读权限）。
- 已上线的东西可复用：页面启动就读一次 `/dashboard/state`（`progressBoard.url`）；正文里的 `LR-n` 变成开卡链接；lane 地址可点、左栏出现「只看 … ✕」（易用性第二批 `08d3e61`）；问答 id 自动变链接（第一批 `ec582cf`）。
- 家里机器的 Vikunja 是另一份实例，项目 / 视图 id 不同，所以看板地址和令牌都在本机配置文件里。

## 四、设计

### 4.1 Vikunja：「来源问答」字段（vikunja/main）

- 任务加正式字段 `source_issue`（显示名「来源问答」）：问答的完整 id（UUID），可空。校验：空，或 36 位 UUID；8 位短 id 不收（页面显示时自己截短）。REST、v2 schema、MCP 的 `tasks_create` / `tasks_update` / `tasks_bulk_create` / `tasks_bulk_update` 都带上，和 `owner_lane` 一个待遇。
- 任务页上显示它；点了打开问答页的深链 `<Router 地址>/issues?issue=<id>`（Router 地址每次重启会变，所以 Vikunja 侧只显示 id 不做链接，跳转从问答页这边发起；若 vikunja/main 有稳定地址可用再加链接）。
- 使用约定（`Vikunja使用约定.md`）加一行：**有问答的活必填** `source_issue`，填它配对的那条干活问答（配对规则见第十节；2026-10-21 15:5x 前的写法「一条问答拆成几张卡，每张都填同一条」作废）。
- 回填：lane-router 项目里说明带问答 id 的卡，由 design 用 `tasks_bulk_update` 填；其他项目的卡，负责 lane 下次动它时顺手填。

### 4.2 配置与令牌（impl 读、vikunja/main 写）

`~/.lane-router/progress-board.json` 在 LR-32 的基础上扩成：

```json
{
  "url": "http://localhost:3456/projects/12/48",
  "token": "<Vikunja 只读 API 令牌>",
  "boards": { "lane-router": "http://localhost:3456/projects/12/48" }
}
```

- `url` 照旧（`/dashboard/state.progressBoard.url`，「在 Vikunja 里打开看板」用它）；`boards` 可选，键是 lane 的项目名、值是该项目看板地址，缺省等于 `{ "<url 对应的项目>": url }`——项目名从哪来：缺省写 `lane-router`；别的项目要显示就在 `boards` 里加一行。
- `token` 只在 Router 进程里用，**永远不进 `/dashboard/state`、不进任何页面、不进日志**。缺 `token` ⇒ 待办表不可用，`/dashboard/progress` 返回 `unconfigured`，页面显示配置说明；`url` 照旧可用（「在 Vikunja 里打开看板」链接还在）。
- 令牌由 `vikunja/main` 在 Vikunja 里发一枚**只读**令牌（projects 读、tasks 读）写进这个文件；design 核对文件后再通知 impl 部署。同一规则：只接受本机地址（`http://localhost` / `http://127.0.0.1`）。
- 文件仍是每次用时读，改了不用重启。

### 4.3 Router 路由 `GET /dashboard/progress`（impl）

- 只读，同源，不要 `actionToken`（和 `/dashboard/state` 一样用单独的 `fetch`）。`refuseWebPage` 不适用（它就是给页面的）。
- 对 `boards` 里每个看板：从地址解析项目 id 和视图 id；`GET <origin>/api/v1/projects/<p>/views/<v>/tasks`，`Authorization: Bearer <token>`，超时 5 s；bucket → 列，task → 条目。
- 返回：

```json
{ "result": {
    "fetchedAt": 1792566000000,
    "boards": [{
      "project": "lane-router", "boardUrl": "http://localhost:3456/projects/12/48",
      "error": null,
      "columns": [{ "id": 34, "title": "正在做", "kind": "doing" }, ...],
      "items": [{
        "id": 465, "identifier": "LR-56", "title": "…",
        "column": { "id": 34, "title": "正在做", "kind": "doing" },
        "ownerLane": "lane-router/design", "sourceLane": "lane-router/design",
        "sourceIssue": "c5c595d9-070e-4f1c-a91c-7514936f6e9b",
        "labels": ["待办"], "updatedAt": 1792565000000,
        "cardUrl": "http://localhost:3456/tasks/465"
      }]
    }]
} }
```

- `kind` 按列标题对：正在做 → `doing`、做完待部署 → `deploy`、已上线 → `live`、等你决定 → `decide`、搁置 → `shelved`，别的标题 → `other`（页面按标题原样显示在该 lane 末尾）。`done` 为真的条目不返回。
- 缓存：每个看板一份快照，60 s 内重复请求直接给快照；并发请求共用一次抓取。抓取失败（连不上、非 200、JSON 不对）⇒ 该看板 `error: { reason, at }` 并返回上一份快照的 `items`（没有就空数组），别的看板不受影响；Router 日志一行。`?fresh=1` 跳过缓存（页面「刷新」用）。
- 未配置 `token` ⇒ `{ "result": { "unconfigured": true, "fetchedAt": …, "boards": [] } }`；`url` 也没有 ⇒ 同样 `unconfigured`。

### 4.4 页面（inbox 出稿 → inbox-impl）

「进度」标签页内容区换成待办表；iframe 删掉。

- **头一行**：「数据来自 Vikunja，<相对时间> 更新 · 刷新 · 在 Vikunja 里打开看板 ↗」（最后一个链接 = `progressBoard.url`，`target=_blank`）。读不到时这一行写「Vikunja 没读到：<原因>（<时间>）」，下面照旧显示上一份快照。
- **顶上一段「等你决定」**：所有看板里 `kind === "decide"` 的卡，按 `updatedAt` 新的在前；每行：`LR-n`（新窗口开卡）、标题、负责 lane、「去问答 ↩」（有 `sourceIssue` 时，本页切到那条问答——就是点引用链接的行为）。一张都没有时这一段不显示。
- **正文**：按项目分组（只有一个看板时不显示项目标题），项目内按 `ownerLane` 分组，lane 地址排序；`ownerLane` 为空的卡归到项目末尾的「还没定负责 lane」。每条 lane 下三段：**正在做**（`doing`）、**做完待部署**（`deploy`）、**已上线**（`live`，只显示 `updatedAt` 在最近 7 天内的）；`other` 列按原标题再加一段。空段不显示；三段都空的 lane 不显示。
- **搁置**：每个项目末尾一个折叠块（`<details>`），摘要写「搁置 N 件」，默认收起。
- **每行**：`LR-n` 链接（`cardUrl`，新窗口）· 标题 · 来源问答（有就显示短 id 并走页面已有的问答链接升级，悬停见标题、点了本页切过去）· 更新时间（相对，如「3 小时前」）。**2026-10-21 16:23 用户补充**「进度里的东西能直接跳转到对应的问答就更好了」：有来源问答的卡，**标题本身可点**，点了和短 id 一样本页切到那条问答（历史 push，后退回「进度」），悬停显示问答标题；没有来源问答的卡标题是纯文字。lane 名可点：和正文里点 lane 地址一样，左栏「只看 <lane>」；停在「进度」不切标签页。
- **读取时机**：切到「进度」时若没有数据、或上一份数据超过 60 s，就 `GET /dashboard/progress`；「刷新」带 `?fresh=1`；不轮询。页面启动不读它（启动那次只读 `/dashboard/state`）。
- **未配置**：显示「待办表还没配置：在 `~/.lane-router/progress-board.json` 加 `token`（Vikunja 只读 API 令牌），写好再点一次「进度」。」；有 `url` 时「在 Vikunja 里打开看板 ↗」照常。
- **窄屏**：行内元素换行，不横向滚动；和「切号后继续」一样在真 Edge 里量 1280、681–999、≤680 三档。

### 4.5 规矩（design 写进约定）

- 一张卡 = 一件活；`owner_lane` 必填；有问答的活 `source_issue` 必填；状态一变负责 lane 当场挪卡；等用户拍板的放「等你决定」并同时把问题发到问答；「已上线」的卡一周后 design 标完成（待办表也只看 7 天）。
- 别的项目要上待办表：在 Vikunja 建同名项目、看板配同样五列、`boards` 加一行。

### 4.6 不做

- 在问答页里改卡、拖卡（点 `LR-n` 去 Vikunja 改）。
- 问答状态和卡的列互相自动同步、问答与卡一一对应。
- Router 另存工作项（LR-20）。
- 每条问答详情里列「相关的卡」——推迟：先看待办表够不够。
- 轮询刷新、桌面通知。

## 五、范围审计

基线：用户要「看一张跟 lane 相关的 todo list：在做 / 待部署 / pending」（explicit）；「问答和 Vikunja 任务对上」（explicit，design 收成「双向链接」）；分组以 lane 为主（explicit）；「等你决定」顶上一段（design 提议，用户未反对，看稿时可改）。

| 候选面 | 使用者 / 频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| Vikunja 字段 `source_issue` | 每张有问答的卡 | 「问答…跟 vikunja 的任务对上」（explicit） | 待办表没法跳回问答，卡上只能靠说明里的手写 id | 说明里写 id（解析不可靠） | 保留 |
| 配置里的只读令牌 | 每台机器一次 | Router 读 Vikunja API 的前提（explicit 需求的必要条件） | 读不到卡 | 复用 MCP 令牌（权限过大、文件格式脆） | 保留（只读、不出进程） |
| `boards` 多看板配置 | 每台机器一次 | 「每个 lane 的进度」（explicit）；lane 分布在多个项目 | 只能看 lane-router | 只配 `url` | 保留（可选，缺省一项） |
| `GET /dashboard/progress` | 页面，每次切到「进度」 | 页面要数据（explicit 的必要条件） | 页面自己带令牌读 Vikunja（令牌泄露到浏览器） | iframe | 保留（只读、同源） |
| 60 s 快照缓存 / 失败回退 | 内部 | 推断（Vikunja 偶尔重启、用户来回切标签页） | 每次切标签页打 Vikunja；Vikunja 挂了表空白 | 无 | 内化（不暴露开关） |
| 待办表（分组、三段、7 天、搁置折叠） | 用户每天 | 原话（explicit） | — | iframe | 保留 |
| 顶上「等你决定」一段 | 用户每天 | design 提议，用户看稿定 | 要在各 lane 下找 | 「待我处理」筛选 | 保留（用户可否） |
| 点 lane 名只看它 | 用户 | 推断（已有机制，零新面） | 要手动筛 | 正文里点 lane 地址 | 合并进已有筛选 |
| 问答详情里列相关卡 | — | 推断 | 无 | 待办表 | 推迟 |
| 页面里改卡 | — | 无 | 无 | Vikunja | 删除 |

新增：一个只读路由、一个配置键（令牌）、Vikunja 一个字段。不新增工具、不改 Router 存储、不改协议。

## 六、验收标准

自动测试：

1. Router（node 组）：配置缺 `token` → `/dashboard/progress` 返回 `unconfigured`；`/dashboard/state` 里**没有** `token`；看板地址非本机 → 该看板 `error`；Vikunja 替身返回取证里的 bucket 形状 → `columns` / `items` 映射正确（`kind` 五个对上、其他标题为 `other`、`done` 的不返回、`cardUrl` = `<origin>/tasks/<id>`）；60 s 内第二次请求不再打替身，`?fresh=1` 打；替身 500 / 超时 / 坏 JSON → `error` 带原因且 `items` 是上一份快照；日志一行。
2. 问答页（happy-dom，`/dashboard/progress` 用替身）：切到「进度」才请求；顶上「等你决定」只列 `decide`，带「去问答」且点了切到那条问答；按 `ownerLane` 分组、三段、`live` 只显示 7 天内、空段不显示、空 lane 不显示；搁置在 `<details>` 里默认收起；`other` 列按标题显示；`LR-n` 链接 `href` = `cardUrl` 且 `target=_blank`；来源问答短 id 被升级成问答链接；点 lane 名后左栏出现「只看 <lane>」且标签页仍是「进度」；60 s 内切回不重读、「刷新」带 `?fresh=1`；`unconfigured` 显示配置说明且「在 Vikunja 里打开看板」仍在；`error` 时头一行写原因、表照旧显示快照。
3. 既有问答页、dashboard 用例全过；`npm test`、`npm run typecheck` 全过。
4. Vikunja（vikunja/main 自己的验收）：字段存取、校验（非 UUID 拒绝）、v2 schema、MCP 四个工具带参数；约定文档更新；版本号 `v2.7.0-lane.4`。

浏览器（issues 组）：

5. 真 Router + 本机一个静态 JSON 当 Vikunja 替身（配置指向它），切到「进度」看到表、点 `LR-n` 开新窗口、点「去问答」切过去。

真机：

6. vikunja/main 发令牌、写配置；design 回填 lane-router 卡的 `source_issue`；用户在问答页点「进度」看到按 lane 的表，顶上有「等你决定」，点一张卡的来源问答能跳过去；Vikunja 停掉再切标签页，头一行写原因、表还在。记 `docs/manual-tests.md`，结果贴 `c5c595d9` 由用户关。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；主检出不 build。
- 变异（改坏一处看对应用例变红，看完改回）：令牌放进 `/dashboard/state` → 1 红；`done` 的也返回 → 1 红；缓存不看 60 s → 1 红；失败时丢掉快照 → 1 红；`live` 不按 7 天过滤 → 2 红；「等你决定」按 lane 分散 → 2 红；点 lane 名切回「问答」→ 2 红；`LR-n` 不开新窗口 → 2 红；未配置时也渲染表 → 2 红。

## 八、边界与上线

- Router：一处配置读取扩展、一条只读路由、一个 Vikunja 客户端；不改存储、不改工具、不改任何 lane instructions。
- Vikunja：一个字段、一枚只读令牌，由 `vikunja/main` 升级定制版并写配置。
- 上线顺序：vikunja/main 升级并写 `token` → impl 的路由进 master → inbox-impl 的页面进 master → design 部署（只重启核心）。页面没上之前路由上了也无害。
- 时间：impl 排在 LR-55 之后、LR-24 之前（用户把这件放在「前两个比较重要」）；inbox 可以先出页面稿、inbox-impl 按本稿的返回形状先做页面，不等路由。

## 十、问答与卡的配对规则（2026-10-21 15:5x 用户定；第二批）

**起因**：用户 15:2x 问「双向链接是多对多吗？我觉得一条问答可以不对或最多对一个任务，一个任务可以对多个问答」，并举例「我开一个问答反馈几个问题，让每个问题开一个任务和问答，我开的那条就不用任务」。design 辩证一轮（正题多对多、反题问答 ≤ 1 卡）后的合题，用户 15:5x「没啥问题，你推进一下」。

**规则**：
1. **正式配对一对一**：一张卡配一条「干活问答」——lane 为这件活开的那条，或用户那条本来只说一件事的问答。进字段的只有这一对：卡上 `source_issue` 填它，问答上记它的卡号。
2. **一条问答最多一张卡。** 用户「反馈几件事」的问答不挂卡，是讨论：lane 读完每件活开一条子问答配一张卡（`lane_issue_publish` 带 `task`，正文第一行链回父问答的 id），在父问答里回「拆成了 LR-a、LR-b、LR-c」；父问答的状态就是拆出那几件各自的状态，不另算。只说一件事的问答直接配卡，不另开。做到一半又冒出一件：新开子问答配新卡，老问答里链过去，老问答仍只配老卡。
3. **一张卡可以被多条问答提到**（用户的反馈问答、别的 lane 的讨论）：正文里的 `LR-n` 链接，不进字段。
4. 历史上一对多的卡（LR-49 / LR-53 / LR-57 共用 `ec5b42f4` 等）不回填、不拆；从现在起按新规则开。

**改动**：
- **问答库 v5（inbox 稿 → inbox-impl）**：`issue` 加 `task_ref TEXT NULL`（卡号，如 `LR-56`；校验 `^[A-Z][A-Z0-9]*-\d+$`，一条问答只能有一个）。`lane_issue_publish` 加可选 `task`；`lane_issue_update` 加 `set_task`（`task` 或 `null`，只许所属 lane 调，写 event 条目）。线程详情与列表项带 `task`。页面：标题旁显示卡号（走已有的 `LR-n` 开卡链接）和它所在的列（从 `/dashboard/progress` 的快照取，没取到只显示卡号；打开带卡号的问答时若没有快照就读一次），左栏列表项也标卡号。
- **待办表（4.4）**：每行的「来源问答」就是那条干活问答，不变。
- **Vikunja 约定（vikunja/main）**：「一条问答拆成几张卡，每张都填同一条」改成「每张卡填它自己配的干活问答；用户反馈几件事的那条不填到任何卡上」。字段不变。
- **规范（design，`techniques/lane-router-issues.md` 与 `lane-router.md`）**：写明第 2 条的做法和「开卡时 `source_issue`、开问答时 `task` 都填」；等工具参数上线后再改，免得规范先于工具。

**范围审计补充**：

| 候选面 | 使用者 / 频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 问答侧 `task_ref` 字段 + `task` / `set_task` 参数 | 每条干活问答一次 | 用户 15:5x 批的规则（explicit） | 问答页不知道自己配的卡，只能靠正文里手写的 LR-n | 正文手写 | 保留 |
| 标题旁卡号 + 所在列 | 用户每天 | design 提议「显示卡号和它在哪一列」，用户批（explicit） | 要去进度页找 | 进度页 | 保留（列取不到时退化为只显示卡号） |
| 父问答自动汇总子问答状态 | — | 推断 | 无（父问答里 lane 回一段文字） | 文字 + LR-n 链接 | 推迟 |
| 问答状态与卡的列自动同步 | — | 用户已定不一一对应 | 无 | 手动 | 删除 |

**验收补充**：问答库 v4 → v5 只加列、留 `.v4.bak`；`task` 校验（非法格式拒绝、第二张卡拒绝）；`set_task` 只许所属 lane；详情与列表带 `task`；页面标题旁出现卡号链接，有快照时带列名，无快照时只有卡号；变异：允许两张卡 → 红；非所属 lane 能改 → 红；无快照时也写列名 → 红。
