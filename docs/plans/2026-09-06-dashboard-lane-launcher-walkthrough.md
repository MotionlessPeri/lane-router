# Dashboard lane launcher walkthrough

**状态：** ephemeral review record；review 结束后可清理，不进代码注释。

## 范围

- HTTP：`LocalRouterServer` 的 dashboard state / open action / provider endpoint。
- 编排：`DashboardLaneOpener`、`ConversationRestorer.restore`。
- Codex 一次性启动：terminal environment、`launchCodex`、`CodexTuiBridge`、`CodexRuntime`、`RouterCore.attachCurrent`。
- 页面：`dashboard.html` 的选择、覆盖输入、结果渲染。
- 事实快照：`dashboardSnapshot` 的 `restorePresence` 与 startup 元数据。

## 结构 map

| 单元 | 职责 | 结论 |
|---|---|---|
| `DashboardLaneOpener.open` | 整批地址/绑定/backend 校验后逐条调用 restorer | key function；约 50 行，当前无需拆 |
| `LocalRouterServer.handle` | 既有 HTTP 汇入口，新增 dashboard open gate | key function；原本已超 50 行，本轮只加局部分支，不借机重构 |
| `ConversationRestorer.restore` | 组装一次性 terminal request 并保留恢复语义 | key function；原有长函数，本轮新增覆盖解析仍局部 |
| `dashboardSnapshot` | 输出页面选择所需的权威事实 | key function；约 50 行，形状测试锁住字段 |
| `dashboard.html renderLauncher` | 按项目渲染选择与覆盖输入 | key function；DOM-only，约 60 行，尚可读 |
| `CodexTuiBridge` / `CodexRuntime` | 传递 transient startup 元数据 | 跨进程边界；类型与 focused 测试锁住 |
| `RouterCore.attachCurrent` | transient attach 时沿用旧 binding startup | key function；原有长函数，新增语义有独立测试 |

## Self-review findings

| 档 | 发现 | 决策 |
|---|---|---|
| 🟢 | provider-only 覆盖没有 profile 时曾可能回落默认 endpoint；新增 `LANE_ROUTER_CODEX_MODEL_PROVIDER` 单独生效路径并有测试 | 已处理 |
| 🟢 | persistent 与 transient 同名 provider/profile 若共用 bridge 会误持久化；bridge cache key 已区分 | 已处理 |
| 🟢 | 混合 Claude/Codex 选择携带 provider/profile 必须整批拒绝，避免半批启动 | 已处理 |
| 🟢 | 网页 token 会在请求失败后保留 warn 样式；仅视觉残留，不影响行为 | 可选小修 |
| 🔴 | `LocalRouterServer.handle`、`RouterCore.attachCurrent`、dashboard 页面脚本继续变长 | 不在本次功能里重构；后续可单独拆入口 handler / UI 渲染模块 |

## 验证

- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm test`：36 files / 343 tests PASS。
- 隔离真实 Router：dashboard 页面加载、action token 发布、错 `Origin` 403、错 token 403、进程干净停止。
