# 合并远端 DSH / ZCode 与本地 tell

**背景：** `master` 在 `99dc497` 分叉。远端 16 个提交（2026-09-20 至 10-08，用户本人在另一台机器上）加了 DSH Host API 和 ZCode 后端（dashboard 开窗按钮在分叉前就有，不是这批带来的）；本地 4 个提交（2026-10-12）加了 `tell`，并给五个有副作用的 POST 入口加了网页守卫。两边功能互不重叠，不需要取舍；要设计的只有两处：数据库迁移的编号，以及守卫覆盖远端新入口的方式。两边都改过的文件有 11 个：`schema.ts`、`local-server.ts`、`state-store.ts`、`router-core.ts`、`mailbox-store.ts`、`main.ts`、`lane-launcher.ts`、`docs/manual-tests.md` 及三份测试。

## 结论

| 冲突点 | 裁决 | 理由 |
|---|---|---|
| 两边都占用了 schema v7 | 远端编号不动（7 = DSH，8 = ZCode），`tell` 的 `sender_label` 改为 v9 | 远端编号可能已经落在用户另一台机器的库里；本地 v7 只在本机这一个库里 |
| `user_version = 7` 有两种含义 | 迁移按**表结构**判断每一步做没做，不按版本号 | 本机在用的库就是「tell 的 v7」。只改编号的话，合并后的 Router 会把它读成「DSH 已做」，跳过 binding 重建，再在已存在的 `sender_label` 列上重复迁移而失败 |
| `/zcode/spawn` 没有任何守卫 | 加 `refuseWebPage`，放在 `readJson` 之前 | 配置了 `zcode.driver` 时会起进程，且任何网页都能指定 `cwd` 和 `intro`（即交给 agent 的第一条指令）；属于已定稿规则「所有有副作用的入口」的覆盖范围，不是新决定 |
| `/dashboard/lanes/open` | **不**套 `refuseWebPage`，保留它自带的守卫 | 按钮由 Router 自己的页面从浏览器发出，必然带 `Origin`，通用守卫会把它 403 掉。它自带的守卫更严：`Origin` 必须等于 Router 自己的 URL，并要求 `x-lane-router-action` 头和 JSON 正文 |
| `/dsh/v1/*`（含 WebSocket `/dsh/v1/channel`） | 不套通用守卫 | 要求 `Authorization: Bearer <token>`：网页设这个头必须先过预检，而 Router 不回 CORS 头，且网页拿不到 token |

## 迁移设计

阶梯：6 → 7（binding 的 `backend` 允许 `dsh`）→ 8（允许 `zcode`）→ 9（`message` / `message_archive` 加 `sender_label`）。`ROUTER_SCHEMA_VERSION = 9`。

三处表结构的判断依据：

- binding 已允许 `dsh` 或 `zcode`：读 `sqlite_master` 里 `binding` 的建表语句，看 `CHECK` 是否含这两个值。只要不含 `zcode`，就直接用 v8 的表定义重建一次，`dsh` 随之补上。
- `sender_label` 已加：`PRAGMA table_info(message)` 里有这一列。

`user_version` 不小于 6 的库：缺哪一步补哪一步，全部补齐后置 9。现有迁移函数在内部各自写 `user_version`，改造时要让「置版本」只发生在最后一步。小于 6 的库照旧走原阶梯，到 6 之后进入同一套判断。

库可能处于的起点（全部要有测试）：

| 起点 | 在哪 | 期望 |
|---|---|---|
| v6 | 两边的旧库 | 三步全做 |
| v7（DSH） | 用户另一台机器，若只升到远端的 v7 | 补 ZCode、`sender_label` |
| v8（ZCode） | 用户另一台机器，若升到远端的 v8 | 只补 `sender_label` |
| v7（tell） | **本机在用的库** | 只重建 binding（补 `dsh` / `zcode`），不碰 `message` |
| v9 | 迁移完成后 | 不做任何事 |

每种起点都断言：binding 的 `CHECK` 含 `zcode`；`message` 和 `message_archive` 都有 `sender_label`，且 `CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL))` 仍在；各表行数不变。

部署前用本机在用库的**副本**预演一次（先拷贝 `~/.lane-router/router.sqlite` 到临时目录再迁移），对比 lane / binding / message / message_archive 四张表的行数。参照：2026-10-12 迁移前为 73 / 137 / 10837 / 3048。

## 合并时逐个核对

按 `code-review` 里「合并提交单独审」的要求，两边都改过的文件逐个看结构，不只看文本有没有冲突：

- `local-server.ts`：本地的守卫和远端的新路由合并后，逐个列出所有 POST 和 WebSocket 入口，各自写明由哪种守卫覆盖；漏一个就不算合并完成。
- `lane-launcher.ts`：远端把新建 lane 统一到了 `lane new --backend`。`tell` 如果有新建或开窗的路径，要改走这个统一入口，不留第二条路径。
- `router-core.ts` / `state-store.ts`：`tell` 判断目标状态（online / offline / unbound / archived / missing）时，要能正确识别 `zcode` 和 `dsh` 后端的 lane；读 `sender_label` 的 `LEFT JOIN` 不受新后端影响。
- `docs/manual-tests.md`：两边新增的段落都保留。

## 提交序列

授权范围（用户 2026-10-13 认可）：本地合并、测试、提交按下列顺序做；push 与本机 Router 重启都另等用户发话。

0. 合并前工作区必须干净。截至 `8df2273`，`docs/manual-tests.md` 里还有一段未提交的 TC-TELL 真机结果（「最后验证：2026-10-12 用户受控重启……」），不是 design 写的。写它的 lane 先核对内容并提交，再开始合并。
1. `merge origin/master`：解决文本冲突，并在合并提交里完成 v9 编号和按结构判断的迁移（不做这一步，两边各自的 v7 无法同时成立，合并提交就是红的）。全量测试和类型检查通过。
2. `fix: keep web pages out of the zcode spawn entry`：给 `/zcode/spawn` 加 `refuseWebPage`，附测试：带 `Origin` 的请求返回 403，非 JSON 正文返回 400，现有 CLI 调用照常成功。
3. `docs`：impl 在 `manual-tests.md` 补迁移预演的记录；design 在 `tell` 规格 §3.4 补上合并后的入口清单和各自的守卫方式（规格归 design）。
4. push `origin master`：等用户明确说推送。

本机 Router 重启时会把在用库从 v7（tell）迁到 v9，重启时机由用户决定，重启前先备份。
