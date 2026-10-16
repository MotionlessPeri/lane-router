# lane set 设计稿

**状态：** 设计稿，依据 [需求确认稿](2026-10-16-lane-sets.md)。2026-10-16 用户授权按「design 出稿、impl 实现」直接推进，不另设 gate（「那直接做吧，做完叫我」）。同日由 impl 实现、随 `a6aa0b5` 合入 master，共享 Router 已重启到该构建（在用库 7 → 10，记录见 `docs/manual-tests.md` 的 TC-MERGE-1）；真开窗口的验收 TC-SET-1 尚未执行。本文只决定怎么做；要什么、不做什么以需求稿为准。

## 术语表

| 词 | 含义 |
|---|---|
| set | Router 里的一行数据：名字加成员表。lane 自己不带「属于哪个 set」的字段 |
| 成员 | set 里的一条在役 lane，按 lane 的 id 记，不按地址 |
| 默认 set | 没进任何 set 的 lane 按项目归堆。不落数据，只是「查不到 set」时的行为 |
| 窗口 | Windows Terminal 的一个窗口，lane 作为标签页开在里面。Router 开 lane 时用 `-w <名字>` 指定 |
| 启动器 | 后台页面上用来勾选并启动 lane 的那一块 |

## 一、问题

见需求稿。一句话：窗口名等于项目名，用户要把「一起干的那一批 lane」开进同一个窗口，这批可以是项目的子集，也可以跨项目。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| 独立两张表 `lane_set` / `lane_set_member`，不在 `lane` 表加列 | 是 | 需求 1：lane 不带字段。成员表以 `lane_id` 为主键，「一条 lane 只在一个 set」成了 schema 约束而不是代码约定 |
| 成员按 lane id 记，不按地址 | 是 | 地址归档后会被复用；接手地址的新 lane 是另一条 lane，不该继承旧 lane 的 set |
| 窗口名由 Router 内直接查（恢复），两条 CLI 经 `/lanes/resume-info` 新字段 `laneSet` 取 | 是 | `open` 和 `rotate` 跑在 Router 外，本来就经 HTTP 问事实。不动 `lane_directory` 的输出：那是 agent 可见面，set 不是 agent 要知道的事，而且测试里对它的形状有精确断言 |
| `new` 一律进项目窗口 | 是 | lane 还不存在，谈不上 set |
| set 管理走一个新 endpoint `POST /dashboard/lane-sets`，守卫与 `/dashboard/lanes/open` 相同 | 是 | 同一个威胁模型：挡跨站网页，不防本机进程 |
| 页面在快照没有 `laneSets` 字段时按今天的样子工作 | 必须 | `dist/dashboard.html` 是按请求读的，`npm run build` 一跑它就先于 Router 进程升级；旧 Router 配新页面不能坏 |
| set 名遵守 lane 地址段的字符规则（`address.ts` 的 `SEGMENT`），且不与现有项目同名 | 是 | 窗口名经 `Start-Process -ArgumentList` 原样拼接，空格会拆成两个参数；同名会和项目在页面上并成一堆 |

## 三、设计

### 3.1 存储（schema 10）

```sql
CREATE TABLE lane_set (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE lane_set_member (
  lane_id TEXT PRIMARY KEY REFERENCES lane(id) ON DELETE RESTRICT,
  set_id TEXT NOT NULL REFERENCES lane_set(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL
);
CREATE INDEX lane_set_member_set_idx ON lane_set_member(set_id);
```

- `ROUTER_SCHEMA_VERSION` 改为 10；`ROUTER_SCHEMA_SQL` 追加这两张表。
- 迁移：`completeFromVersion6` 多一步「没有 `lane_set` 表就建两张表」，与已有两步同一个事务；版本号写 10。纯加法，不重建任何表，不动任何行。该函数的注释要跟着改（「版本号一次写在所有步骤到位之后」仍成立）。
- 测试 fixture `tests/fixtures/router/schema-shapes.ts` 的 `STARTING_SHAPES` 加 `laneSets` 维度和 `v10` 形态；现有「v9 原样不动」的用例变成 v10。
- 删 set 时成员行随 `ON DELETE CASCADE` 消失，lane 回到项目。lane 永远不删（`RESTRICT` 保持一致）。
- 归档 lane 时顺手删掉它的成员行（`RouterStateStore.archiveLane` 内）：set 记的是在役的 lane。

### 3.2 state-store

| 方法 | 作用 |
|---|---|
| `listLaneSets()` | 全部 set，带在役成员地址（按地址排序），空 set 也列；按名排序 |
| `createLaneSet(name, now)` | 名字 trim 后建；重名抛错 |
| `deleteLaneSet(id)` | 删 set，成员回项目 |
| `assignLaneSet(address, setId \| null, now)` | 挪进 / 移出；lane 必须在役；已在别的 set 则换过去 |
| `laneSetNameFor(address)` | 窗口名用；在役 lane 不在 set 里或查不到返回 `undefined` |
| `projectHasLiveLanes(project)` | 建 set 时查同名 |

### 3.3 RouterCore

- `ResumeInfo` 的 `bound` 分支加 `laneSet: string | null`。
- set 操作四个薄方法 `listLaneSets` / `createLaneSet` / `deleteLaneSet` / `assignLaneSet`，业务规则在这一层，错误用 `RouterError`：
  - 名字合法：`address.ts` 的 `SEGMENT`（导出一个 `isAddressSegment` 之类的判断，不复制正则）；
  - 不与有在役 lane 的项目同名；
  - 挪的 lane 必须在役（归档和不存在都拒，拒绝语区分两者）；
  - 删 set 必须为空（防一键把一堆 lane 打回项目）。

### 3.4 快照与 HTTP

- `DashboardSnapshot` 多一个 `laneSets: readonly { id, name, members: readonly string[] }[]`。lane 行不变。
- `POST /dashboard/lane-sets`，body 之一：
  - `{ action: "create", name, actionToken }`
  - `{ action: "delete", setId, actionToken }`
  - `{ action: "assign", addresses: [...], setId: string | null, actionToken }`
- 四道守卫与 open 相同：`Origin` 等于 Router 地址、`X-Lane-Router-Action: lane-sets`、`Content-Type` JSON、token。把 open 那段守卫抽成一个函数两处共用。
- `LocalRouterServer` 新增可选项 `dashboardLaneSets?: (input) => Promise<unknown>`；未接线返回 404。成功返回 `{ laneSets }`。`main.ts` 接到 `RouterCore` 的四个方法上。
- 不加入 `LANE_TOOL_NAMES`。

### 3.5 窗口命名

| 入口 | 窗口名 |
|---|---|
| 恢复（`ConversationRestorer`，看板与 `lane_restore_project` 共用） | `state.laneSetNameFor(address) ?? project` |
| `lane-router-lane open` | `resumeInfo.laneSet ?? project`；旧 Router 没有这个字段，自然落回项目 |
| `lane-router-rotate` | `laneFacts` 多问一次 `/lanes/resume-info` 取 set；问不到落回项目。现有的 `lane_directory` 查询保留，它给的是 title / model / profile |
| `lane-router-lane new` | 项目，不变 |

### 3.6 页面

- 启动器第一层按组：lane 在 set 里就归 set 名，否则归项目名。**set 组全部排在项目组前面**，两段各自按名排序（不分大小写，沿用现有 `byName`），组内按地址排序。空 set 也显示一组，写「（空）」。建 set / 移入的控件放在启动器最上面、全选那一行之下，不放在打开按钮之下。
  > 勘误（2026-10-16）：用户原话「页面最开始就列 set，然后列 lane」，首版只做成了「分组第一层是 set」而把 set 组与项目组按字母混排、控件压在底部，用户指出后改成本条。
- 组的 DOM：`section.lane-group[data-group=<名字>]`，组头复选框 `input[data-group-checkbox]`。现有测试里的 `section.project` / `data-project` / `data-project-checkbox` 跟着改。
- lane 行保持原样：`地址 · backend · 恢复状态 · model`（Codex 另带 profile / provider）。
  > 勘误（2026-10-16）：本条原写「只显示地址，去掉那串」，源于需求第 6 条的误读（见需求稿勘误），实现后按用户要求改回。
- 控件三处，快照没有 `laneSets` 时一个都不渲染：
  - 「新建 set」文本框加按钮 `button#create-set`，发 `create`；
  - 「把选中 lane 移入」下拉 `select#move-to-set`（选项：「项目默认」值为空，各 set 值为 id）加按钮 `button#move-selected`，对勾选的 lane 发 `assign`；没勾任何 lane 时和打开按钮一样，在状态栏说「先勾选」，不发请求；
  - 空 set 的组头有「删除」按钮 `button[data-delete-set=<id>]`，发 `delete`。
- 这些控件用 `data-set-control` 标记，**不要**用 `data-override`：那个属性的值会被 `openSelected` 收进打开请求的 override。轮询刷新保留文本框内容与下拉选择，和现有覆盖栏同一套机制。
- 三种请求成功后调用 `load()` 重拉快照；失败写状态栏。
- 打开结果（`formatOpenResults`）按组名分组显示，不再按项目。

## 四、范围审计

| 候选面 | 消费者与频率 | 需求依据 | 删除后果 | 现有替代 | 处置 | 关闭条件 |
|---|---|---|---|---|---|---|
| 两张新表与 schema 10 | Router 内部 | 需求 1、2 | 无处存 set | 无 | 保留 | 无 |
| `POST /dashboard/lane-sets` | 用户在页面建 / 挪 / 删，低频 | 需求 7 | 只能改库 | 无 | 保留 | 无 |
| `resumeInfo.laneSet` | 两条 CLI，每次开窗 | 需求 5 | open / rotate 开错窗口 | 无 | 保留 | 无 |
| 快照 `laneSets` | 页面，每次轮询 | 需求 6 | 页面不知道分组 | 无 | 保留 | 无 |
| state-store 六个方法 | Router 内部 | 需求 1–5 | 无 | 无 | 内部化 | 无 |
| set 重命名 | 无 | 无 | 删了重建、重新挪 | 删 + 建 | 推迟 | 无 |
| 整 set 一键打开 / 归档 | 无 | 需求稿明确不做 | 无 | 组头勾选已能一次选中整组 | 删除 | 无 |
| `lane_directory` 加 set 字段 | 无 | 无 | 无 | resume-info | 删除 | 无 |
| CLI 建 / 挪 set | 无 | 需求 7 说页面 | 无 | 页面 | 删除 | 无 |
| 已开窗口随 set 变化挪标签页 | 无 | 需求稿待讨论 | 无 | 关了重开 | 推迟 | 无 |

## 五、验收标准

每条都要有自动测试兜住。

1. **迁移。** 从 6 以来每种起点形态（含 v9）到 10 都建出两张表，不丢不改任何一行；10 再开一次 schema 原样不动；空库直接建到 10；set 步失败时前两步一起回滚，版本号不变。
2. **schema 约束。** 同一 lane 第二条成员行被拒；set 名唯一；成员指向不存在的 set 被拒；删 set 成员行随之消失；lane 行仍不可删。
3. **state-store。** 建 / 列 / 删 / 挪四个动作；再挪即换 set；重名拒绝；不在役的 lane 拒绝；归档后离开 set；`laneSetNameFor` 对在 set 里的 lane 给名字，对不在的给 `undefined`。
4. **RouterCore。** `resumeInfo` 的 `bound` 带 `laneSet`，在 set 里是名字，不在是 `null`；set 名含空格或非法字符被拒；与有在役 lane 的项目同名被拒；删非空 set 被拒；挪归档 lane 与不存在的 lane 被拒且拒绝语不同。
5. **快照。** `laneSets` 列出每个 set 的 id、名字和在役成员地址，空 set 也在，归档 lane 不在成员里；`dashboard-state.test.ts` 里「exactly the facts」的键集合更新为含 `laneSets`。
6. **HTTP。** `/dashboard/lane-sets` 四道守卫各缺一项都拒且不调用处理函数；未接线 404；三种 action 各到位，返回 `{ laneSets }`；`LANE_TOOL_NAMES` 不变。
7. **开窗。** 恢复、`open`、`rotate` 三处：lane 在 set 里时 `LANE_ROUTER_CHILD_WINDOW` 是 set 名，否则项目名；`open` 收到没有 `laneSet` 字段的 resume-info 时落回项目；`new` 仍是项目。
8. **页面。** 按 set 分组且跨项目 set 内 lane 带项目前缀；空 set 显示为一组；lane 行文本仍是「地址 · backend · 恢复状态 · model」（Codex 带 profile / provider，未绑定的写「未绑定」）；新建、移入、删除各发一次带 `x-lane-router-action: lane-sets` 和 token 的请求；没勾 lane 就点移入不发请求；快照没有 `laneSets` 时三处控件都不存在，且现有页面测试全部照过；轮询刷新保留新建框的文字和下拉选择。
9. **自包含。** 页面仍不引用任何外部资源。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`、`npm run build`。全绿加 build 通过才算完成。
- **不要重启、不要 kill 共享 Router**（pid 见 `~/.lane-router/discovery.json`）。用户有很多 lane 在跑。build 之后 `dist/dashboard.html` 会立刻被旧 Router 按请求读到，这正是验收第 8 条「没有 `laneSets` 时照今天的样子工作」要兜的情况；build 完在浏览器里打开一次 `/dashboard` 看页面没坏、能开 lane。
- 迁移彩排：参照 `docs/manual-tests.md` 里 2026-10-13 那次「在在用库的副本上彩排迁移」的做法，用 `dist/router/schema.js` 对 `~/.lane-router/router.sqlite` 的**只读复制**跑一遍 `initializeRouterSchema`，记录版本从 7 到 10、四张旧表行数与行指纹不变、两张新表为空、再开一次不变。在用库只读打开。结果写进 manual-tests。
- 变异检验（改坏一处看对应测试红不红，看完改回）：
  - 迁移里去掉 `lane_set_member` 的 PRIMARY KEY → 第 2 条应红；
  - `laneSetNameFor` 永远返回 `undefined` → 第 7 条三处应红；
  - 页面把 `data-set-control` 写成 `data-override` → 第 8 条「打开请求的 override 不含 set 字段」应红（给这条单独写一个断言）；
  - 守卫里漏掉 token 比对 → 第 6 条应红；
  - 快照成员不过滤归档 → 第 5 条应红。
- manual-tests 补一条 TC-SET-1（Router 重启后执行）：建一个 set，把两个项目的各一条 lane 挪进去，从看板打开两条，确认它们开在同一个名为 set 名的 Windows Terminal 窗口；再把其中一条移出，重开，确认回到项目窗口；`lane-router-lane open` 与 `lane-router-rotate` 各验一次窗口名。

## 七、边界

- 改了 set 之后，已经开着的窗口不挪；只影响之后开的。
- 虚拟机上的 lane 不由 Router 开窗口，set 对它只影响页面分组。
- 老 Router 在跑的期间：新页面能看、能开，看不到 set 控件；新 CLI 的 `open` 落回项目窗口；set 功能整体要等用户选定时机重启 Router 才生效。
