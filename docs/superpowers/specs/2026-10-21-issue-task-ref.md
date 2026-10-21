# 问答记下自己配的卡：`task` —— 需求与设计（补充稿）

**状态：** 补充稿，2026-10-21 由 `lane-router/inbox` 起草，落实 design [待办表稿](2026-10-21-progress-list.md)第十节「改动」的第一条（Vikunja LR-59）。由 `lane-router/inbox-impl` 实现。要升问答库版本（v4 → v5），并改 lane 工具参数，上线要带 `-CodexHost`。

## 一、来由

用户 15:5x 定了问答和卡的配对规则，原文见第十节：
- 一张卡配一条「干活问答」，一对一；
- 一条问答最多一张卡；
- 用户「反馈几件事」的问答不挂卡，lane 每件事开一条子问答、配一张卡；
- 一张卡可以被多条问答在正文里提到，但正文里的提及不进字段。

卡那边已经有 `source_issue`。这份补充稿做问答这边：问答记下自己配的卡号，lane 开问答时能带上，页面在标题旁显示卡号和卡所在的列。

## 二、设计

### 2.1 问答库 v5

- `UPGRADES` 加一步：
  - `ALTER TABLE issue_thread ADD COLUMN task_ref TEXT`；
  - `CREATE UNIQUE INDEX issue_thread_task_ref_idx ON issue_thread(task_ref) WHERE task_ref IS NOT NULL`。
- 升级前照旧用 `VACUUM INTO` 备份成 `.v4.bak`。只加列和索引，不动已有数据，旧问答的 `task_ref` 都是 NULL。
- **唯一索引是一对一的兜底：** 同一个卡号只能挂在一条问答上。卡号的前缀不同（`LR-`、`MCN-` 等）就是不同项目的卡，互不冲突。

### 2.2 格式与规则（服务层）

- **格式：** 卡号是 `^[A-Z][A-Z0-9]*-\d+$`，大写字母开头，最长 32 个字符。不合格式返回 `INVALID_INPUT`。
- **一条问答最多一张卡：** 已经配了 `LR-56`，再设成别的卡号，返回 `TASK_ALREADY_SET`，信息里写出现有的卡号，并说「先设成 null 再换」。设成同一个卡号算重复操作，直接返回成功。
- **一张卡最多一条问答：** 这个卡号已经挂在别的问答上，返回 `TASK_TAKEN`，信息里写出那条问答的 id。
- **只有所属 lane 能设：** 走现有的 `agentWrite`（要求所属 lane、当前绑定）。
- **已结束的问答不能设：** 和不能往已结束的问答里追加一致，要用的话等用户回复、问答重新打开以后再设。
- **事件条目：** 每次设或清，都写一条 event 条目：「lane 配上卡 LR-56」或「lane 去掉卡 LR-56」。
- **幂等：** 和别的写操作一样带 `operationKey`。

### 2.3 lane 工具与 CLI

- `lane_issue_publish` 两种 kind（answer、question）都加可选参数 `task`：
  - 校验和 2.2 一样；
  - 卡号被占用时整个发布失败，不建问答。
- `lane_issue_update` 加一种动作 `action: "set_task"`，参数是 `operationKey`、`issueId`、`task`（卡号或 `null`）。
- 工具说明里写一句用法，不改开局说明文字（`ISSUE_INSTRUCTIONS`）：
  - 「这条问答的活有卡时带上卡号；一条问答最多一张卡，用户反馈几件事的问答不挂卡，按件开子问答各配一张。」
  - 详细做法等工具上线后，由 design 写进规范。
- `lane-router-lane issue publish` 和 `update` 走同一个业务接口，JSON 文件里加同名字段。

### 2.4 读出

- 线程详情的 `thread`、列表里的每一项，都带 `task: string | null`。
- `lane_issue_read` 的结果里也有它。

### 2.5 页面

1. **标题旁：** 问答配了卡时，在标题下面那一行（`detail-meta`，短 id 前面）显示：
   - **卡号：** 走已有的 `LR-n` 开卡链接（`<origin>/projects/<前缀>/tasks/by-index/<n>`，在新窗口打开）。还不知道看板地址时，卡号只显示文字。
   - **所在列：** 从 `/dashboard/progress` 的快照里，按 `identifier === task` 找到这张卡，显示它的 `column.title`，比如「LR-56 · 正在做」。
     - 没有快照时，打开带卡号的问答就读一次。读法用待办表已有的 `loadProgress(false)`：60 秒缓存、同一时间只有一个请求。读到以后补上列名。
     - 找不到这张卡（已完成、不在看板上，或者读失败），就只显示卡号，不写列名。
2. **左栏列表项：** 配了卡的问答，在标题前面加一个小徽标，显示卡号（纯文字，不做链接，免得点列表项时误点）。
3. **卡号前缀：** 页面上的 `LR-n` 链接现在只认 `LR`。`task` 的前缀是别的项目时，标题旁只显示文字，不做链接。等别的项目上待办表时再统一放开。

## 三、验收标准

第 1–5 条是 node 组用例，第 6–8 条是 happy-dom，第 9 条是全量。

1. **升级：**
   - v4 升到 v5，只留 `.v4.bak`，原有数据不变，`task_ref` 都是 NULL；
   - v1 一次升到 v5，只留 `.v1.bak`；
   - 新库的结构和升级上来的一致；
   - 版本号是 5；
   - 结构被改过的 v4，或者冒充 v4 的库，原样拒收，不留备份。
2. **格式：** `lr-56`、`LR56`、`LR-`、`LR-5a`、超长的卡号，都返回 `INVALID_INPUT`；`LR-56`、`MCN-7` 能通过。
3. **一对一：**
   - 已配 `LR-56` 再设 `LR-57`：返回 `TASK_ALREADY_SET`；
   - 先设 null 再设 `LR-57`：成功；
   - 设同一个卡号：成功，不多写 event 条目；
   - 另一条问答设 `LR-56`：返回 `TASK_TAKEN`，信息里有第一条问答的 id；
   - `publish` 带一个已被占用的卡号：失败，并且没有建出问答。
4. **权限与状态：**
   - 别的 lane 调 `set_task`：被拒；
   - 对已结束的问答调：被拒；
   - 设和清各写一条 event 条目，文字照 2.2。
5. **读出：** 详情、列表、`lane_issue_read` 都带 `task`。工具的 schema 有 `task` 和 `set_task`，CLI 的 JSON 也认这两个字段。
6. **标题旁：**
   - 配了卡、有快照：显示「卡号链接 · 列名」，链接 `href` 正确，在新窗口打开；
   - 有快照但找不到这张卡：只有卡号；
   - 没有快照：打开问答时读一次 `/dashboard/progress`，读到以后补上列名；60 秒内打开第二条带卡号的问答，不再读；
   - 前缀不是 `LR`：只显示文字。
7. **左栏：** 配了卡的列表项有卡号徽标，没配的没有。
8. **`actionToken`：** 打开问答时读进度快照，不覆盖页面的 `actionToken`（照待办表那条用例的写法）。
9. 已有用例全过；`npm run typecheck`、`npm test` 全过。

## 四、变异检验

- 去掉唯一索引，服务层也不查 → 3 红（`TASK_TAKEN`）
- 允许直接换成第二张卡 → 3 红（`TASK_ALREADY_SET`）
- 非所属 lane 也能设 → 4 红
- 升级时给旧行补 `task_ref` → 1 红
- 没有快照时也写列名，或者写错的列名 → 6 红
- 打开每条问答都重读，不看 60 秒 → 6 红

## 五、边界与上线

- 改问答库（v5）、问答服务、两个 lane 工具的参数和说明、CLI、页面、测试。不改 Vikunja，不改 Router 核心其他部分。
- 上线：
  - 部署前备份问答库，升级时会自动留 `.v4.bak`；
  - 工具参数变了，要 build 并 `restart-router.ps1 -CodexHost`；
  - Claude lane 要关窗口重开（`lane-router-lane open`），才看得到新参数。
- 上线以后，design 改规范：开卡时填 `source_issue`，开问答时带 `task`。
