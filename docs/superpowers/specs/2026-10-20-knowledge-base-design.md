# 知识库技术设计

**状态：** 2026-10-20 技术设计稿，由 `lane-router/kb` 起草。需求依据见 [知识库需求](2026-10-20-knowledge-base-requirements.md)（R1–R4）。

**实施依据**：kb 在问答议题 `a8d8110d` 里问「设计稿可以交给实施吗」，用户先叫停了默认交给 `lane-router/impl`，接着回复「你先开一个自己的impl lane呗，不要阻塞」。据此由新开的 `lane-router/kb-impl` 实施。用户没有逐节审过本稿。

**存储**：第二节第一行的取舍（SQLite，不放成文件进 git），用户没有明确表态。按本稿推荐开工，问答里已告知用户随时可以改；用户改了就停工重议。

第五节是完成判据，第六节是验证方法与变异检验。本稿不授权部署或重启共享 Router。

## 术语表

| 词 | 含义 |
|---|---|
| 页 | wiki 里的一个主题。有标题、一句话摘要和 Markdown 正文 |
| 目录 | 全部页的标题加摘要，供 agent 按意思判断哪页相关 |
| 检查 | 录入前必须先做的一次检索。结果带一个 `checkId`，写入时要出示它 |
| 取代 | 旧页标为「已被取代」并指向新页。旧页保留、可读，检索时带标记 |

## 一、问题与结论

需求要一个单独的 LLM wiki，配一个检索工具、一个录入工具，录入时先检索、由写的人决定怎么处理、保留旧版本，而且这几步要由程序保证。

结论：
- **形态**：照图资源的做法，做成 Router 同进程里的独立模块 `src/modules/knowledge/`，独占 `dataRoot/knowledge.sqlite`。
- **两个工具**：`lane_kb_search` 和 `lane_kb_record`。
- **先检索后写**：`lane_kb_record` 分「检查」和「提交」两步，提交必须出示本 lane 一次未用过的检查。录入工具是写 wiki 的唯一入口，程序因此能保证先检索后写。
- **语义判断**：交给调用工具的 agent。检索返回关键词命中，wiki 不大时同时返回整份目录，由 agent 按意思判断。第一版不引入向量检索。
- **并发写**：同一页的并发写入用版本号判断，不加锁。
- **查看**：给用户一个只读查看页。

## 二、选型

| 问题 | 采用 | 不采用及原因 |
|---|---|---|
| 页存在哪 | 模块独占的 SQLite（`knowledge.sqlite`），正文是 Markdown 文本 | **放成文件进 git**：agent 能绕过录入工具直接改文件，「先检索后写」就要靠守门来保，而守门已从第一版撤下；保留版本要 Router 代为提交 git，是本项目没有的新行为；文件被外部改动后，检索索引还要另行同步。代价是用户不能拿编辑器直接打开，所以配只读查看页（3.5） |
| 怎么判断「相似」 | 关键词命中加整份目录，由调用的 agent 按意思判断 | **向量检索**：要嵌入模型。远程服务违反「公司内容不出本地」，本地模型是新的重依赖。LLM wiki 原文的做法本来就是让 LLM 读目录找相关页。规模变大、目录装不进一次返回时再考虑 |
| 关键词怎么匹配 | FTS5 `trigram` 分词；不足 3 个字符的词改用 `LIKE` | **默认分词**：不切中文。已实测：本仓 `better-sqlite3` 带的 SQLite 3.53.4 开着 FTS5，`trigram` 下「拒收 cc」能命中，「拒收」「群发」这类两个字的词 `MATCH` 查不到，`LIKE '%cc%'` 能查到 |
| 怎么保证先检索 | 两步：检查返回 `checkId`，提交必须出示本 lane 未用过的 `checkId` | **只写进工具说明**：就是靠自觉，需求 R3 明确不要 |
| 并发写同一页 | 提交时带上读到的版本号（`baseVersion`），与当前版本不符就拒绝，重读再来 | **图那样的长写锁**：用户说没有大规模同时写入的需求；长锁要配强制解锁，是图那边为长时间编辑付的代价，这里用不着 |
| 旧版本 | 每次提交写一行版本记录，可按版本号读 | **只靠「取代」标记**：页内修改之后，旧文就找不回来了 |
| 要不要抽通用资源平台 | 不抽 | 两个样本（图、知识库）共有的只是独立库文件、`operationKey` 去重、`LaneAccess` 身份和查看路径，每样几十行；锁和版本做法不同，抽出来的接口没有第三个用户来验证。继续照图资源需求第 5 节的口径 |

## 三、设计

### 3.1 数据与存储

模块独占 `dataRoot/knowledge.sqlite`，沿用 `better-sqlite3` 和项目现有的 SQLite 约定（WAL、备份、迁移），不碰 `router.sqlite`、`issues.sqlite`、`graphs.sqlite`。

| 表 | 内容与约束 |
|---|---|
| `kb_page` | `id`、`title`、`titleKey`（标题规范化后的唯一键）、`summary`、`body`、`status`（`active` 或 `superseded`）、`supersededBy`、`version`、`createdAt`、`updatedAt`。没有 owner lane 字段 |
| `kb_page_version` | `pageId`、`version`，以及该版本的 `title`、`summary`、`body`、`status`、`supersededBy`；另记 `action`（`create`、`update`、`supersede`）、写入者稳定 `laneId`、`checkId`、`createdAt`。主键是 (`pageId`, `version`) |
| `kb_check` | `checkId`、`laneId`、`createdAt`、`consumedAt`，以及当时返回的候选页及其版本号 |
| `kb_operation` | 调用方 `laneId`、`operationKey`、操作种类、请求摘要、结果；照图模块的去重规则 |
| `kb_fts` | FTS5 虚表，`tokenize='trigram'`，收 `title`、`summary`、`body`，与 `kb_page` 在同一事务里维护 |
| `kb_schema_version` | 模块自己的迁移版本 |

页模型的约束：
- **标题唯一**：规范化为去首尾空白、合并连续空白、转小写后唯一。新建时撞标题就拒绝（`TITLE_EXISTS`），提示改走「改原页」。这是「一个主题一页」的最小保证。
- **摘要必填**：一行，不超过 200 字符。它是目录的内容，agent 靠它按意思判断。
- **正文**：Markdown 文本，沿用现有 1 MiB 请求上限，不另设容量配置。正文按文本保存和显示，不作为指令执行。

打开失败或格式不认识时不覆盖、不重建，知识库入口返回 `KB_UNAVAILABLE`，通信、问答、图照常工作。

### 3.2 检索：`lane_kb_search`

三种读法：

| 参数 | 返回 |
|---|---|
| `query`，可选 `terms`、`includeSuperseded` | 命中的页，每条带 `pageId`、`title`、`summary`、`status`、`supersededBy`、命中片段、`version`、`updatedAt`，按相关度排序，默认 20 条、最多 100 条 |
| `pageId`，可选 `version` | 该页完整内容、当前版本号、状态与取代指向、版本列表（版本号、时间、写入 lane 地址、动作）；带 `version` 时返回那个旧版本 |
| 不带参数，可选 `afterId`、`limit` | 目录：全部页的 `pageId`、`title`、`summary`、`status`，按标题排序分页，默认 200 条、最多 500 条 |

匹配规则：
- `query` 和每个 `terms` 分别匹配。长度不小于 3 个字符的用 FTS5 `MATCH`；更短的（如 `cc`、「拒收」）用 `LIKE` 在标题、摘要、正文里找。命中合并后按命中次数和标题命中优先排序。
- 默认不列已被取代的页；`includeSuperseded: true` 时列出并带标记。
- 工具说明写明：命中只是关键词，判断是否相关要看摘要；命中少或拿不准时读目录。

所有读法都返回该页或目录在只读查看页上的路径。

### 3.3 录入：`lane_kb_record`

两步，用 `step` 区分。

**第一步 `step: "check"`**：参数是要录入的知识，包括 `title`、`summary`、`body`，以及写的人认为相关的 `terms`（如 `cc`、`lane_send`）。

程序这样检索：用 `title`、`summary` 和每个 `terms` 按 3.2 的规则检索，合并成候选页（含已被取代的，带标记），最多 50 条。活跃页不超过 300 页时，同时附上整份目录；超过时附 `indexTruncated: true`，提示 agent 另读目录。

返回 `checkId`、候选页（含 `pageId`、`version`、`title`、`summary`、`status`、命中片段）、目录或截断标记，以及一句提示：「逐条看候选页和目录，决定改原页、取代、新建，或者不写」。

检查记录绑定当前 lane 的稳定 ID，不过期。不写就不用调第二步，留下的检查无害。

**第二步 `step: "commit"`**：参数是 `checkId`、`operationKey`，以及写的人选定的 `decision`，三选一：

| `decision.kind` | 其余参数 | 效果 |
|---|---|---|
| `update` | `pageId`、`baseVersion`、`title`（可选）、`summary`、`body` | 改原页，版本号加一。页内标「旧段已被取代」也走这里，由写的人在正文里写明 |
| `supersede` | `pageId`、`baseVersion`、`newPage: { title, summary, body }` | 新建一页，旧页标为 `superseded` 并指向新页；两页各写一条版本记录 |
| `create` | `title`、`summary`、`body` | 新建一页，版本 1 |

规则：
1. `checkId` 必须属于当前调用 lane 且未用过，否则 `CHECK_REQUIRED`。提交成功后这次检查标为已用：一次检查只换一次写入。
2. `update`、`supersede` 时，`baseVersion` 必须等于该页当前版本，否则 `PAGE_CHANGED`，返回当前版本号，agent 重读后重新检查。
3. 已被取代的页不能 `update` 或再被 `supersede`，返回 `PAGE_SUPERSEDED` 和取代它的页，引导去改新页。
4. `create` 和 `supersede` 的新页撞标题时返回 `TITLE_EXISTS` 和那一页。
5. 写页、写版本记录、维护 `kb_fts`、标检查已用、记 `operationKey`，都在同一个短事务里。任何一步失败整体回滚。
6. `operationKey` 照图模块：同键同内容返回原结果并标 `replayed`，同键异内容返回 `OPERATION_CONFLICT`。只有成功的提交占用键。

调用身份照图模块：由宿主通过 `LaneAccess` 解析当前有效绑定，参数里没有可自填的 lane、binding 或 generation。

### 3.4 旧 Codex 会话

照图和问答：
```
lane-router-lane kb <search|record> --json-file <path>
```
身份来自 `CODEX_THREAD_ID`，复用同一份 schema 和服务调用。受限的 DSH / Native Host 工具白名单不在本轮修改。

### 3.5 只读查看页

| 路径 | 行为 |
|---|---|
| `GET /knowledge` | 目录页：标题、摘要、状态、更新时间；可按关键词筛选（调用同一检索服务） |
| `GET /knowledge/:pageId` | 单页：正文、状态与取代指向、版本列表；可点开旧版本 |
| `GET /knowledge/api/...` | 上面两页读取的 JSON，`Cache-Control: no-store` |

规则：
- **只读**：没有编辑、删除、写入接口。
- **不引入 React**：用纯 HTML，与问答页同一种做法。正文按问答页显示 lane 正文的同一套安全 Markdown 显示方式，不执行脚本，不解释为 HTML。
- **链接**：工具返回相对查看路径，由工具适配器拼当前 Router origin，与图一样。

### 3.6 代码落点

| 位置 | 内容 |
|---|---|
| `src/modules/knowledge/` | `schema.ts`、`store.ts`、`service.ts`、`tool-schema.ts`、`tools.ts`、`http.ts`、`cli.ts`、`types.ts`、`index.ts`（`openKnowledge(path, lanes)`），结构与 `src/modules/graphs/` 对齐 |
| `src/ui/knowledge/index.html` | 只读查看页 |
| `src/application/builtin-tools.ts` | 显式组合两项知识库工具 |
| `src/process/main.ts` | 在打开图模块的同一位置打开 `knowledge.sqlite`；失败只让知识库入口不可用 |
| `src/process/local-server.ts` | 挂查看页与只读 API |
| `src/process/lane-launcher.ts` | `kb` 子命令 |

依赖方向：知识库服务只依赖自己的存储和 `LaneAccess`；core 不导入知识库模块；查看页不导入存储。

### 3.7 错误

| 情况 | 结果 |
|---|---|
| 页不存在 | `PAGE_NOT_FOUND` |
| 提交没有出示有效检查（不存在、属于别的 lane、已用过） | `CHECK_REQUIRED`，什么都不写 |
| 页在检查之后被别人改过 | `PAGE_CHANGED`，带当前版本号，什么都不写 |
| 改或取代一个已被取代的页 | `PAGE_SUPERSEDED`，带取代它的页 |
| 新页标题与已有页撞 | `TITLE_EXISTS`，带那一页 |
| `operationKey` 同键异内容 | `OPERATION_CONFLICT` |
| 参数不合 schema | `INVALID_ARGUMENT` |
| 知识库打不开 | `KB_UNAVAILABLE`；不清空库，其他模块不受影响 |
| 保存成功但工具结果丢失 | 用同一 `operationKey` 重试，取回原结果，不重复写 |

## 四、范围审计

基线是需求稿 R1–R4。

| 候选 | 消费者与频率 | 需求依据 | 删除后果 | 处置 |
|---|---|---|---|---|
| 独立模块与 `knowledge.sqlite` | lane，每次读写 | R1 | 无处存放 | 保留 |
| `lane_kb_search` 三种读法 | lane，频繁 | R2；读单页和目录是检索的一部分 | 无法找页、读页 | 保留 |
| `lane_kb_record` 两步与 `checkId` | lane，每次录入 | R3「程序保证先检索」 | 先检索退回靠自觉 | 保留 |
| `baseVersion` 并发判断 | 罕见的同页并发 | 需求稿第 5 节「基本的并发安全」 | 后写的静默覆盖先写的 | 保留，替代长锁 |
| 版本记录与按版本读 | 偶尔回看 | R3 第 4 步「旧版本保留可查」 | 页内修改后旧文丢失 | 保留；不做回滚工具（要回滚就用旧版本内容再 `update`） |
| 取代状态与指向 | 录入时选「取代」 | R3 第 3 步 | 新旧两页并存、无法分辨 | 保留 |
| 标题唯一 | 每次新建 | R1「一个主题一页」 | 同一主题重复建页 | 保留 |
| 只读查看页 | 用户，低频 | 需求稿第 5 节留给设计；选了 SQLite 存储的代价 | 用户只能通过 lane 看 wiki | 保留；用户认为不要可砍，不影响其他部分 |
| 旧 Codex CLI | 已开的旧 Codex 会话 | 与图、问答一致，让已有 lane 能用 | 旧 Codex 会话用不了知识库 | 保留；复用现有命令模式 |
| 向量检索、导入现有内容、守门、负责人通知、跨仓总览、自动删改、长写锁、强制解锁、回滚工具、通用资源平台 | 第一版无消费者 | 需求稿第 3 节已排除，或本稿选型否决 | 不影响第一版流程 | 不做 |

## 五、验收标准

每条都要有自动测试兜住：

1. 从空库开始，`lane_kb_record` 走完 `check` → `commit(create)`，新页出现在 `lane_kb_search` 的目录里，版本为 1。
2. 不带 `checkId`、带别的 lane 的 `checkId`、带已用过的 `checkId` 提交，都返回 `CHECK_REQUIRED`，库内容不变。
3. 已有标题「lane_send 群发」、正文含「Router 拒收 cc」的页时，用 `title: "cc 字段已可用"`、`terms: ["cc"]` 做检查，候选页里有那一页（两个字符的 `cc` 走 `LIKE`）。
4. 用两个字的中文词做 `terms`（如「拒收」），候选里能命中正文含该词的页。
5. 活跃页不超过 300 页时，检查结果附整份目录；超过时附 `indexTruncated: true`，不附目录。
6. `commit(update)` 后版本加一；按旧版本号读取，返回改之前的正文。
7. 两条 lane 先后基于同一 `baseVersion` 提交 `update`：先到的成功，后到的返回 `PAGE_CHANGED` 和当前版本号，页内容是先到的那份。
8. `commit(supersede)` 后旧页状态为 `superseded` 并指向新页；默认检索不列旧页，`includeSuperseded: true` 时列出并带标记；对旧页再 `update` 返回 `PAGE_SUPERSEDED`。
9. 新建与已有页标题仅大小写或空白不同，返回 `TITLE_EXISTS`。
10. 同一 `operationKey` 同内容重试返回原结果并标 `replayed`，库里不多出版本；同键异内容返回 `OPERATION_CONFLICT`。
11. 提交中途出错（例如在测试里让版本记录写入抛错），页、版本、FTS 索引和检查状态全部回滚。
12. 知识库库文件损坏时，知识库工具返回 `KB_UNAVAILABLE`，五项通信工具、问答和图工具照常。
13. 只读查看页能看到目录、单页和旧版本；没有任何写接口（对写方法和未知路径返回 404 或 405）。
14. 旧 Codex CLI 用 `--json-file` 完成一次检查和提交，与工具调用结果一致。
15. 依赖方向：core 不导入 `src/modules/knowledge/`，知识库服务不导入 UI 或 HTTP。

## 六、验证方法与变异检验

**验证**：用临时库和隔离 Router fixture 测业务；查看页用真实浏览器看一遍目录、单页和旧版本；真实客户端里至少一条普通 lane 完成一次检查、提交、检索。共享 Router 的部署和重启交外部维护对话，不由实施 lane 执行。

**变异检验**：每项改动都应让对应的验收测试变红：

| 变异 | 应变红的验收 |
|---|---|
| 提交时不校验 `checkId` | 2 |
| 提交成功后不把检查标为已用 | 2（已用过的那一项） |
| 去掉短词的 `LIKE` 退路，只用 `MATCH` | 3、4 |
| 检查结果不附目录 | 5 |
| 不写版本记录 | 6 |
| 不比较 `baseVersion` | 7 |
| 检索不过滤已被取代的页 | 8 |
| 标题唯一键不做规范化 | 9 |
| `operationKey` 不去重 | 10 |
| 把 FTS 维护移到事务外 | 11 |
| 打开失败时重建空库 | 12 |

## 七、明确不做

- **检索方式**：不做向量检索和嵌入模型，不做帮 agent 问答的 RAG。
- **写入控制**：不导入现有规范仓、记忆、角色说明；不做守门、负责人通知、跨仓总览；不做长写锁、强制解锁、回滚工具。
- **查看页**：不做编辑、删除、讨论区，也不做实时推送。
- **架构**：不抽通用资源平台，不起独立进程，不做动态插件。
