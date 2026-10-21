# 问答页「进度」标签页：把 Vikunja 的进度看板放进问答页 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-21 由 `lane-router/design` 起草；用户在问答 `c5c595d9` 定口径（10:47 答四问：一卡一件活按负责 lane 分组、五列不加「等提交」、两步都做、加「负责 lane」字段）。Vikunja LR-32。第一步（Vikunja 看板五列 + `owner_lane` 字段 + 挪卡规矩）由 `vikunja/main` 配置、design 归位卡片，不在本稿；本稿是第二步：问答页的「进度」标签页。实现归 `lane-router/inbox-impl`（inbox 派），Router 侧一处配置读取归 `lane-router/impl`。

## 一、问题与结论

用户原话：「我感觉我们需要一个todo list一样的东西，让我知道什么东西正在做，什么东西做好了等待部署，什么东西做完了（这个可能不是特别重要，前两个比较重要）。方便我看一下每个lane的进度，不用每次问你。」「我甚至觉得每个条目都可以放vikunja的条目」。

**结论**：进度的唯一真相是 Vikunja 的卡（LR-n）：第一步给它补「正在做 / 做完待部署 / 已上线 / 等你决定 / 搁置」五列和 `owner_lane` 字段，lane 的状态一变就挪卡。本稿只做一件事：**问答页加一个「进度」标签页，把 Vikunja 这块看板原样嵌进来**（iframe），用户不用换网页；条目就是 Vikunja 的卡，能点开、能拖。不在 Router 里另存工作项、不自绘列表（LR-20 否掉的预建账本；两份真相会对不上）。

## 二、术语

| 词 | 含义 |
|---|---|
| 卡 | Vikunja 的一个任务（lane-router 项目里编号 LR-n），一张卡 = 一件活。 |
| 列 | Vikunja 看板视图的 bucket：正在做 / 做完待部署 / 已上线 / 等你决定 / 搁置。 |
| `owner_lane` | 第一步新增的任务字段：负责这件活的 lane 地址（`<project>/<lane>`）；现有 `source_lane` 是提出它的 lane。 |
| 看板 URL | Vikunja 某项目某视图的页面地址，形如 `http://localhost:3456/projects/<项目 id>/<看板视图 id>`。 |

## 三、取证

- 本机 Vikunja 是 `vikunja/main` 维护的定制版 `v2.7.0-lane.1`，`http://localhost:3456/`（`/api/v1/info`）。`HEAD /` 返回 200，响应头只有 `Server: Vikunja`，**没有 `X-Frame-Options`、没有 CSP `frame-ancestors`** ⇒ 可以被 iframe 嵌入。用户在浏览器里已登录 Vikunja，iframe 里沿用那个登录态。
- 问答页由 Router 提供（`http://127.0.0.1:<端口>/issues`），与 Vikunja 不同源：iframe 只显示、不跨源读写，Router 不需要 Vikunja 的令牌（Vikunja 的 MCP 是 HTTP + 头里带令牌，Router 没有也不该有）。
- Vikunja 看板视图自带筛选（按字段 / 标签），「只看某个 lane」可以在 iframe 里用 Vikunja 自己的筛选；是否能按 `owner_lane` 筛由 `vikunja/main` 在第一步核实。
- 问答页顶栏现有「问答 / 新问答 / 运行看板」，inbox-impl 2026-10-21 刚在左栏标题行下加了「切号后继续」两个按钮；新标签页要放在不挤成两行的位置。
- 家里那台机器的 Vikunja 是另一份实例，项目 id 和视图 id 不一定相同 ⇒ 看板 URL 不能写死在代码里。

## 四、设计

### 4.1 看板 URL 从哪来（impl，一处）

Router 数据目录加一个可选文件 `~/.lane-router/progress-board.json`：

```json
{ "url": "http://localhost:3456/projects/12/<看板视图 id>" }
```

Router 启动与每次 `/dashboard/state` 时读它（文件小，直接读，不缓存），把 `progressBoard: { url } | null` 放进 `/dashboard/state`（问答页已经用这个接口）。文件缺失或不是合法 JSON / 不是 `http://localhost` 或 `http://127.0.0.1` 开头的 URL ⇒ `null`，并在 Router 日志记一行原因；不报错、不影响别的功能。只接受本机 URL，免得把问答页变成任意网页的壳。

### 4.2 标签页（inbox-impl）

- 顶栏加「进度」，与「问答」并列（位置由 inbox-impl 定，交付时写明，不挤成两行）。
- 选中「进度」时右侧内容区整块换成一个 iframe，`src` = `progressBoard.url`，高度撑满内容区；切回「问答」时隐藏 iframe 而不销毁（保留用户在看板里的滚动与筛选）。
- `progressBoard` 为 `null` 时不显示 iframe，显示一段说明：「进度板还没配置：在 `~/.lane-router/progress-board.json` 写 `{ "url": "<Vikunja 看板地址>" }` 后刷新。」
- iframe 顶部一行小字：「这是 Vikunja 看板，拖动卡片、点开卡片都在里面做；在新窗口打开 ↗」（链接到同一 URL，`target=_blank`）。
- 不做刷新按钮（Vikunja 页面自己是活的）、不做 lane 筛选控件（用 Vikunja 自己的筛选）、不把卡的内容读进问答页。

### 4.3 规矩（design，写进 Vikunja 使用约定与本机文件）

- 一张卡 = 一件活；`owner_lane` 必填；状态一变负责 lane 当场挪卡（正在做 → 做完待部署 → 已上线）；等用户拍板的放「等你决定」，暂缓的放「搁置」；「已上线」的卡一周后由 design 标完成。
- 第一步归位 31 张卡由 design 做（LR-32）。

### 4.4 不做

- Router 读 Vikunja API、自绘按 lane 分组的列表（需要给 Router 配令牌、再造一份展示层）——用一周后若 Vikunja 自带筛选不够再议。
- 在问答页里改卡（iframe 里 Vikunja 自己就能改）。
- 把问答议题和卡自动关联（卡的说明里照旧写议题 id）。

## 五、范围审计

| 候选面 | 使用者/频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| `progress-board.json` 一项配置 + `/dashboard/state.progressBoard` | 每台机器一次 | 两台机器 Vikunja 项目 / 视图 id 不同（取证） | URL 写死，家里那台打不开 | 代码写死 | 保留（只收本机 URL） |
| 问答页「进度」标签页 + iframe | 用户每天 | 原话「不用每次问你」「条目可以放 vikunja 的条目」（explicit）；iframe 可嵌（取证） | 用户换网页看 | 直接开 Vikunja | 保留 |
| 未配置时的说明文案 | 首次 | 推断（否则空白） | 用户不知道怎么配 | 文档 | 内化（一句话） |
| Router 读 Vikunja API 自绘分组列表 | — | 推断（按 lane 分组更好看） | 无（Vikunja 自带筛选） | Vikunja 筛选 | 推迟 |
| 刷新按钮 / lane 筛选控件 | — | 推断 | 无 | 浏览器刷新 / Vikunja 筛选 | 删除 |
| 在 Router 里存工作项 | — | 用户已定不预建账本（LR-20） | — | Vikunja | 删除 |

不新增路由、工具、持久状态（一个用户手写的配置文件）、协议。

## 六、验收标准

自动测试：

1. Router（node 组）：`progress-board.json` 存在且 URL 合法本机地址 → `/dashboard/state.progressBoard.url` 等于它；文件缺失 / 非法 JSON / 非本机 URL（如 `https://example.com`）→ `null` 且日志一行；文件改动不用重启就生效。
2. 问答页（happy-dom）：有 `progressBoard` → 顶栏有「进度」，点它内容区出现 iframe 且 `src` 等于 URL，切回「问答」iframe 仍在 DOM 里只是隐藏；`progressBoard` 为 `null` → 无 iframe、显示配置说明；「在新窗口打开」链接指向同一 URL 且 `target=_blank`。
3. 既有问答页用例、dashboard 路由用例全过；`npm test`、`npm run typecheck` 全过。

浏览器（issues 组）：

4. 真 Router + 本机写一份 `progress-board.json` 指向一个本机静态页（替身），点「进度」看到 iframe 加载了那页。

真机：

5. 本机：第一步做完（五列、`owner_lane`、31 张卡归位）后写配置指向 lane-router 项目的看板视图，用户在问答页点「进度」看到看板、能拖一张卡、能点开卡；切回问答不丢看板状态。记 `docs/manual-tests.md`，结果贴 `c5c595d9` 由用户关。
6. 家里机器：拉代码后自己写配置，自行验证（用户回一句）。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；主检出不 build。
- 变异：Router 不校验本机 URL → 1 红；文件改动要重启才生效（改成启动时读一次）→ 1 红；切回问答时销毁 iframe → 2 红；`progressBoard` 为 `null` 仍渲染 iframe → 2 红。

## 八、边界

- 只加：Router 一处配置读取 + state 一个字段；问答页一个标签页、一个 iframe、一句说明。不改 Vikunja、不改任何工具、不碰账本。
- 上线：build + 重启核心（问答页随核心），可与 LR-28 那批同一次重启。
- 依赖：第一步由 `vikunja/main` 配好五列与 `owner_lane`（看板 URL 才有东西可看）。
