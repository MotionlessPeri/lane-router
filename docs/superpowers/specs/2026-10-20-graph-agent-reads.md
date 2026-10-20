# 图工具：分层读取与写操作只返回摘要 设计

**状态：** 2026-10-20 用户已确认（问答话题三 `401afd46`，原话「确认，你做吧」），待实施。范围同日由用户确认「都做」：写操作只返回摘要、提纲读取、按节点读邻域。

**一句话结论：** agent 改一次图，现在要拿到 4 份整图（读、获锁、apply、释放各一份），样本图一份约 2.6 万字符。本设计让 apply 和释放锁只返回摘要，并给 `lane_graph_read` 加两种更小的读法：只看结构和摘要的提纲，以及指定节点加一跳邻居。存储、锁、批量修改规则和查看网页都不变。

## 术语表

| 术语 | 含义 |
|---|---|
| 提纲 | 图的骨架：节点的 ID、标题、类型、标签、分组、摘要；边的两端和类型；分组层级。不含节点详细说明、来源和边说明。 |
| 邻域 | 指定节点的全部字段，加上与它们直接相连的边（全部字段），以及这些边另一端节点的提纲字段。只走一跳。 |
| 写摘要 | 写操作的返回：保存结果、锁状态、计数和查看地址，不含图文档。 |

## 一、问题

### 1.1 每次写都附带整张图，偏离已批准的设计

`src/modules/graphs/service.ts` 的 `write()` 提交后调用 `this.read()`，把整份文档并进返回值。create、获锁、apply、释放锁四个写操作都走它。而[图资源设计稿](2026-10-18-graph-resource-design.md)第 6 节写的是 apply 返回「保存后的图摘要和查看地址」，释放锁也没有要求返回文档。

mayacustomnodes/research-lead 用样本图 `9ec0d162-e49e-4594-943e-082b50730600`（51 个节点、52 条边、7 个分组）试用时发现，一轮「读 → 获锁 → 改 → 释放」要拿到 4 份整图。2026-10-20 经只读 API 实测，这张图的整份 JSON 约 2.6 万字符。

### 1.2 只能整图读取

`lane_graph_read` 带 `graphId` 时只返回整份文档；设计稿第 6 节当时写明「首版采用完整读取，如后续实际规模需要局部查询，再按具体场景设计」。

同一张样本图的实测（2026-10-20）：标签、摘要、说明这类内容文字约 1.4 万字符，其余是 ID、字段名和引用结构；只保留提纲字段时约 1.26 万字符；节点平均连 2.3 条边，最多 11 条。agent 关心某个节点时，相关部分只占全图很小一块。

### 1.3 已定下的边界（问答话题一、二、三，2026-10-20）

- 图主要给用户看。agent「找东西」的能力（搜索、按类型筛选、沿边多跳遍历、跨图查询）归知识库设计（lane-router/kb），图这边不做。
- 不引入图数据库。存储维持 `graphs.sqlite`：一张图一行，整份文档存为一段 JSON。
- 给 agent 的只做固定的简单读取，不引入查询语言。

## 二、范围基线

**用户要的结果：** agent 读图、改图时，不必每次都付整张图的代价。

**当前用户流程：** agent 用 `lane_graph_read` 拿整图来了解内容；改图时 `lane_graph_lock` 获锁（返回整图），`lane_graph_apply` 修改（返回整图），释放锁（返回整图）。

**信任模型：** 同机可信个人环境，不变。

**满足该流程的最小可观测行为：** apply 和释放锁不再返回文档；agent 能只读提纲，或只读指定节点及其一跳邻居；不给新参数时，读取行为与现在逐字相同。

这条基线**不包含**：搜索、按类型或标签筛选、多跳遍历、路径查询、跨图查询、查询语言、存储改动、锁规则改动、网页改动。

## 三、设计

### 3.1 写操作的返回

| 操作 | 现在 | 改后 |
|---|---|---|
| `lane_graph_create` | 整份文档 + 锁 + 操作元数据 | 不变。新图是空文档；设计稿第 3 节要求重放时读取当前文档 |
| `lane_graph_lock` 获锁 | 同上 | 不变。设计稿第 4 节第 2 条：拿到锁即读到最新内容 |
| `lane_graph_lock` 释放 | 同上 | 写摘要 |
| `lane_graph_apply` | 同上 | 写摘要 |

写摘要的字段：

- `graphId`，以及 `lockId`（apply 与释放时均为请求中的锁 ID）。
- apply 带 `saved`、`savedAt`；释放带 `released`。语义与现在相同。
- `replayed`、`lockValid`：语义与现在相同。
- `lock`：当前锁状态，字段与读取结果中的 `lock` 相同。
- `updatedAt`：图当前的更新时间。
- `counts`：`{ nodes, edges, groups }`，当前已提交文档的计数。
- `viewPath`：工具适配层照旧补 `viewUrl`。

写摘要**不含** `document`，也不回显本次改动了哪些 ID，因为调用方自己的请求里就有；结果未知时用同一份请求重试即可。

同一 `operationKey` 重放时，返回同样形状的写摘要，`counts`、`lock`、`updatedAt` 取当前事实，与现在「重放时读取当前状态」的规则一致。

### 3.2 `lane_graph_read` 的三种读法

参数组合如下。发布时由现有的平表 schema 规则（`src/application/flat-root-schema.ts`）生成「Argument combinations」说明，不另写。

1. `graphId`；可选 `view`：`"full"`（默认）或 `"outline"`。
2. `graphId`、`nodeIds`（非空字符串数组）。
3. 可选 `query`、`afterId`、`limit`：列出图，行为不变。

`view` 与 `nodeIds` 不能同时出现：两者分属不同的严格（strict）分支，同时给出时校验失败。

**全文（`view` 省略或为 `"full"`）**：返回值与现在逐字相同，已有调用方不受影响。

**提纲（`view: "outline"`）** 返回：

- `view: "outline"`，让读者一眼分清这不是全文。
- `graphId`、`title`、`description`、`updatedAt`、`lock`、`viewPath`、`counts`。图说明里可以写「agent 怎么读这张图」，所以保留。
- `nodes`：每个节点只含 `id`、`label`、`kind`、`tags`、`groupId`、`summary`，原文没有的字段不出现。
- `edges`：每条只含 `id`、`source`、`target`、`type`。
- `groups`：每个只含 `id`、`label`、`parentId`、`summary`。
- 不含节点的 `description`、`sources`，边的 `description`，分组的 `description`、`color`。

**邻域（给 `nodeIds`）** 返回：

- `view: "neighborhood"`。
- `graphId`、`title`、`updatedAt`、`lock`、`viewPath`。
- `nodes`：所请求节点，字段与全文中相同。
- `edges`：至少一端是所请求节点的边，字段与全文中相同。
- `neighbors`：这些边另一端、且不在请求集合里的节点，只含提纲字段。
- `groups`：所请求节点和邻居节点所在的分组及其全部祖先，只含提纲字段。

邻域读取规则：

- 只走一跳，不提供深度参数。
- `nodeIds` 去重后处理。
- 任一 ID 在图中不存在时，整次请求失败，返回错误码 `NODE_NOT_FOUND`，`details` 列出缺失的 ID，不返回部分结果。

三种读法读的都是同一次已提交的文档：先取当前文档，再从中投影，不出现半批修改。

### 3.3 不变的部分

- 查看网页的 `GET /graphs/api/:graphId` 仍返回全文，与工具的读法无关。
- 存储（表结构、`document_json`）、锁规则、批量修改与校验、操作键去重都不变。
- 工具仍是四项，名称不变。旧 Codex 会话的 JSON 文件 CLI（`lane-router-lane graph read --json-file`）复用同一份 schema，新参数随之可用。
- 工具说明更新三处：
  - `lane_graph_read`：说明三种读法，并建议先读提纲，再按需读邻域或全文。
  - `lane_graph_apply`：说明返回写摘要，要看内容就再读。
  - `lane_graph_lock`：说明释放锁时返回写摘要。

## 四、范围审计

新增或扩大的产品面：公开接口 2 项（`lane_graph_read` 的两个可选参数、一个新错误码），返回形状变化 2 处（apply、释放）。**没有**新增工具、进程、数据表、HTTP 端点、存储字段、锁规则或信任边界。

| 候选面 | 消费者与频率 | 需求依据 | 删除后果 | 已有替代 | 处置 |
|---|---|---|---|---|---|
| apply、释放只返回写摘要 | 每次改图 | 设计稿第 6 节已批准；用户确认第 1 项直接修 | 每轮多付 2 份整图 | 无 | Keep |
| 提纲读取 `view: "outline"` | agent 了解一张图 | 用户确认「都做」 | 只能整图读 | 全文读取 | Keep |
| 邻域读取 `nodeIds` | agent 关注少数节点 | 用户确认「都做」 | 读一个点也要整图 | 全文读取 | Keep |
| 错误码 `NODE_NOT_FOUND` | 邻域读取给错 ID 时 | 邻域读取的失败面 | 只能返回部分结果或含糊的参数错误 | `INVALID_ARGUMENT` | Keep |
| 写摘要回显改动的 ID | — | research-lead 建议；用户未提 | 无，调用方持有原请求 | 原请求 | Delete |
| 按 `kind` / `tags` 筛选、关键词搜索 | — | 话题一结论：归知识库 | 无当前图流程失败 | 提纲后由 agent 自己挑 | Delete |
| 多跳遍历、深度参数、路径查询 | — | 话题一、二结论：归知识库 | 无 | 多次邻域读取 | Delete |
| 默认读法改为提纲 | — | 无；会改变已有调用方的结果 | 无 | 工具说明建议先读提纲 | Delete |
| create、获锁也只返回摘要 | — | 与设计稿第 3、4 节「获锁即读最新」冲突 | 获锁后还得再读一次 | 无 | Delete |

## 五、验收标准

1. `lane_graph_apply` 成功、重放、锁失效后重放，三种情况的返回都不含 `document`，且含 `graphId`、`lockId`、`saved`、`savedAt`、`replayed`、`lockValid`、`lock`、`updatedAt`、`counts`、`viewPath`；经工具适配层后另含 `viewUrl`。
2. `lane_graph_lock` 释放成功与重放的返回都不含 `document`，含 `released`、`replayed`、`lockValid`、`lock`、`updatedAt`、`counts`、`viewPath`。
3. `lane_graph_create` 与获锁的返回仍含当前 `document`，现有的重放断言（重放创建返回当前文档）保持通过。
4. `counts` 等于当前已提交文档的节点、边、分组数，重放时取当前值而不是原操作时的值。
5. `lane_graph_read` 只给 `graphId`，以及给 `graphId` 加 `view: "full"` 时，返回值与本设计之前逐字相同。
6. 提纲读取的返回含 `view: "outline"`，节点、边、分组只含 3.2 节列出的字段；用一个各字段都填满的 fixture，断言节点 `description`、`sources`，边 `description`，分组 `description`、`color` 都不出现。
7. 邻域读取的返回含 `view: "neighborhood"`；`nodes` 恰为所请求节点（去重后）且字段完整；`edges` 恰为至少一端在请求集合里的边；`neighbors` 恰为这些边的另一端减去请求集合，只含提纲字段；`groups` 恰为这些节点所在分组及其全部祖先。
8. 邻域读取中任一 ID 不存在时抛 `NODE_NOT_FOUND`，`details` 列出全部缺失 ID，不返回部分结果。
9. 同时给 `view` 和 `nodeIds`、给空的 `nodeIds`、给未知字段时，参数校验失败。
10. 发布给 MCP 与 Codex 的 `lane_graph_read` schema 是平表根，含 `view`（枚举 `full`、`outline`）与 `nodeIds`，说明里列出三种参数组合；工具总数仍为四项。
11. `lane-router-lane graph read --json-file` 接受 `view` 与 `nodeIds`，结果与工具调用相同。
12. `GET /graphs/api/:graphId` 的返回不变；不新增 HTTP 端点、数据表或存储字段。

## 六、验证方法

自动测试覆盖第 1–12 条，放在现有的 `tests/graph-service.test.ts`、`tests/graph-adapters.test.ts`，必要时加纯函数测试（例如提纲与邻域投影）：

- **写摘要**：对 apply 和释放各断言「无 `document` 键」和完整字段集；断言 create 与获锁仍带 `document`。**这是本设计的牙**：只断言「有 `counts`」的话，实施成「在整图上再加一个 `counts`」也会通过。
- **全文不变**：对同一 fixture，分别用只给 `graphId` 和 `view: "full"` 读取，与改动前 `read()` 的结果做深度相等比较。
- **提纲**：fixture 的每个节点、边、分组都填满全部可选字段，断言每个对象的键集合恰好等于允许集合（用键集合相等，不用「包含」）。
- **邻域**：用带跨组边、自身分组嵌套三层的 fixture，取一个有多条入边和出边的节点，断言四个集合各自恰好相等（不多也不少）；再取两个相邻节点，断言它们之间的边只出现一次、彼此不出现在 `neighbors` 里。
- **错误**：一个存在、一个不存在的 ID → `NODE_NOT_FOUND`，`details` 只列不存在的那个。
- **schema**：断言平表根的 `properties` 含 `view` 与 `nodeIds`，combinations 文本有三行。

**变异检验**（三态：变异前绿、变异后红、还原后绿，且每个变异只杀对应的那一条）：

- 写摘要里保留 `document`；
- 提纲漏删节点 `description`；
- 邻域只收出边、不收入边；
- 邻域把请求节点本身也放进 `neighbors`；
- 分组祖先只取直接父级；
- 不存在的 ID 被静默跳过；
- 重放时 `counts` 用原操作时的值。

自动测试**覆盖不到**、须写进 `docs/manual-tests.md` 的「图资源：lane 更新，网页查看」：

| 用例 | 为什么机器测不了 | 怎么做 |
|---|---|---|
| 真实 lane 用到新读法 | 需要真实模型客户端，并在部署后刷新工具清单 | 共享 Router 部署后，在一条真实 lane 里对样本图依次调用提纲读取、对一个节点做邻域读取、获锁、apply、释放，记录每次返回的字符数；apply 与释放的返回里不应出现节点说明 |
| 旧会话仍可用 | 需要部署前就开着的会话 | 部署前已开的 Claude 或 Codex lane，只给 `graphId` 读取，结果与部署前相同 |

共享 Router 的部署与重启交外部维护对话，不由实施 lane 或本 lane 执行。

## 七、明确不做

- 不做搜索、按类型或标签筛选、多跳遍历、路径查询、跨图查询，不引入查询语言；这些归知识库设计。
- 不改存储、锁规则、批量修改规则和操作键语义，不引入图数据库。
- 不改 create 与获锁的返回，不改默认读法。
- 不改查看网页及其 HTTP 接口。
- 不新增工具、HTTP 端点、数据表或存储字段。
