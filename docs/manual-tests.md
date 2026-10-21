# Lane Router V1 手工验证

自动测试覆盖通信、议题、图与知识库工具、HTTP/CLI、文件 mailbox、SQLite 对账、Claude Channel transport、Codex App Server 协议、按需启动与 launcher 参数。通信目录保留原五项工具；默认独立产品显式组合十五项（五项通信、四项议题、四项图工具、两项知识库工具）。Claude/ZCode stdio MCP 入口也选择十五项产品目录，`createLaneMcpServer` 工厂本身默认五项通信目录。Router 的 `issues:false` 保留通信-only装配，不启用议题、图或知识库模块，也不会动态改变已启动 stdio MCP 的工具列表。下面的现场用例验证真实 CLI、模型 provider、浏览器和交互式 TUI 的边界，不能用 fake backend 或 HappyDOM 结果代替。既有“最后验证”保留当时版本与事实，不表示新增功能已在生产现场通过。

## 图资源：lane 更新，网页查看

在 lane 中要求 agent 新建或打开一张图。图独立于 lane，所有已绑定 lane 共享同一资源集合；不按创建者隐藏或限制写入。agent 创建/申请锁后重读当前图，保存批次，再将返回的 `viewUrl` 交给用户。用户从该地址看图，回到 lane 继续讨论。网页没有讨论区、编辑入口或选择 lane 的流程。

| 工具 | 用途 |
|---|---|
| `lane_graph_create` | `operationKey,title,description?`；原子创建空图并持有写锁，返回 `graphId,lockId,lockValid,document,viewUrl`。 |
| `lane_graph_read` | `{graphId}` 或 `{graphId,view:"full"}` 读当前完整图和锁；`{graphId,view:"outline"}` 只读提纲；`{graphId,nodeIds}` 读指定节点的邻域；`{query?,afterId?,limit?}` 查找共享图，默认 50，最多 200 条，按 ID 稳定分页。 |
| `lane_graph_lock` | `operationKey,graphId,action:"acquire"` 取锁并读最新图；`action:"release"` 另带 `lockId`，只返回写摘要。 |
| `lane_graph_apply` | `operationKey,graphId,lockId,changes` 原子修改，只返回写摘要。支持 `set_graph,upsert_group,upsert_node,upsert_edge,delete_node,delete_edge`。 |

图由普通节点、关系和可选嵌套分组组成，不限定领域或层数。新节点需 `id,label`；新边需 `id,source,target,type`；新分组需 `id,label`。更新省略的字段保持原值，`groupId:null` / `parentId:null` 解除所属分组。分组不能成环，边必须连接真实节点，来源 URL 只接受 HTTP(S)。删除节点时须在同批显式删除或改指关联边，遗漏则整批拒绝，原图和锁不变。没有分组/整图删除或历史回滚。

长写锁没有自动过期或续租，Router 重启后仍保留；同一 lane 的新有效绑定可以接续，旧绑定和其他 lane 不能写。其他 lane 可读已提交内容；获锁遇到 `GRAPH_LOCKED` 时等待后重试。写入、释放用错锁 ID 返回 `LOCK_INVALID`。每次新写操作使用新 `operationKey`，同一结果未知的操作重试复用原键和原内容。同键异内容报 `OPERATION_CONFLICT`。重放不会重新写图或抢回已释放的锁；先检查返回的 `lockValid`，失效时以新键重新获锁并读图。

### 旧 Codex 会话与本机恢复

旧会话可以在当前 Codex 进程下运行同一组工具，身份取自 `CODEX_THREAD_ID`，不能用参数指定其他 lane：

```powershell
lane-router-lane graph create --json-file create-graph.json
lane-router-lane graph read --json-file read-graph.json
lane-router-lane graph lock --json-file lock-graph.json
lane-router-lane graph apply --json-file edit-graph.json
```

例如创建文件为 `{"operationKey":"create-rendering-1","title":"渲染知识网络"}`；读取文件为 `{"graphId":"复制返回的ID"}`。编辑文件中 `changes` 可用：

```json
[
  {"op":"upsert_node","id":"material","label":"材质","summary":"描述表面散射"},
  {"op":"upsert_node","id":"bsdf","label":"BSDF"},
  {"op":"upsert_edge","id":"material-bsdf","source":"material","target":"bsdf","type":"使用"}
]
```

持锁 lane 长期不可用时，用户先从读取结果或页面“锁恢复命令”确认当前锁 ID，再执行：

```powershell
lane-router-lane graph force-unlock --id <graphId> --expected-lock <lockId>
```

管理命令通过 discovery 找当前 Router，不直改数据库。若锁已经换人，返回 `LOCK_CHANGED`，重新查看后再决定；无锁则返回已解锁。强解只解除锁，不回滚内容。此命令不发布为 agent 工具，HTTP 只接受 loopback、无 Origin 的 JSON 请求；这是本机可信进程管理边界，不是隔离本机任意进程的权限系统。

### 查看与验证

默认全景收起分组，无分组节点直接显示。侧栏可展开/收起或聚焦分组，面包屑返回全景；搜索包含隐藏节点，并展开其祖先，已展开的其他分组保持不动。侧栏的大纲见下文「大纲、全部展开与全部收起」。跨组边按当前可见祖先聚合，分组卡显示内部关系数量。空白画布、Esc、侧栏 × 取消选择。拖动、自动排版、相机和展开只影响当前查看，刷新页面后不保留。缩放自动展开默认关闭；开启后按“首层”和“每层增加”设定阈值。

本地复验：`npm run build` 同时构建后端与 React Flow 生产页面；`npm run test:graph-browser` 使用独立临时 core/图库、实际 CLI 可执行文件、真实 HTTP 与 Chromium 验证普通图、渲染知识图、导航/搜索/取消选择、刷新后的增改删和故障展示。截图及 `result.json` 保存在命令输出的仓外目录，可用 `GRAPH_BROWSER_EVIDENCE` 指定位置。浏览器与问答页的浏览器用例一样由 `LANE_ROUTER_TEST_BROWSER` 选 Playwright channel：默认 `msedge`（Windows 自带，无需下载），`chromium` 用 Playwright 自带的构建（先 `npx playwright install chromium`）；`result.json` 的 `browser` 记下实际用的浏览器和版本。该 fixture 的模型 backend 是替身，不能据此声称真实模型客户端已验收。

部署后现场验收仍需：两条真实普通 lane 发现同一图，一条持锁修改、另一条可读且等待；释放后另一条获锁修改；当前模型能使用新增工具，旧会话 CLI 可用；用户浏览返回 URL，确认交互和观感。共享部署/重启由维护者安排，本地实现验证不代替该步骤。

### 分层读取与写摘要

需求与设计见 `docs/superpowers/specs/2026-10-20-graph-agent-reads.md`。

- **写摘要：** apply 和释放锁不再返回图文档，只返回 `graphId,lockId,saved,savedAt`（释放为 `released`）、`replayed,lockValid,lock,updatedAt,counts,viewPath`，经工具另带 `viewUrl`。`counts` 是当前已提交文档的节点、边、分组数，重放时也取当前值。create 和获锁照旧返回整份文档。
- **提纲（`view:"outline"`）：** 返回 `view,graphId,title,description,updatedAt,lock,viewPath,counts`，节点只含 `id,label,kind,tags,groupId,summary`，边只含 `id,source,target,type`，分组只含 `id,label,parentId,summary`；原文没有的字段不出现。
- **邻域（`nodeIds`）：** 返回所请求节点的全部字段、至少一端在其中的边（全部字段）、这些边另一端的节点（`neighbors`，提纲字段），以及这些节点所在分组和全部祖先（提纲字段）。只走一跳，`nodeIds` 先去重。任一 ID 不是图中的节点，整次失败，返回 `NODE_NOT_FOUND`，错误文字和服务层 `details.nodeIds` 列出全部缺失 ID。
- `view` 与 `nodeIds` 不能同时给，`nodeIds` 不能为空。只给 `graphId` 时结果与以前逐字相同；查看页的 `GET /graphs/api/:graphId` 不受影响。

自动测试：`tests/graph-service.test.ts` 与 `tests/graph-adapters.test.ts` 覆盖设计稿第五节第 1–12 条。设计稿第六节的七个变异各自让预定的用例变红：

- 写摘要保留 `document`：两条写摘要用例变红。
- 重放时 `counts` 用原操作时的值：写摘要用例变红。
- 提纲漏删节点 `description`：提纲用例变红。邻域用例也会变红，因为 `neighbors` 用的就是提纲字段。
- 邻域只收出边、把请求节点放进 `neighbors`、分组祖先只取直接父级：邻域用例变红。
- 不存在的 ID 被静默跳过：服务层与 RPC 两条 `NODE_NOT_FOUND` 用例变红。

#### TC-GRAPH-READS-1：真实 lane 用新读法改一次图（第六节，尚未执行）

**前提：** 共享 Router 已部署到含此改动的版本；Claude lane 已刷新工具清单，Codex lane 是部署后新开或 resume 的。部署和重启归外部维护对话。

1. 在一条真实 lane 里，对样本图 `9ec0d162-e49e-4594-943e-082b50730600` 依次调用：提纲读取、对一个节点做邻域读取、获锁、apply 一处小改动、释放锁。
2. 记录每次返回的字符数。

**预期：** 提纲和邻域都明显小于整图（2026-10-20 整图约 2.6 万字符）；apply 与释放的返回里没有节点说明，只有计数、锁和更新时间；获锁仍返回整份文档。

#### TC-GRAPH-READS-2：部署前开着的会话照旧能读（第六节，尚未执行）

1. 部署前打开一条 Claude 或 Codex lane，只给 `graphId` 读样本图，保存结果。期间不要改这张图。
2. 部署后在同一会话里再读一次，不刷新工具清单。

**预期：** 两次结果相同，没有 `view` 字段。

### 大纲、全部展开与全部收起

需求与设计见 `docs/superpowers/specs/2026-10-20-graph-page-outline.md`。只改了查看页前端，后端与 `GET /graphs/api/:graphId` 不变。

- **大纲：** 侧栏里搜索框和详情之间，有自己的滚动区，节点再多详情也留在屏幕上。分组按 `parentId` 嵌套，节点挂在所属分组下，无分组节点在最外层；同一层分组在前、节点在后，各自保持文档顺序。
- **折叠就是画布的展开状态：** 大纲不另存折叠状态。点分组的 ▸ / ▾ 直接展开或收起画布上的这个分组，不改选中项；在画布上用详情按钮、聚焦、全景、全部展开 / 收起改了展开状态，大纲跟着变。收起的分组在大纲里不显示下级。开着「缩放自动展开」时，大纲显示按缩放算出的状态。
- **点名字就是定位：** 选中它、展开它的全部上级、镜头移过去、侧栏显示详情，其他已展开的分组不动。搜索结果和「关联关系」里的跳转也这样。当前选中项在大纲里高亮。
- **聚焦也不收起别的分组：** 双击分组、详情「聚焦分组」、面包屑都一样：展开集合加上这个分组和它的全部上级，原来展开的保持。聚焦时画布只显示这个分组，大纲里能直接看到它那一行，上级都是 ▾。用「全景」以外的方式退出聚焦后，这些分组仍然展开。聚焦照旧取消选中。
- **全部展开 / 全部收起：** 在大纲顶部。两者都退出聚焦、关掉缩放自动展开、保留选中项。全部展开展开所有层级的分组并适应画布；全部收起清空展开、不动镜头。顶栏「全景」不变，鼠标提示为「收起全部分组并回到全景」。
- **从缩放自动展开切回手动：** 大纲切换、全部展开 / 收起、侧栏「展开分组 / 收起分组」、定位都会关掉缩放自动展开，并以切换前画布上实际的展开状态为起点，画布不会跳回之前的手动状态。

自动测试：`tests/graph-view.test.ts` 用纯函数测大纲行的顺序、层级和收起时隐藏下级，以及定位追加、聚焦追加、切换起点、全部展开的集合（第 2、4、5、6、7、9、12 条）。`npm run test:graph-browser` 的「Outline」一段在生产构建上测第 1、3、5–10、12 条：每一步重新打开页面，失败集中报出，并保存 `outline.png` 侧栏截图。设计稿第六节的六个变异各自让预定的用例变红。

#### TC-GRAPH-OUTLINE-1：真实浏览器里走一遍大纲（第六节，尚未执行）

**前提：** 共享 Router 已部署到含此改动的版本（前端随 Router 提供）。部署和重启归外部维护对话。

1. 用浏览器打开样本图 `9ec0d162-e49e-4594-943e-082b50730600` 的查看地址。
2. 在大纲里点几个分组的 ▸ / ▾，再在画布详情里点「收起分组」（第 3 条）。
3. 先展开一个分组，再在大纲里点另一个分组里的节点名（第 5 条）。
4. 点「全部展开」，再点「全部收起」（第 7、8 条）。
5. 展开一个分组 A，再展开另一个顶层分组，双击它下面的子分组聚焦；看大纲，再点一个搜索结果退出聚焦（第 12 条）。

**预期：** 大纲和画布的展开状态始终一致；点名字后先前展开的分组仍展开；全部展开后所有节点可见、画布适应；全部收起后只剩顶层、镜头不动、选中项还在；聚焦子分组时大纲里能直接看到它那一行，退出聚焦后 A 仍展开。请用户确认手感。

## 知识库：lane 录入与检索，网页查看

需求与设计见 `docs/superpowers/specs/2026-10-20-knowledge-base-requirements.md` 与 `2026-10-20-knowledge-base-design.md`。知识库是一个独立的 LLM wiki：一个主题一页，每页有标题、一行摘要和 Markdown 正文。它存在 Router 数据目录的 `knowledge.sqlite`，由 Router 同进程的知识库模块独占，不归任何 lane，所有已绑定 lane 都能读写。wiki 从空的开始，不导入规范仓、记忆或角色说明。

| 工具 | 用途 |
|---|---|
| `lane_kb_search` | `{query, terms?, includeSuperseded?, limit?}` 关键词检索，默认 20 条、最多 100 条；`{pageId, version?}` 读一页全文和版本列表，带 `version` 读旧版本；不带参数读目录（标题和摘要），按标题排列，`afterId` 翻页，默认 200 条、最多 500 条。每种读法都带查看地址 `viewUrl`。 |
| `lane_kb_record` | 写 wiki 的唯一入口，分两步。`step:"check"` 带要录的 `title,summary,body` 和相关 `terms`，返回 `checkId`、候选页（含已被取代的页，带标记），活跃页不超过 300 页时附整份目录，超过时只给 `indexTruncated:true`。`step:"commit"` 带 `checkId,operationKey,decision`，`decision.kind` 三选一：`update`（`pageId,baseVersion,summary,body`，可选 `title`）、`supersede`（`pageId,baseVersion,newPage`）、`create`（`title,summary,body`）。 |

- **检索：** 三个字符及以上的词用 SQLite FTS5 `trigram` 做子串匹配；更短的词（如 `cc`、「拒收」）在标题、摘要、正文里做子串扫描。命中按命中词数、标题命中、更新时间排序。命中只是字面出现，是否相关由调用的 agent 看摘要和目录判断。默认不列已被取代的页。
- **录入规则：** 一次检查只属于做检查的那条 lane，只换一次提交；没有检查、检查属于别的 lane 或已用过，返回 `CHECK_REQUIRED`，什么都不写。`baseVersion` 不是当前版本返回 `PAGE_CHANGED`（错误文字里有当前版本号），重读后重新检查。已被取代的页不能再改或再取代，返回 `PAGE_SUPERSEDED` 和取代它的页。标题去首尾空白、合并空白、忽略大小写后唯一，撞了返回 `TITLE_EXISTS` 和那一页。摘要必填，一行，不超过 200 字符。每次提交写一行版本记录；取代时新页记「新建」，旧页记「标为已被取代」并指向新页。同一 `operationKey` 同内容重试返回原结果并标 `replayed`，同键异内容返回 `OPERATION_CONFLICT`，只有成功的提交占用键。
- **库打不开：** 库文件损坏或版本不认识时，Router 照常启动，stderr 写一行 `KB_UNAVAILABLE`，两项知识库工具和查看页返回 `KB_UNAVAILABLE`（HTTP 503）；库文件保持原样，不覆盖、不重建；通信、问答和图照常。

### 旧 Codex 会话

```powershell
lane-router-lane kb search --json-file search.json
lane-router-lane kb record --json-file record.json
```

身份来自 `CODEX_THREAD_ID`，参数与工具相同。例如检查文件 `{"step":"check","title":"lane_send 群发","summary":"一次发给多条 lane 的做法","body":"……","terms":["cc"]}`，提交文件 `{"step":"commit","checkId":"复制返回的ID","operationKey":"kb-create-1","decision":{"kind":"create","title":"lane_send 群发","summary":"一次发给多条 lane 的做法","body":"……"}}`。受限的 DSH / Native Host 工具白名单没有加知识库工具。

### 查看页

`/knowledge` 是目录：标题、摘要、状态、更新时间，可按关键词筛选，可勾选「含已被取代的页」；筛选走同一个检索服务（`/knowledge?q=…`）。`/knowledge/<pageId>` 是单页：正文、状态、取代指向和版本列表，点版本号看旧版本（`?version=N`）。正文用与问答页相同的方式显示 Markdown：HTML 原样显示为文字，不加载图片，不执行脚本。查看页只读，对写方法返回 405，读接口 `/knowledge/api/pages`、`/knowledge/api/pages/<pageId>`、`/knowledge/api/search` 都带 `Cache-Control: no-store`。

自动测试：`tests/modules/knowledge/` 与 `tests/process/knowledge-startup.test.ts` 覆盖设计稿第五节第 1–15 条。设计稿第六节的变异各自只让预定的用例变红，其中「把 FTS 维护移到事务外」分提交前、提交后两种各做一次；另做了三个补充变异（页面把正文当 HTML 渲染、查看页接受写方法、服务导入 HTTP），分别让第 13、13、15 条变红。

本地真实浏览器检查：先在自己的工作树 `npm run build`，再运行 `node tests/knowledge-browser.mjs`。它用独立临时 core 与知识库、实际的 `lane-router-lane kb` 可执行文件、真实 HTTP 和 Edge（`LANE_ROUTER_TEST_BROWSER` 可改），走一遍目录、筛选、单页、旧版本和不安全正文。截图和 `result.json` 保存在命令输出的仓外目录，可用 `KNOWLEDGE_BROWSER_EVIDENCE` 指定。模型 backend 是替身，不能据此声称真实模型客户端已验收。

#### TC-KB-1：两条真实 lane 录入同一主题（第六节；第 1–3 步已通过，第 4 步尚未执行）

**前提：** 共享 Router 已部署到含知识库的版本；Claude lane 已刷新工具清单，Codex lane 是部署后新开或 resume 的。部署和重启归外部维护对话。

1. lane A 用 `lane_kb_record` 检查并新建一页「Router 拒收 `cc`」。
2. lane B 录入「`cc` 已通」：先检查，确认候选里有 A 写的那页，再选 `update` 改原页。
3. lane A 用 `lane_kb_search` 按意思找「怎么一次发给多条 lane」：先看关键词命中，命中不到再读目录。
4. 旧 Codex 会话用 `lane-router-lane kb search --json-file` 读同一页。

**预期：** 第 2 步候选里有 A 的页；更新后版本为 2，旧版本可读；第 3 步 agent 能从目录的摘要找到那页；第 4 步读到的内容与工具相同。

**最后验证（2026-10-21，共享 Router 部署 master `33e5ff3` 之后；验收期间 LR-24 上线，Router 又换过两次，每次构建没有逐一核对）：** lane A 是 `lane-router/kb-impl`，lane B 是 `lane-router/kb`，都是 Claude 会话。

- **工具刷新**：两条 lane 部署前开的会话一开始看不到 `lane_kb_*`。用户在两个窗口各执行一次 `/mcp`，选 `lane` 重连（输出「Reconnected to lane.」），之后 ToolSearch 就能查到两项工具，没有重开会话。
- **第 1 步**：A 做检查，候选和目录都是空的，wiki 原本是空的。随后提交 `create`，得到 pageId `b4e7cb09-a102-45bd-9b5e-a6012cbea414`，版本 1；标题「lane_send 群发」，正文写旧结论「Router 拒收 `cc`」。
- **第 2 步**：B 检查时用的标题是「cc 字段已可用」，terms 为 `cc,lane_send,群发`。候选只有 A 那一页（v1，active），片段命中正文的「拒收 `cc`」；目录附了整份，只有这一页。B 用 `update` 提交，baseVersion 1，得到版本 2，正文写新结论，并把旧说法单列为「已过时」。
- **第 3 步**：A 用整句「怎么一次发给多条 lane」检索，关键词没有命中，因为整句不是正文里的子串。A 按工具说明改读目录，从摘要「用 lane_send 的 cc 一封发给多条 lane」判断这页答的就是这个问题。读当前版得到 v2，版本列表是 v1 新建（kb-impl）、v2 修改（kb）；带 `version:1` 读回原来的旧结论。另测了两个字符的 `cc`，命中这一页，片段落在正文。
- **第 4 步**：lane-router 项目没有 Codex lane，尚未执行。CLI 可执行文件只在 `tests/knowledge-browser.mjs` 的临时 core 上验证过。
- 每次 Router 换代后端口都会变，工具返回的 `viewUrl` 跟着当前 origin 走（本次依次是 58574、56986）。

#### TC-KB-2：用户在浏览器里看 wiki（第六节，已通过）

1. 打开 TC-KB-1 返回的 `viewUrl` 和 `/knowledge` 目录。
2. 点版本列表里的第 1 版，再点「看当前版」。

**预期：** 目录、单页、旧版本都能看；正文排版正常；页面上没有编辑入口。请用户确认观感。

**最后验证（2026-10-21）：** 在问答 `a8d8110d` 里，请用户在共享 Router 上看 TC-KB-1 建的那一页，按四点查看：目录、单页排版、第 1 版与当前版来回切、页面上没有编辑入口。用户回复「我觉得没啥问题吧。」，没有逐点说明。用户当时用的是哪个端口的链接没有记下；kb 贴出的 56986 上的三个链接，kb 逐个打开过，都返回 200。用户顺带问了「是不是所有 lane 共享一个知识库」。答复：是，本机所有项目的 lane 共用一个 `knowledge.sqlite`，模块里没有项目概念，标题全局唯一。

## 用户议题收件箱：使用与操作

页面名为「问答」（2026-10-19 起，以前叫「议题收件箱」），运行看板上的入口也叫「问答」，地址仍是 `/issues`。本节名不改，因为通用仓文档按这个名字引用它。

议题只收录已完成的用户问题答复（保留原问题），以及需要用户决定的主动提问。由已绑定 lane 的 agent 发布；普通进度、整份 TUI 对话不收录。用户从后台的“议题收件箱”链接或同一 Router 的 `/issues` 打开看板，在既有议题里回复，不在网页创建议题或选择任意收件 lane。正常 TUI 仍是主要工作入口。

默认列表“待我处理”包含等待用户的问题和未读 lane 内容；另可查看进行中、全部、已结束历史。只有窗口有焦点、标签页可见时末尾进入过视野的条目才算已读（见下文「看到才标已读」）。**已读不等于回答**；用户要求解释后变为等 lane，lane 给出解释后仍可等待用户确认。答复内容和问题的明确解决分别记录，不能根据“看过了”“工作完成”推断议题结束。

网页回复保存成功后无需回 TUI 重复。**保存、入箱、处理确认是三件事**：保存事务同时持久化正文和交接任务；`pending` 表示尚未确认入箱，`accepted` 表示 core mailbox 已接收，`blocked` 保留原目标不可投递原因；只有 `processedAt` 有值才表示 agent 已记录业务处理回执。在线、通知已发送、普通 `lane_ack` 均不能替代该回执。busy/offline 时保留输入，由原通知泵在后续机会提醒，不自动开 TUI 或反复新建邮件。只有用户可明确结束议题，结束后可查历史，不能继续新增讨论；既有投递仍可补回执。

### 正文排版与结束确认

讨论正文支持 Markdown 标题、强调、列表、引用、表格、链接、行内代码和代码块。提问、答复、TUI 原话和网页回复采用同一展示方式；输入框仍编辑 Markdown 原文，HTTP、工具和数据库不保存渲染后的 HTML。标题、lane 身份、问题选择项和错误消息仍是纯文本。原始 HTML 不执行，危险协议链接不激活，图片不自动加载；不包含代码语法高亮、公式或图表引擎。

解析库通过同源固定路径 `GET /issues/assets/markdown-it.js` 提供，不访问 CDN。部署必须同步 `package.json`、`package-lock.json` 并安装其中锁定的生产依赖；只复制 HTML 或旧 `dist` 不算完成。资源加载失败时页面明确提示暂时显示原文，仍可阅读和提交回复。

点击“结束议题”后，确认提示显示在详情标题下方并取得焦点，不再藏在整段历史的末尾。点击“取消”回到结束按钮，不修改议题；只有再点“确认结束”才提交关闭。存在待确认的提交时按钮仍禁用，需先处理该操作，不能用结束绕过未知提交结果。

界面验证使用测试议题：发布包含列表、表格和代码块的长正文；确认 Markdown 排版、长代码自动换行且右上角有「复制」按钮（复制的是不带末尾换行的原文，2026-10-19 按用户反馈从横向滚动改为换行）、表格可横向滚动、窄屏不撑破详情列。点击结束后应立即看到确认提示；先取消并确认草稿和议题仍保留，再明确确认结束。不要拿真实用户议题作可丢弃 fixture。DOM 自动测试不能代替浏览器视觉和交互验收。

### 两栏在一屏内各自滚动

需求与设计见 `docs/superpowers/specs/2026-10-19-issue-inbox-scroll-layout.md`。2026-10-20 起，宽屏改成左侧边栏布局（见下文「左侧边栏布局」），本节说的滚动行为不变。

宽屏（宽于 680px）下：
- 两栏框占满视口剩下的高度（不小于 420px），整页不再随议题变长。
- 左栏议题列表和右栏讨论历史各自滚动；右栏的标题栏和回复区固定，只有中间的历史滚动。
- 回复区平时两行；聚焦、有草稿或有未完成的操作时展开到约六行。
- 轮询只追加新条目，不重画已有的，所以读到一半的位置和选中的文字都不会被冲掉。
- 打开议题时停在第一条未读的 lane 内容前，并画一条「以下是新内容」分隔线；没有未读就停在最新一条。
- 窄屏照旧整页滚动。

自动测试：
- `tests/modules/issues/layout-browser.test.ts` 用真实浏览器量设计稿第五节第 1–8 条。默认用本机 Edge（Playwright `channel: "msedge"`）。
  - 环境变量 `LANE_ROUTER_TEST_BROWSER` 可换成 `chrome`，或 `chromium`（Playwright 自带，需先 `npx playwright install chromium`）。
  - 浏览器起不来时，整组用例标为跳过，并在输出里写明原因，不会算作通过。
- 第 9–11 条在 `tests/modules/issues/ui.test.ts` 里用 happy-dom 测。

#### TC-ISSUES-SCROLL-1：长议题在一屏内阅读与回复（第 13 条）

**前提：** 在跑的 Router 已读到新页面（时机归用户）。准备一个条目很多的议题，其中一部分已读、后面还有未读的 lane 内容。

1. 在本机浏览器全屏打开 `/issues`，点开那个议题。
2. 拖动右栏历史，再拖动左栏列表。
3. 把历史滚到中间，等两次以上的 5 秒轮询，或点「刷新」。
4. 在一条正文里选中一段文字，再等一次轮询。

**预期：**
- 第 1 步：
  - 整页没有滚动条，回复区和「发送回复」按钮在屏幕底部可见；
  - 历史停在「以下是新内容」分隔线处，分隔线贴着历史区顶部，下面是第一条未读内容；
  - 打开一个全部已读的议题时，停在最新一条，没有分隔线。
- 第 2 步：只有被拖的那一栏在动，标题栏和回复区不动。
- 第 3 步：历史和列表的位置都不跳。
- 第 4 步：选中的文字还在。

**最后验证：** 第 1–3 步通过。2026-10-19 20:26，design 在主检出构建 `3c73796`，重启共享 Router（新 pid 89384，端口 59006）。`lane-router/inbox` 在 20:28 至次日 01:00 之间做了本节和下面几个用例的确认。

- 用 Edge 155.0.4283.62 打开在跑的 `/issues`，拦截所有非 GET 请求（实际一个也没有），在议题 `2a5887bd`（18 条）上观察。
- 1280×800：文档 `scrollHeight` 800，等于视口；历史区自己滚动（`scrollHeight` 3559 / `clientHeight` 235）。标题栏 y 289–374、发送按钮 y 710–747，刷新前后不变。
- 打开时有分隔线，停在第一条未读；滚到中部后点「刷新」，`scrollTop` 1662→1662。
- 375 宽：整页滚动，历史区 `overflow` 为 `visible`。
- 第 4 步（选中文字）没有真机做，由自动测试覆盖。

### 看到才标已读

需求与设计见 `docs/superpowers/specs/2026-10-19-issue-read-on-sight.md`。以前每次读完详情就把已加载的内容全部标为已读，页面开在副屏、人在 TUI 里时，「未读答复」几秒内就没了。现在：
- 一个条目要在标签页可见、窗口有焦点时，**末尾**进入过视野，才算读过。比屏幕还高的答复只露出开头不算。
- 视野就是浏览器窗口实际显示的部分：宽屏下再被历史区裁剪，窄屏下就是窗口。宽屏但窗口很矮（矮于 420px，页面本身要滚动）时，历史区里落在窗口以外的条目不算看见。
- 窗口失焦时到达、已经摆在眼前的条目，切回窗口时算读过，不用再滚一下。
- 已读位置仍是一个水位线：末尾见过的条目里最大的 `seq`。跳着往下看，跳过的部分也算读过。
- 浏览器没有 `IntersectionObserver` 时从不标已读，不退回旧行为。

自动测试：
- `tests/modules/issues/layout-browser.test.ts` 的「reading position in a real browser」一组，用真实浏览器量设计稿第五节第 1–5 条（浏览器选择同上一节）。
- 第 6 条在 `tests/modules/issues/ui.test.ts` 里用 happy-dom 测。happy-dom 不排版，它自带的 `IntersectionObserver` 从不回调，所以 `ui.test.ts` 换成一个「所有条目末尾都在视野里」的替身；原有用例的断言一条没改。

#### TC-ISSUES-READ-1：页面不在前台时，未读答复保持未读（第 7 条）

**前提：** 在跑的 Router 已读到新页面（时机归用户）。

1. 在浏览器里打开 `/issues`，点开一个进行中的议题，然后把焦点切到别的窗口（例如 TUI），浏览器窗口留在副屏上可见。
2. 让这个议题的 lane 发一条答复，等两次以上的 5 秒轮询。
3. 切回浏览器窗口，把历史滚到底，再等一次轮询。

**预期：**
- 第 2 步：新答复出现在历史里，列表上这个议题显示「未读答复」，并且一直保持。
- 第 3 步：「未读答复」消失。

**最后验证：** 2026-10-20 00:58 通过，构建和 Router 同 TC-ISSUES-SCROLL-1。用户配合，验收议题 `969f42f1`。
- 用户打开议题后切回 TUI，`lane-router/inbox` 追加答复 seq 2。15 秒多（至少三次轮询）之后，后端 `readSeq` 仍为 1。
- 用户点回浏览器、把历史滚到底后，`readSeq` 推进到 3，「未读答复」消失。

### 小修五项：系统记录、列表、在线状态、草稿、改名

需求与设计见 `docs/superpowers/specs/2026-10-19-issue-ui-touchups.md`。
- **系统记录：** 历史里的系统记录（问题已回答、无需回答、结束议题）显示成一行灰色小字，鼠标悬停看时间，正文里的问题 ID 和条目 ID 显示成 #序号。问题面板的「答复」也显示 #序号。标题下的议题 ID 只显示前 8 位，悬停看完整 ID。
- **选中议题留在列表：** 选中的议题因为回复等原因不再符合当前筛选时，仍留在列表原来的位置，变淡并标「已不在当前筛选」。选别的议题或切换筛选后，按真实结果显示。
- **在线状态：** 列表和标题下在 lane 地址后面显示 Router 对它的判断：「在线」「可能在忙」「未确认」「离线」。这只是 Router 的判断，不代表 lane 正在处理回复，悬停时有说明。归档或缺失的 lane 不显示。
  - 后端 `IssueOwner` 多了 `presence` 字段，agent 侧 `lane_issue_read` 的返回里也有。
  - 这部分要重启 Router 才生效；在那之前，页面读不到这个字段，就不显示。
- **草稿：** 回复草稿按议题存在浏览器本地（`localStorage`，键名 `lane-router.issues.draft.<议题 ID>`），刷新页面后还在，发送成功后删除。浏览器不让用本地存储时，只存在内存里。有正在保存或结果未确定的操作时，离开页面前浏览器会先问一句；只有草稿时不问，因为草稿不会丢。
- **改名：** 见本节开头。

自动测试：`tests/modules/issues/ui.test.ts` 末尾编号 1–7 的用例对应设计稿第五节第 1–7 条，在线状态的取值表在 `tests/modules/issues/presence.test.ts`。第 1 条同时运行 `service.ts` 写记录和页面显示，记录格式一改就会变红。

#### TC-ISSUES-TOUCHUP-1：系统记录、选中保留、在线状态和改名（第 9 条）

**前提：** 共享 Router 重启到含此改动的构建（时机归用户），浏览器读到新页面。

1. 打开运行看板，点「问答」入口。
2. 打开一个有「问题已回答」系统记录的议题。
3. 在「待我处理」里选一个等你回答的议题，回复它，等两次以上的 5 秒轮询。
4. 看列表和标题下 lane 地址后面的状态。对照运行看板上这个 lane 的可达性；可以的话，让 lane 忙起来或离线，再看一次。

**预期：**
- 第 1 步：页面标题和页头是「问答」，地址是 `/issues`。
- 第 2 步：系统记录是一行灰色小字，例如「问题 #1 已回答（答复 #3）」，看不到 UUID。标题下的议题 ID 是 8 位。
- 第 3 步：这个议题仍在列表原来的位置，变淡，标「已不在当前筛选」。点别的议题后，它从列表里消失。
- 第 4 步：显示「在线」「可能在忙」「未确认」或「离线」，和运行看板的判断一致；悬停能看到「Router 的判断，不代表 lane 正在处理你的回复」。

**最后验证：** 第 1、2、4 步通过，构建和 Router 同 TC-ISSUES-SCROLL-1，由 `lane-router/inbox` 确认。
- 第 1 步：页面标题和 h1 是「问答」，运行看板的入口也是「问答」。
- 第 2 步：系统记录是单行，用 #序号，历史里没有 UUID；议题 ID 显示 8 位。
- 第 4 步：看到「可能在忙」「未确认」两种，悬停说明正确。
- 第 3 步（保留项变淡）没有经用户目测确认，由自动测试覆盖。

### 左侧边栏布局

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-page-sidebar-layout.md`。2026-10-19 上线后实测，1280×800 下讨论历史只有 235px 高：两栏框上面压着页头、大标题、说明文字、筛选行和状态行，整页还限宽 1280px。现在宽屏（宽于 680px）改成 ChatGPT 那种两块布局：
- **左侧边栏：** 贴窗口左边，从顶到底，宽 `clamp(240px, 24vw, 320px)`（1280 宽时 307px）。从上到下依次是：
  - 「问答」（悬停显示原来的说明文字）和运行看板链接；
  - 四个筛选选项卡；
  - 「已刷新」状态和刷新按钮；
  - 议题列表，只有它在侧边栏里滚动。
- **右边：** 打开的议题占满剩下的宽度和高度。标题栏、历史区、回复区左右各留 32px，不设最大宽度。1280×800 下历史区 533px 高。
- **去掉的：** 顶部页头、说明文字和整页 1280px 的宽度限制。整页最矮 420px，比这还矮时页面本身滚动。
- **「已刷新」状态只占一行：** 只写时间，如「已刷新 01:43:11」；悬停看完整日期和「每 5 秒读取后端」。读取出错时整句照常折行显示，没有悬停提示。万一一行放不下，用省略号截掉，正常情况下不会出现。
- **选项卡：** 窗口宽约 1200px 起（侧边栏 288px 以上）四个选项卡排一行，更窄时排成两行。
- **窄屏：** 照旧上下排列、整页滚动，侧边栏的内容在上，议题在下。
- **顺带修的旧缺陷：** 「回复对象」下拉框显示的是问题原文，原文很长时会把整个回复表单撑到约 800px 宽，窄屏和 800 宽的窗口里「发送回复」按钮跑到窗口外面。旧布局里它被外框裁掉，看不见，改成侧边栏后窄屏会整页横滚。现在表单不会比回复区宽。

自动测试：
- `tests/modules/issues/layout-browser.test.ts` 的「sidebar layout」一组，用真实浏览器量设计稿第五节第 1–5 条，另有一条专测上面那处回复表单缺陷。
- 设计稿第六节的六个变异，都让预定的用例变红。已读稿的八个变异，在新布局下也都还能让对应用例变红。
- 滚动稿和已读稿里依赖页面几何的用例，有两条按新布局改了数值，用意不变：
  - **已读稿第 1 条：** 每个条目从 2 句改成 8 句。历史区变高后，12 条短条目一屏就能全部显示，打开时停不到分隔线上，测不出「只有末尾露出来的才算读过」。
  - **已读稿的矮窗口用例：** 窗口从 1280×440 改成 1280×160。新布局下历史区下沿在 y≈254，窗口要比这还矮，历史区的下半截才会落到窗口外面。设计稿举例的 1280×360 再现不了这个场景。
    - 这一例改用 DOM 点击选议题，因为 Playwright 点击前会先把列表项滚进视野，连页面一起滚动。
    - 「把历史区剩下的部分滚进窗口」原来是把页面滚到底，现在改成让历史区下沿对齐窗口下沿：页面底部还有回复区，直接滚到底会把历史区几乎整个滚出窗口。
- `tests/modules/issues/ui.test.ts` 第 7 条：`<h1>` 移进了侧边栏，选择器从 `main h1` 改成 `h1`。同一文件末尾新增一条，用 happy-dom 测状态行的文字、悬停提示和读取失败时的样子。

#### TC-ISSUES-SIDEBAR-1：左侧边栏布局（第 7 条）

**前提：** 主检出构建到含此改动的版本。只改了页面，在跑的 Router 每次请求都重新读页面，不用重启；构建时机归用户。

1. 在本机浏览器全屏打开 `/issues`，点开一个长议题。
2. 看左边侧边栏里从上到下的内容，再把鼠标悬停在「问答」上。
3. 议题多于一屏时，滚动侧边栏里的列表。

**预期：**
- 第 1 步：
  - 侧边栏贴着窗口左边、从顶到底；页面顶部没有页头，整页没有滚动条。
  - 右边议题的标题栏在最上面，讨论历史占大部分高度，「发送回复」按钮在屏幕底部可见。
  - 右边内容铺满，两侧除了边距没有空白。
- 第 2 步：依次是「问答」和「运行看板」、四个筛选选项卡、「已刷新 hh:mm:ss」和刷新按钮、议题列表，「已刷新」后面没有省略号；悬停「问答」时显示原来那两句说明，悬停「已刷新」时显示完整日期和「每 5 秒读取后端」。
- 第 3 步：只有列表在动，侧边栏上半部分和右边都不动。

**最后验证：** 2026-10-20 02:30 第 1–3 步通过。
- **上线方式：** design 于 02:28:17 在主检出构建 `15462d4`，没有重启 Router（pid 89384，端口 59006）；`dist` 与 `src` 的页面 sha256 一致。
- **验收方法：** `lane-router/inbox` 用 Edge 155.0.4283.62 打开在跑的 `/issues`，拦截所有非 GET 请求（实际一个也没有），在议题 `2a5887bd` 上观察。
- **1280×800：**
  - 没有页头；侧边栏在 (0, 0)，大小 307×800；文档 `scrollHeight` 800。
  - 标题栏顶边 y=16，历史区 533px，「发送回复」在 y 735–772。
  - 主区 x 307–1280，内容 339–1248，左右各 32px，没有别的留白。
- **侧边栏：**
  - 从上到下依次是 h1「问答」、运行看板、`#filters`、`#list-status`、`#refresh`、`#thread-list`。
  - 状态行「已刷新 02:30:16」，没有被截断；它的 title 是「最后一次读取：2026/10/20 02:30:16 · 每 5 秒读取后端」。
  - h1 的 title 是原来那两句说明。
  - 列表 `scrollTop` 从 0 改到 300 时，h1 的位置、历史区 `scrollTop`、文档 `scrollTop` 都不变。
- **1920×1000：** 侧边栏 320px，内容 x 352–1888，历史区 733px。
- **375×800：** 整页滚动，`scrollWidth` 375，没有横向滚动；历史区 `overflow` 为 `visible`。

### 从问答页新开问答，lane 没开着就唤醒

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-start-from-page.md`。

**新问答：**
- 侧边栏顶上「问答」旁边有「新问答」按钮。点了以后，右边不显示议题，换成新问答视图：
  - 「发给」：按项目分组列出在役、跑过对话的 lane，每项写着「在线」「没开着，发出后会打开它的窗口」或「Router 打不开它，消息会等它开着时再处理」。Router 只能打开 Claude 和 Codex 的对话；zcode、dsh、native-codex 的 lane 没开着时，以及 Codex 宿主没连上时，都标最后这一种。
  - 「标题」：可以不填。不填时取正文第一行有字的那行，去掉行首的 `#`，截到 60 个字。
  - 正文。
- 没选 lane 或正文为空时不能发送。
- 发出后切到「进行中」并选中这条新议题。lane 收到的信写明：这是用户本人的话，等同于在 TUI 里说的，答复写在这条问答里。
- 草稿（标题和正文）存在这台机器的浏览器里，刷新后还在，发出后清掉。点「取消」只关掉视图，不清草稿。上次选的 lane 下次会预选，它不在列表里了就不预选。
- 发送结果不明时，和回复一样，出现「用同一操作重试」和「查看后端历史」。新问答的「查看后端历史」会把列表切到「进行中」，新问答视图留着不关。

**唤醒：**
- 新问答或回复保存成功后，Router 用运行看板「恢复 lane」的同一套逻辑打开这个 lane 的窗口。lane 在线就跳过；30 秒内重复打开同一条 lane 会被挡住，看板和问答页共用这一道防重。
- 状态行显示结果：
  - 「已发送。」
  - 「已发送。这个 lane 没开着，已经让 Router 打开它的窗口。」
  - 「已发送。这个 lane 正在打开。」
  - 「已发送，但没能打开这个 lane（原因）。消息会等它打开后再处理，可以去运行看板手动恢复。」
- 打不开不影响保存：信已经在 lane 的信箱里，lane 下次开着时会处理。
- **Claude lane 不用再点确认**（`docs/superpowers/specs/2026-10-21-channel-plugin-migration.md` 4.6）：
  - 以前 Claude lane 带 `--dangerously-load-development-channels` 启动，每次都弹「WARNING: Loading development channels」，要点「I am using this for local development」才往下走，问答页的 lane 列表和唤醒提示都叫用户去点（`docs/superpowers/specs/2026-10-20-issue-wake-claude-confirm.md`，已作废）。
  - 改走频道插件以后不再弹这个框，页面上 Claude lane 和 Codex lane 的说法相同：lane 列表写「没开着，发出后会打开它的窗口」，唤醒提示就是上面列的几句。
  - 唤醒结果的 `launch_requested` 和 `skipped_launching` 照旧带 lane 的 `backend`，页面不再用它选文案。
  - 自动测试：`tests/process/issue-wake.test.ts` 和 `tests/modules/issues/ui.test.ts`。「Claude 还带确认提示」的变异在提示和列表两处各试了一次，都让用例变红。
- **同时修的现有缺陷（Claude）：**
  - **原来的问题：** Claude lane 恢复后，channel 一连上 Router 就收到通知，这时 Claude 还没初始化好 lane 的 MCP 服务。客户端把这一帧丢了，lane 就守着积压的信不动，直到有人打字。
  - **现在：** 客户端先留住最新一帧，会话接上时补交一次。
  - **影响范围：** 看板「恢复 lane」、`lane_restore_project` 和问答页的唤醒走的都是这条路，一起修好了。
  - **测试：** `tests/process/local-transport.test.ts`。
- **同时修的现有缺陷（Codex）：**
  - **原来的问题：** thread 已从共享 App Server 卸载的 Codex lane，打开窗口并不会触发投递，要等 thread 报告空闲。App Server 加载 thread 时会不会报，仓库里看不出来。
  - **现在：** 宿主报告某个 thread 的窗口数从 0 变成大于 0 时，Router 对这一个 thread 投递一次。
  - **测试：** `tests/process/codex-host-hub.test.ts`。

自动测试：
- `tests/modules/issues/create.test.ts`：建议题的事务、各种拒绝、同键重放，以及唤醒端口抛错时算作唤醒失败。
- `tests/modules/issues/http.test.ts`：新入口的四项检查、字段白名单、响应里的 `wake`，以及 `GET /issues/api/lanes`。
- `tests/router/router-core.test.ts`：可选 lane 的筛选和排序。
- `tests/process/issue-wake.test.ts`：`main.ts` 的唤醒实现。
- `tests/process/issues-startup.test.ts`：在整个 Router 进程里，唤醒用的是和看板、核心共用的那一个 restorer。
- `tests/modules/issues/ui.test.ts`：happy-dom 下的页面行为。
- `tests/modules/issues/layout-browser.test.ts` 的「new issue」一组：在 Edge 里从发送到选中走一遍，并量宽窄两种窗口下的布局。

#### TC-ISSUES-START-1：给在线 lane 新开问答（第 9 条）

**前提：** 主检出构建到含此改动的版本，并重启 Router（改了后端）。构建和重启的时机归用户。

1. 打开 `/issues`，点「新问答」。
2. 「发给」选一个标着「在线」的 lane，标题留空，正文写一个它能直接回答的小问题，发送。
3. 等 lane 答复。

**预期：**
- 第 2 步：
  - 列表切到「进行中」，选中新议题，标题是正文第一行。
  - 状态行写「已发送。」。
  - 议题第一条是「我 · 提问」，问题状态是「等待 lane」。
- 第 3 步：lane 在这条问答里答复，问题自动变成「已回答」。lane 没有回 TUI 找人确认。

**最后验证：** 尚未执行。

#### TC-ISSUES-WAKE-1：唤醒没开着的 Claude lane 和 Codex lane（第 10 条）

**前提：**
- 同上，主检出构建到含此改动的版本，并重启 Router。
- 准备一个没开着的 Claude lane 和一个没开着的 Codex lane，都跑过对话。Codex lane 最好是宿主里已经卸载的，也就是关窗后 Router 或宿主重启过。

1. 在问答页给 Claude lane 发一条（新问答或回复都行），不碰任何 TUI。
2. 对 Codex lane 做同样的事。
3. 在运行看板上「恢复 lane」，恢复一个信箱里有积压信的 lane，同样不碰 TUI。

**预期：**
- 第 1、2 步：
  - 状态行写「已发送。这个 lane 没开着，已经让 Router 打开它的窗口。」，桌面上弹出这个 lane 的终端窗口。
  - 没人打字，lane 也会自己开始处理这封信，并在问答里答复。
- 第 3 步：lane 起来后同样自己处理积压的信。

**最后验证：** 尚未执行。

### 点开 lane 写的本机路径

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-files.md` 第 3.1 节；同稿的上传附件（3.2、3.3）还没做。

- **页面：** 条目正文里的盘符绝对路径（`X:\…`、`X:/…`）变成带框的按钮，悬停显示「用本机程序打开」。lane 和用户的条目都处理。
  - 行内代码：去掉首尾空白和末尾的 `:行号`、`:行号:列号`，剩下整段是路径才处理。点了打开的是去掉行号的路径。
  - 普通文字：找不含空格的片段，碰到全角的句号、逗号等就停，末尾的标点留在句子里。紧跟在字母、数字或 `/`、`\`、`:` 后面的不算，所以网址里的 `x:/y` 不会变成链接。
  - 代码块和 Markdown 链接里的路径不处理。
- **入口：** `POST /local-files/open`，过 `readPageAction` 的四项检查，动作头 `open-local-path`。入口不属于问答，别的页面也能用。
  - 网络路径、设备路径、相对路径、含 NUL 的路径，以及盘符之后又出现冒号的路径（NTFS 数据流），都直接拒绝，返回 `refused` 和原因，不查磁盘。
  - 不存在返回 `missing`。存在但既不是文件也不是文件夹的，返回 `refused`。
  - 文件夹，以及类型在安全名单（`src/process/local-open.ts` 的 `OPEN_WITH_DEFAULT_PROGRAM`）里的文件，用默认程序打开，返回 `opened`。其他文件在资源管理器里选中，返回 `revealed`。
- **怎么启动：** 固定脚本交给 `powershell.exe`，路径放在环境变量里，不进任何命令行。打开用 ShellExecute，路径本身就是要打开的文件。选中用 `explorer.exe /select,"<路径>"`：路径加了引号，资源管理器就不会在逗号处把它拆开。
  - 只在 Windows 上装配；别的系统上这个入口不存在，点了提示「打开失败」。
  - 启动失败时（比如没有关联程序）返回 500，页面显示「打开失败：…」。
- **提示：** 写在 `#operation-status`。回复正在保存或结果未定时，那一行留给回复，打开的结果不覆盖它。

自动测试：
- `tests/process/local-open.test.ts` 测第五节第 1、2 条。启动程序换成替身，只记录要启动什么，什么都不打开。
  - 只有一条用例真的启动了 PowerShell：脚本收到一个它不认识的模式，在碰路径之前就以退出码 2 退出。这条用来证明固定脚本本身能运行，什么都不打开。
- `tests/modules/issues/path-links-browser.test.ts` 测第 7 条，属于浏览器组，Router 那边同样用替身。`refused` 那一句提示靠拦截响应测：页面会做成链接的路径里，没有一条会被 Router 拒绝。
- 设计稿第六节里属于 3.1 的五个变异，各自让预定的用例变红：
  - 安全名单加 `.ps1`、不拒绝 UNC、把路径拼进命令行：第 1 条的用例变红。
  - 入口不过 `readPageAction`：第 2 条的用例变红。
  - 代码块里的路径也变成链接：第 7 条的用例变红。分别试了两种改法，行内代码那一步不排除 `pre`，以及扫描文字时进入 `pre`。

#### TC-ISSUES-FILES-2：点开文件夹、`.md` 和 `.ps1`（第 11 条，尚未执行）

**前提：** 主检出构建到含此改动的版本，并重启 Router。入口是 Router 的新代码，只换页面不够：不重启的话，点了会提示「打开失败：not found（404）」。重启和构建的时机都归用户。

1. 准备一条议题，正文里在行内代码中写三个路径：一个存在的文件夹、一个 `.md` 文件、一个 `.ps1` 文件。`.ps1` 的内容不要有副作用，比如只写一行 `Write-Output hi`。
2. 在 `/issues` 里打开这条议题，依次点这三个路径。

**预期：**
- 文件夹：资源管理器打开这个文件夹，提示「已打开」。
- `.md`：用 `.md` 的默认程序打开，提示「已打开」。
- `.ps1`：资源管理器打开它所在的文件夹并选中它，它没有运行，提示「这类文件不直接打开，已在资源管理器里选中它」。

### 问答里的附件：贴图、拖文件、选文件

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-files.md` 第 3.2、3.3 节，以及 3.2 末尾的「实现时补定」。

- **添加：** 回复框和新问答框都能加文件，有三种方式：
  - 在输入框里按 Ctrl+V。剪贴板里只有文字时照常粘贴文字。
  - 把文件拖到表单上，拖过来时整块显示虚线框。
  - 点「添加文件」，可以多选。
- **上传：** 文件一加进来就开始传，输入框下面列出附件：图片显示缩略图，其他文件显示文件名和大小，每个都有「移除」。
  - 传的时候显示进度；失败时显示原因和「重试」。
  - 超过 25 MB（25 × 1024 × 1024 字节）的文件在页面上就拦下，不发出去，只能移除。
  - 有附件还在传、或者有附件没传上时，发送按钮不能点。
  - 只有附件、没有正文也能发：回复的正文存成「（发送了 N 个文件）」；新问答没填标题时，标题取第一个文件名。
- **草稿：** 已传上的附件跟草稿一起存在这台机器的浏览器里。刷新后照样列出，并用 `HEAD /issues/api/attachments/<编号>` 逐个确认还在。已被清理的从草稿里去掉，并提示一次「N 个附件已被清理，已从草稿里去掉。」。
- **历史：** 带附件的条目在正文下面列出附件。
  - 图片显示缩略图，最高 160px，点开后在新标签页看原图。
  - 其他文件显示文件名，点了走「点开 lane 写的本机路径」那个入口，路径是附件的保存路径，安全名单照样生效。
- **lane 收到的信：** 在「用户回复」或「用户的话」后面列出每个文件的名字、大小和保存路径。lane 用自己的文件读取能力直接读。
- **保存位置：** 附件存在 Router 数据目录下的 `issue-attachments\<附件编号>\<文件名>`。数据目录默认是 `%USERPROFILE%\.lane-router`，可以用 `LANE_ROUTER_DATA_ROOT` 改。
  - 文件名会先清洗：去掉路径部分、Windows 不允许的字符、末尾的点和空格；设备名前面加 `_`；截到 120 个字符，保留扩展名。
  - 附件编号是随机的 UUID。
- **清理：** Router 启动时清一次，之后每 6 小时清一次：
  - 超过 24 小时还没挂到条目上的附件，先删表里的行，再删目录；
  - 附件目录下没有对应行、并且超过 24 小时的编号目录也删掉。
  - **已挂上条目的附件不会自动删**，占用的磁盘空间要手动处理。
- **问答库升到 v3：** 加了附件表。v2 库升级前先复制成 `issues.sqlite.v2.bak`，v1 库直接升到 v3，备份文件是 `.v1.bak`。回退方法见「停止、恢复、备份与回退」。

自动测试：
- `tests/modules/issues/attachments.test.ts`：保存、上限、文件名、类型识别、清理。
- `tests/modules/issues/attachments-http.test.ts`：上传和读取两个入口。
- `tests/modules/issues/attachments-link.test.ts`：回复和新问答带附件。
- `tests/modules/issues/attachments-schedule.test.ts`：模块启动时清理一次，之后每 6 小时一次。
- `tests/modules/issues/schema-upgrade.test.ts`：v1、v2 升到 v3（现在升到 v4，见下）。
- `tests/modules/issues/attachments-browser.test.ts`：浏览器组，页面上的贴、拖、选、上传中不能发、重试、页面拦超限、草稿还原和清理提示、历史显示、新问答。
- 设计稿第六节里属于 3.2、3.3 的六个变异，各自让预定的用例变红。

**附件按添加的顺序显示**（`docs/superpowers/specs/2026-10-21-issue-attachment-order.md`，问答库 v4）：

- 一条回复或新问答里的附件，历史里按用户添加的顺序显示，也就是发送时 `attachmentIds` 的顺序，和给 lane 的信里列的顺序一致。原来按上传完成的先后排，几个文件同时上传时，历史里的顺序可能和信里对不上。
- 问答库升到 v4：`issue_attachment` 加可空整数列 `position`，认领时写入它在 `attachmentIds` 里的下标；读出时先按 `position`，再按 `created_at`。升级前的行 `position` 为空，照旧按上传先后，显示不变。升级前照例备份成 `issues.sqlite.v3.bak`；从 v1 一次升上来只留 `.v1.bak`。
- **上线：** 要重启核心。升到 v4 以后旧构建打不开问答库，部署前先备份。
- 自动测试：`tests/modules/issues/schema-upgrade.test.ts` 加了 v3 的夹具（`tests/fixtures/issues/v3-from-v2.sql`，v3 当时的语句原样冻结），以及升级、备份、已有附件行不变、结构和新库一致的用例；`tests/modules/issues/attachment-order.test.ts` 测回复、新问答的顺序和旧数据的退路。`attachments-browser` 里比上传先后的那句改成不比先后，连跑 5 遍都过。三个变异（读出不按 `position` 排、认领不写 `position`、升级时改了旧行）各让预定的用例变红。

#### TC-ISSUES-FILES-1：截图贴进问答发给 lane（第 10 条，尚未执行）

**前提：** 主检出构建到含此改动的版本，并连 Codex 宿主一起重启 Router（`scripts/restart-router.ps1 -CodexHost`）。重启和构建的时机都归用户。

1. 用户按 Win+Shift+S 截一张图，在问答页某个 Claude lane 的议题回复框里按 Ctrl+V，写一句「图里是什么」，发送。
2. 对一个 Codex lane 做同样的事。

**预期：**
- 第 1、2 步：回复框下面出现缩略图并很快传完，发送后历史里这条回复下面有缩略图。
- lane 收到的信里列出这张图的保存路径。lane 读出图片内容，并在问答里答复。

### 用键盘发送：Ctrl+Enter 或 Enter

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-send-shortcut.md`。

- 回复框和新问答正文都能用键盘发送，默认 Ctrl+Enter（Mac 上 ⌘+Enter 也行），Enter 照常换行。
- 发送按钮左边的下拉框可以改成「Enter 发送」：Enter 发送，Shift+Enter 换行，Ctrl+Enter 也发送。两个输入框共用这一个设置，存在这台机器的浏览器里（`lane-router.issues.send-key`）；读不到时按 Ctrl+Enter。发送按钮的悬停提示写着当前的快捷键。
- 用输入法打字时，确认候选词的那一下 Enter 永远不发送。
- 快捷键等于按发送按钮：按钮不能点时（附件还在上传或没传上、正在发送），快捷键也不发送。
- 新问答的标题框里按 Enter，光标移到正文；按 Ctrl+Enter 发送。

自动测试：
- `tests/modules/issues/send-shortcut.test.ts`（happy-dom）覆盖设计稿第五节第 1–6 条。
- `tests/modules/issues/send-shortcut-browser.test.ts`（浏览器组）覆盖第 7 条和附件上传中的第 4 条。
- 第六节的五个变异各自让预定的用例变红；另外，去掉回复框上的快捷键，浏览器组两条都变红。

### 左栏按项目分组

需求与设计见 `docs/superpowers/specs/2026-10-21-issue-group-by-project.md`。

- 左栏的问答按 lane 所属项目分组。哪组的最新一条更新，哪组排在前面；组内从新到旧。lane 已不存在的问答归到「lane 已不存在」一组。
- 组头是一个按钮：前面是折叠箭头和项目名，后面是「N 条」；这一组还有没读到的页时写「N 条，已显示 K」。有待我处理的问答时，组头最右边是「待我处理 M」，颜色和「待我回答」一样。项目条数读不到时，组头只写「已显示 K 条」，状态行报错。
- 点组头折叠或展开这一组。折叠了哪些组存在浏览器里（`lane-router.issues.collapsed-projects`），四个状态筛选共用；读不到时全部展开。
- 状态筛选下面的下拉框选项目，选项写成「lane-router · 待我处理 6」这样。选择存在浏览器里（`lane-router.issues.project`）；存的项目已经不在了，就按「全部项目」。下拉框和左栏一样宽，窄屏上也是。
- 选着别的项目时新开一条问答：发出后项目筛选回到「全部项目」，新的那条所在的组如果折叠着就展开。
- 后端：列表接口多一个 `project` 参数；新加只读接口 `GET /issues/api/projects?filter=`，给出每个项目的条数和待我处理数。lane 工具不变。

自动测试：
- `tests/modules/issues/projects.test.ts`（node 组）覆盖设计稿第六节第 1–3 条。
- `tests/modules/issues/project-groups.test.ts`（happy-dom）覆盖第 4–9 条。
- `tests/modules/issues/project-groups-browser.test.ts`（浏览器组）覆盖第 10 条。
- 第七节的六个变异各自让预定的用例变红；页面的三个变异也让浏览器组那条变红。

### 切号后继续：问答页上的两个按钮

需求与设计见 `docs/superpowers/specs/2026-10-21-continue-after-account-switch.md`（4.3 问答页入口、验收第 8 条）。Router 的路由和账号页那一半归 impl，用例见那份稿子的验收第 9、10 条。

- 左栏标题行下面单独一行：「继续 Claude lane」「继续 Codex lane」。手动切号以后点对应后端的那个，Router 给这个后端在用的每条 lane 发一封「切号后继续」的信。悬停提示说明了用途。左栏最窄时（窗口宽 681–999px），两个按钮会折成两行；标题行不受影响。
- 点了调看板路由 `POST /dashboard/lanes/continue-after-switch`，带页面的 `actionToken`。按钮下面一行写结果，说法和账号页一样：「已唤醒 N 条：…；N 条没开着，信已留在它的信箱，打开时处理：…；跳过 N 条：地址（原因）。」60 秒内对同一后端再点，写「60 秒内刚发过一轮，这次没有再发。」没有在用的 lane 时写「没有在用的 Claude lane。」
- 2026-10-21 起（LR-55）只发在线且回合被掐断的 lane，空闲的和离线的不发：结果里写「M 条在线但空闲，没发；K 条离线，没发」，只给条数、不列地址，和账号页逐字一致。「没开着，信已留在信箱」只剩选中时在线、写信时刚好关掉的少见情况。用例 `continue-after-switch.test.ts` 加了混合的一条，「把空闲的也列出地址」的变异让它变红；浏览器组那条的期望改成「已唤醒 1 条：alpha/open；1 条离线，没发。」
- 接口报错时写「没能发出：原因」。等回答时两个按钮都不能点。没有二次确认：多发一封信，代价只是 lane 确认一次已读。

自动测试：
- `tests/modules/issues/continue-after-switch.test.ts`（happy-dom，路由用替身）：两个按钮、请求的头和正文、三类结果的说法、报错、等回答时不能再点。
- `tests/modules/issues/continue-after-switch-browser.test.ts`（浏览器组）：真 Edge 按真的看板路由，后面是和 `main.ts` 一样接起来的 Router（夹具 `tests/fixtures/issues/page-router.ts`：真信箱，两个后端用替身）。核对信进了开着和没开着的 Claude lane 的信箱、Codex lane 没收到、只有开着的窗口收到通知帧；页面依次写出三类结果、60 秒内重复、Codex 那一轮，以及路由拒收时的原因。
- 去掉结果里的「没开着」一类、请求不带 `actionToken`、等回答时按钮不禁用，三个变异各让 happy-dom 用例变红；前两个也让浏览器组那条变红。

### 进度：按 lane 分组的待办表

需求与设计见 `docs/superpowers/specs/2026-10-21-progress-list.md`（4.4）和页面补充稿 `docs/superpowers/specs/2026-10-21-progress-list-page.md`（LR-56）。Router 的 `GET /dashboard/progress` 和 `progress-board.json` 的 `token`、`boards` 归 impl。最早的「进度」是嵌 Vikunja 看板的 iframe（`docs/superpowers/specs/2026-10-21-progress-tab.md`），已经换成这张待办表。

- 左栏标题行下面单独一行「问答｜进度」，选中的那项下面有一道线。在「进度」时点左栏的某条问答或「新问答」，会自动回到「问答」。窄屏（≤680px）内容区在列表下面，点「进度」时页面滚到那里。
- 头一行：「数据来自 Vikunja，<相对时间>更新 · 刷新 · 在 Vikunja 里打开看板 ↗」。读的过程中写「正在读取…」；请求失败写「待办表没读到：原因」，下面照旧是上一份；没配置 `token` 写「待办表还没配置：在 ~/.lane-router/progress-board.json 加 token（Vikunja 只读 API 令牌），写好以后再点一次「进度」。」看板链接取启动时从 `/dashboard/state` 读到的 `progressBoard.url`（没有就不显示；进「进度」时还没有，就再读一次）。
- 读取：切到「进度」时，还没有数据、上一份超过 60 秒、或者上次是「没配置」，才 `GET /dashboard/progress`；「刷新」带 `?fresh=1`；不轮询，页面启动不读，同一时间只发一个。用单独的 `fetch`，不动页面的 `actionToken`。
- 最上面「等你决定」：所有看板里这一列的卡，按更新时间从新到旧，不分 lane；每行有负责 lane。原来每行还有一个「去问答 ↩」按钮，标题能点以后去掉了。
- 下面按看板分组（只有一个看板时不显示看板标题），看板里按负责 lane 的地址排序，没定负责 lane 的放最后；每条 lane 依次是「正在做」「做完待部署」「已上线」（只列 7 天内的）和其他列，空的不显示。某个看板读失败时，这一组最上面写「Vikunja 没读到：原因（时刻），下面是上一份数据」。每个看板末尾「搁置 N 件」默认收起。
- 每行：卡号（新窗口开 Vikunja 里的卡）· 标题（按文字写入）· 来源问答（走问答链接，显示前 8 位和标题）· 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / M/D，悬停是完整时间；Vikunja 没给时间的卡不写时间、排在最后、也不算 7 天内上线）。lane 名可以点，左栏变成「只看 <lane>」，标签页留在「进度」。
- 标题：卡上有来源问答时，标题本身就是跳转，点了在本页打开那条问答。它是虚线下划线的链接，悬停变蓝，和卡号（蓝色、开新窗口去 Vikunja）区分开。悬停时，Router 认得这条问答就显示它的标题，认不得写「打开来源问答」。没有来源问答的卡，标题是纯文字。来源问答的短 id 照旧留着。这一条是用户 16:23 在 `c5c595d9` 提的：短 id 那个链接他没注意到。
- 长标题：在卡号旁边自己折行，lane、来源问答、时间跟在标题后面，放不下就换到下一行。以前标题一长，整段会掉到卡号下面那一行，看起来像两条（inbox 16:20 在线核对时发现，LR-32、LR-24、LR-54 都是这样）。
- 历史记录：每条记录记着当时在哪个标签页，所以从「进度」点标题打开问答再后退，回到的是「进度」。

自动测试：
- `tests/modules/issues/progress-list.test.ts`（happy-dom，两个 dashboard 路由用替身，时间固定）覆盖页面补充稿验收第 1–9 条。
- `tests/modules/issues/progress-list-browser.test.ts`（浏览器组）覆盖第 10 条：真 Edge、和 `main.ts` 一样接起来的 Router（夹具里加了真的 `ProgressFeed`，问答 id 用 UUID，和 Router 一样），`progress-board.json` 指向本机一个只认那枚令牌的 Vikunja 替身。核对：
  - 表出来了，`done` 的卡不出现，令牌不出现在 `/dashboard/state` 和 `/dashboard/progress` 里；
  - 卡号开新窗口，点标题切到问答、后退回到「进度」；
  - 1280 宽下，一条折成好几行的长标题，第一个字和卡号的 `top` 相同；
  - 1280 / 999 / 681 / 390 四个宽度没有横向滚动，标题行和标签行都是一行。
- `tests/modules/issues/progress-list.test.ts` 第 2 条改写了：「去问答」按钮换成了点标题，并加上悬停文字（认得的问答写标题，认不得写「打开来源问答」）、没有来源问答的标题不可点；第 9 条加了一句「能点的标题也按文字写入」。
- `tests/modules/issues/progress-tab.test.ts`：只针对 iframe 的三条改写了（看板链接代替 iframe），「去问答」那条去掉了 iframe 的断言；`progress-tab-browser.test.ts` 删掉，由上面那条浏览器用例代替。
- 页面补充稿第五节的十一个变异都让 happy-dom 用例变红；「出错时丢掉快照」两条路（看板出错、整个请求失败）各试了一次。「未配置时也渲染表」：没配置时 `boards` 本来就是空的，表画不出东西，所以试的是把配置说明换成「数据来自 Vikunja」那行。另外「卡号不开新窗口」「后退不回进度」两个变异也让浏览器组那条变红。
- 点标题时页面自己切过去，不让链接整页刷新：happy-dom 第 2 条断言点击事件 `defaultPrevented`；浏览器组点之前在 `window` 上放一个标记，点完它还在。这是 inbox 验收 LR-59 时补变异发现的缺口：去掉 `preventDefault`，原来的两条照样通过。现在这个变异让两条都变红。
- 标题可点和长标题这一批：「标题不可点」让 happy-dom 第 2、9 条和浏览器组那条变红；「点标题不进历史」「悬停不写问答标题」「能点的标题按 HTML 写入」各让一条 happy-dom 用例变红；「去掉 `.todo-title` 的 `flex: 1 1 16em`」让浏览器组那条变红。

#### TC-ISSUES-TODO-1：在真实问答页上看待办表（第 1 步 inbox 在线核对过；标题可点和长标题折行等这一批上线；第 2–4 步留给用户）

**前提：** 含此改动的版本已部署；vikunja/main 已经把只读令牌写进 `~/.lane-router/progress-board.json`。

1. 打开问答页，点「进度」。
2. 点一张卡的卡号，再点「等你决定」里某张卡的标题，然后按浏览器的后退。
3. 点一个 lane 名。
4. 在 Vikunja 里挪一张卡，回问答页点「刷新」。

**预期：**
- 第 1 步：表按 lane 分好，「等你决定」在最上面，头一行写着几分钟前更新。标题长的卡，卡号和标题开头在同一行。
- 第 2 步：卡在新窗口打开；点标题打开那条问答，后退回到「进度」。
- 第 3 步：左栏只剩这个 lane 的问答，标签页还在「进度」。
- 第 4 步：表里那张卡换到新的段里。

**inbox 在线核对（2026-10-21 16:20，`http://127.0.0.1:52817`，部署的是 master `be74914`；无头 Edge，只看不点）：通过。**
- 头一行写「数据来自 Vikunja，刚刚更新」，「在 Vikunja 里打开看板」的链接指向 `http://localhost:3456/projects/12/48`。
- 「等你决定」2 张：LR-33、LR-34，都带「去问答 ↩」（这个按钮这一批去掉了，改成点标题）。
- 4 条 lane：design 正在做 2、已上线 6；impl 正在做 1、已上线 7；inbox 正在做 2、已上线 12；kb 已上线 1。
- 「搁置 13 件」折起来了；没有看板出错的那一行。
- 卡号链接是 `http://localhost:3456/tasks/<id>`，在新窗口打开。
- 来源问答 35 个都升级成了问答链接，没有剩下的候选。
- 999、681、390 三档宽度都没有横向滚动；页面没有报错。
- 发现一处毛病：标题长的几行（LR-32、LR-24、LR-54），卡号单独占一行，标题整段掉到下一行，看起来像两条。这一批已经改了，上面「长标题」那条就是。

#### TC-ISSUES-GROUP-1：在真实问答页上按项目看（第 1 步部署后已核对，第 2–4 步尚未执行）

**前提：** 主检出构建到含此改动的版本，并重启 Router。重启和构建的时机都归用户。

1. 打开问答页，选「全部」，看左栏。
2. 折叠一个项目的组，刷新页面，再切到「进行中」。
3. 在下拉框里选一个项目，刷新页面。
4. 选着这个项目时，新开一条问答发给另一个项目的 lane。

**预期：**
- 第 1 步：问答按项目分组，最近有动静的项目排在上面；组头的条数和待我处理数与各项目的实际情况对得上。
- 第 2 步：刷新后、换筛选后，这一组都还是折叠的。
- 第 3 步：左栏只剩这个项目的问答；刷新后下拉框仍选着它。
- 第 4 步：发出后下拉框回到「全部项目」，页面打开新的那条，它所在的组是展开的。

#### 部署后核对：分组、切号按钮、进度标签页、删半句（2026-10-21 12:53，inbox 执行，通过）

master `33e5ff3` 部署后，Router 在 `http://127.0.0.1:60690`。接口用 PowerShell 查；页面用无头 Edge 打开线上页，只看不改：不选议题，不按「继续」按钮。

- **接口：**
  - `GET /issues/api/projects?filter=all` 返回 10 个项目，条数和「待我处理」数都对，比如 lane-router 45/9；返回里带 `actionToken`。`filter=attention` 只有 7 个项目的 count 大于 0。
  - `threads?filter=all&project=lane-router` 返回 45 条，所属项目全是 lane-router；`project=bad/x` 返回 400。
  - `/dashboard/state.progressBoard` 是 `{"url":"http://localhost:3456/projects/12/48"}`。
  - 页面 HTML 里已经没有 `CLAUDE_NUDGE`，也没有「点完它要是没动」。
- **页面（1280×800）：**
  - 分组：待我处理下 7 组，全部下 10 组。组头显示「N 条」和「待我处理 M」，M 为 0 的不显示。组的先后按最新一条：mocap 最新，排第一。
  - 项目筛选：下拉框 11 项，第一项是「全部项目」，有待我处理的项目写「· 待我处理 M」。
  - 切号按钮：「继续 Claude lane」「继续 Codex lane」都在，可点。没有按：真机按下的效果留给切号后继续稿的验收第 9 条，和用户一起做。
  - 进度标签页：点「进度」后 iframe 的 `src` 是看板地址，「在新窗口打开」指向同一地址，iframe 高 748px。8 秒后 iframe 里是 Vikunja 的登录页，因为无头浏览器没登录；Vikunja 的响应头里没有 `X-Frame-Options`，也没有 CSP，能正常嵌入。切回「问答」后 iframe 还在 DOM 里，只是隐藏。
  - 布局：999、681、390 三档宽度下都没有横向滚动，标题行 33px、标签行 27px，都只占一行。
  - 页面报错 0 条。
- **留给用户：** 在已登录 Vikunja 的浏览器里，进度标签页能看到看板、能拖卡。结果贴在问答 `c5c595d9`，由用户关。

### 问答记下自己配的卡：`task`（问答库 v5）

需求与设计见 `docs/superpowers/specs/2026-10-21-issue-task-ref.md`（Vikunja LR-59），规则来自待办表稿第十节：一张卡配一条干活问答，一条问答最多一张卡。

- **问答库 v5：** `issue_thread` 加 `task_ref`，同一个卡号只能挂在一条问答上，由唯一索引兜底，卡号为空的不限。升级前留 `.v4.bak`，旧问答都没有卡。
- **lane 怎么设：**
  - `lane_issue_publish` 可以带 `task`；
  - `lane_issue_update` 的 `set_task` 用来设卡号，`task` 传 null 是清掉；
  - 卡号格式是大写字母开头、横线、数字，最长 32 个字符，不合格式返回 `INVALID_INPUT`。
- **一对一：**
  - 已有卡再设另一张，返回 `TASK_ALREADY_SET`，要先清成 null；
  - 卡被别的问答占着，返回 `TASK_TAKEN`，信息里写出那条问答的 id；
  - 设同一张卡不算改动，不写记录。
- **权限：** 只有所属 lane 能设；问答结束后不能设。每次设或清，都写一条系统记录：「lane 配上卡 LR-56」或「lane 去掉卡 LR-56」。
- **发问答时带卡：** 不另写记录，因为问答一建好就带着这张卡。卡被占用时整个发布失败，不会建出问答。
- **读出：** 详情、列表、`lane_issue_read` 都带 `task`。CLI 的 JSON 文件里加同名字段。工具说明里写了用法，开局说明 `ISSUE_INSTRUCTIONS` 没动。
- **页面：**
  - 标题下面那行在短 id 前面写「LR-56 · 正在做」：卡号是开 Vikunja 卡的链接，在新窗口打开；后面是卡在待办表快照里所在的列。
  - 打开带卡号的问答时，读法和「进度」一样：没有快照或快照超过 60 秒就读一次，60 秒内再开别的不重读。
  - 读失败、卡不在看板上，就只写卡号。别的项目的卡（如 `MCN-7`）只写文字，不做链接，但能从快照里找到列名。
  - 左栏的列表项在标题前面加一个卡号徽标，纯文字。

自动测试：
- `tests/modules/issues/schema-upgrade.test.ts`：
  - v4 升 v5 只留 `.v4.bak`，行不变，`task_ref` 全是 NULL；v1 升上来只留 `.v1.bak`；
  - 新库和从 v1–v4 升上来的结构一致；
  - 改过结构的 v4 和冒充 v4 的 v3 原样拒收；
  - 库本身拒绝两条问答挂同一张卡。
  - v4 的升级语句冻结在 `tests/fixtures/issues/v4-from-v3.sql`。
- `tests/modules/issues/task-ref.test.ts`：格式、一对一、权限与状态、读出和工具 schema（稿子第三节第 2–5 条）。
- `tests/modules/issues/cli.test.ts` 加了一条：CLI 发布时带卡，再用 update 设卡、清卡，卡被占用时错误码照原样带出来。
- `tests/modules/issues/task-ref-page.test.ts`（happy-dom）：标题旁的卡号与列、左栏徽标、读快照不动 `actionToken`（第 6–8 条）。
- `tests/tools/flat-root-schema.test.ts`：`action` 的取值加了 `set_task`。
- 变异：
  - 去掉唯一索引、服务层也不查 → 第 3 条和 CLI 那条红；只去掉其中一个，也各有用例红；
  - 允许直接换成第二张卡 → 第 3 条红；
  - 别的 lane 也能设 → 第 4 条红；
  - 升级时给旧行补卡号 → v4、v1 两条升级用例红；
  - 没有快照也写列名、写成 `kind`、拿到别的卡的列 → 第 6 条红；
  - 每次打开都带 `fresh` 重读、打开时从不读 → 第 6 条红；
  - 不显示徽标 → 第 7 条红；
  - 别的项目的卡也做成链接 → 第 6 条红；
  - 读快照时拿走 `actionToken` → 第 8 条和待办表第 1 条红。

#### TC-ISSUES-TASK-1：真 lane 给问答配卡（尚未执行）

**前提：** 含此改动的版本已部署：build、备份问答库后 `restart-router.ps1 -CodexHost`，问答库升到 v5、留下 `.v4.bak`。Claude lane 要关窗口重开（`lane-router-lane open`），才看得到新参数。

1. 让一条 lane 用 `lane_issue_publish` 发一条问答，带上它这件活的卡号。
2. 打开问答页，看左栏这一条和它的详情。
3. 让 lane 对另一条已有卡的问答再设一张别的卡；再让它先设 null，再设新卡。
4. 用 Codex lane 的 CLI（`lane-router-lane issue update --json-file`）设一次卡。

**预期：**
- 第 2 步：左栏这条有卡号徽标；详情标题下面写「卡号 · 所在列」，点卡号在新窗口打开 Vikunja 里那张卡。
- 第 3 步：直接换卡返回 `TASK_ALREADY_SET`；先清后设成功，历史里有「lane 去掉卡」「lane 配上卡」两条系统记录。
- 第 4 步：和 MCP 工具一样生效。

### 问答页易用性（第一批）：引用能跳转、短 id 能复制、回复框把手

需求与设计见 `docs/superpowers/specs/2026-10-21-issue-page-usability.md`（第一到三节）。

- **问答 id 变链接：** 条目正文里的完整 id，以及独立成词的 8 位十六进制，先当候选；Router 的 `GET /issues/api/resolve?refs=` 确认它正好是一条问答，才变成链接，后面用浅色小字跟上「（标题）」，标题超过 24 个字截短。范围和本机路径一样：普通文字和行内代码认，代码块和已有链接不认；lane 写的和用户写的都认。
  - 一次渲染只发一次查询，同一个 id 这一页里只查一次；查询失败不记，下次渲染再查，页面不报错。
  - 普通点击在本页打开那一条，地址栏变成 `?issue=<完整 id>`，「后退」能回来；按着 Ctrl / Shift / ⌘ 点、用中键点，交给浏览器开新标签。
  - 在列表里点选某条，地址栏换成它，不加历史记录；打开新问答时地址栏去掉 `issue`。
  - `/issues?issue=<完整 id 或前 8 位>` 直接打开那一条；前 8 位查到后地址栏换成完整 id，查不到就在详情区写「没找到问答 <原文>」。
- **复制：** 详情标题下那行的短 id 后面有个「复制」，复制完整 id；成功写「已复制」，没有剪贴板或被拒写「复制失败」，下次打开这条变回「复制」。
- **回复框把手（宽屏）：** 回复框上边缘有一条横向把手，往上拖加高、往下拖减低，最矮两行，最高窗口的 60%；聚焦后按 ↑/↓ 每次一行，双击复位。拖出来的高度存在浏览器里（`lane-router.issues.reply-height`），每条问答都用它；拖过的回复框不再被「用着时撑到六行」的规则改高度。窄屏（≤680px）不显示把手，回复框照旧用右下角自带的把手。
- 后端只加了 resolve 一个只读接口，返回带 `actionToken`；lane 工具不变。服务层的方法叫 `resolveRefs`：`IssuesService` 里原本已有一个处理问题状态的私有 `resolve`。

自动测试：
- `tests/modules/issues/resolve.test.ts`（node 组）覆盖第一批验收第 1 条，固定 id 造了两条前 8 位相同的问答。
- `tests/modules/issues/issue-links.test.ts`（happy-dom）覆盖第 2–5 条。happy-dom 有一处和浏览器不同：`back()` 之后再 `replaceState` 会丢掉前进的记录，所以用例先比列表点选的历史条数，再按后退。
- `tests/modules/issues/reply-handle.test.ts`（happy-dom）覆盖第 6 条里能离开排版来测的部分：高度怎么变、上下限、存储、键盘、双击。happy-dom 不排版，量不出初始高度，所以比的是拖动前后的差。
- `tests/modules/issues/usability-browser.test.ts`（浏览器组）覆盖第 7 条，以及第 6 条里要真排版的部分：真 Edge 里点前 8 位的链接切过去、后退回来；往上拖 100px，回复框高 100px、上边缘上移 100px、发送按钮不动；聚焦后高度不变；窄屏下把手隐藏、回复框是 `resize: vertical`。
- 第一批变异检验八项都让预定的用例变红，每项改完都还原并核对：不经确认就把所有 8 位变链接、代码块也认（各让第 2 条红）；点击不 `preventDefault` 也不 `pushState`（第 3 条红，浏览器组那条也红）；不读 `issue` 参数（第 4 条红）；复制的是前 8 位（第 5 条红）；拖动方向反了（第 6 条和浏览器组那条红）；不存高度（第 6 条红）；resolve 不带 `actionToken`（第 1 条红）。

#### TC-ISSUES-USABILITY-1：在真实问答页上跳转、复制、拖回复框（尚未执行）

**前提：** 主检出构建到含此改动的版本，并重启 Router。

1. 打开一条正文里写着别的问答前 8 位的问答，点那个链接，再按浏览器的后退。
2. 把地址栏改成 `/issues?issue=<某条问答的前 8 位>` 打开。
3. 在详情标题下点「复制」，把剪贴板内容贴到别处看。
4. 在宽屏下拖回复框上边缘的把手往上，刷新页面，再换一条问答；最后双击把手。

**预期：**
- 第 1 步：链接后面有那条问答的标题；点了在本页打开它，地址栏是完整 id；后退回到原来那条。
- 第 2 步：打开那一条，地址栏换成完整 id。
- 第 3 步：贴出来的是完整 id，按钮写「已复制」。
- 第 4 步：回复框往上长，发送按钮不动；刷新、换问答后高度不变；双击回到默认高度。

### 问答页易用性（第二批）：画 mermaid 图、LR-n 链到 Vikunja 卡、lane 地址筛选

需求与设计见 `docs/superpowers/specs/2026-10-21-issue-page-usability.md`（第四到六节）。

- **mermaid 图：**
  - lane 写的正文里，信息串去掉首尾空白、不分大小写正好是 `mermaid` 的代码块，画成图，图下面折着「源码」，展开就是原来的代码块，带「复制」。用户写的仍是纯文本，不画。
  - 渲染库是 `mermaid` 12.1.0（2026-10-02 发布，写死版本号）。由 Router 从本机的 `GET /issues/assets/mermaid.js` 提供，不走外网；某页第一次有图时才插这个脚本，整页只插一次，没有图就不加载。初始化一次：`startOnLoad: false`，`securityLevel: "strict"`，主题跟着系统的深浅色。
  - 画不出来（语法错，或者脚本没加载上）就保留代码块，在上面写一行「图没画出来：原因」。
  - 点图打开覆盖全页的放大层，按原始大小显示，可以滚动；按 Esc 或点外面关掉。5 秒轮询不重画。
  - **上线要多一步：** 加了依赖，部署时先在主检出 `npm install`，再 build，再重启核心。不要用 `npm ci`，原因见共享树的老规矩。
  - 实测：mermaid 12 在任何安全级别下都会用 DOMPurify 清洗标签文字，`click` 只有调用方调 `bindFunctions` 才会绑定，而页面从不调。所以「标签里的 HTML 不执行、点节点不调用页面函数」这两条，换成 `loose` 也成立，没法用来区分安全级别；`strict` 由 happy-dom 那条用例直接核对 `initialize` 的参数。
- **LR-n：** 正文和行内代码里独立成词的 `LR-` 加数字，链到 `<Vikunja 根地址>/projects/LR/tasks/by-index/<n>`，新标签页打开，悬停写「在 Vikunja 里打开 LR-<n>」。`UTF-8`、`SHA-256`、`XLR-3`、`LR-39a`、代码块里的都不变。Vikunja 根地址取进度板地址的 origin。
  - 进度板地址现在**页面一启动就读一次** `/dashboard/state`（单独的 `fetch`，不动页面的 `actionToken`），进度标签页和 LR-n 共用。读到 `null` 或读失败，LR-n 就是文字；之后每次点「进度」都重读，读到了就把已经显示的条目补成链接。进度稿 4.2 原来写的是「第一次切到进度才读」，这里按易用性稿第五节改了，相应的用例也改了。
- **lane 地址筛选：**
  - 正文和行内代码里独立成词的 `<项目>/<lane>`（两段都符合地址规则，句末的点不算），以及详情标题下的所属 lane，Router 确认有过这个地址的 lane（归档的也算）才能点。
  - 点了，项目下拉框下面出现「只看 <地址> ✕」，项目筛选自动换成这个地址的项目，列表只列这个地址名下所有 lane（现在的和归档的）的问答。点 ✕ 或换项目就去掉；不存进浏览器，刷新后没有。
  - 这时组头只写「已显示 K 条」：项目的条数和「待我处理」数不是这个 lane 的。
  - 后端：列表接口加 `lane` 参数；resolve 接口加 `lanes`，返回 `{ items, lanes: [{ address, project }] }`，`refs` 和 `lanes` 至少给一个。页面一次渲染把问答 id 和 lane 地址合在一次 resolve 里查。lane 工具不变。

自动测试：
- `tests/modules/issues/mermaid-asset.test.ts`（node 组）：版本写死、路由返回打包文件（第二批验收第 1 条）。
- `tests/modules/issues/mermaid-page.test.ts`（happy-dom，`window.mermaid` 用替身，happy-dom 不真去取脚本）：第 2 条。
- `tests/modules/issues/mermaid-browser.test.ts`（浏览器组，真库）：第 3 条，流程图画成 SVG、标签里的 `<img onerror>` 不执行、点节点不调用页面函数、点图放大、Esc 关掉。
- `tests/modules/issues/card-links.test.ts`（happy-dom）：第 4 条。
- `tests/modules/issues/lane-filter.test.ts`（node 组）：第 5 条。
- `tests/modules/issues/lane-links.test.ts`（happy-dom）：第 6 条。
- 第二批变异检验：用户写的也画、每张图插一次脚本、认 `[A-Z]+-\d+`、把 `LR` 换成 12、列表忽略 `lane`、lane 筛选存进浏览器，各让预定的用例变红。`securityLevel` 改成 `loose` 让 happy-dom 那条变红，浏览器那条不红，原因见上面的实测。

#### TC-ISSUES-USABILITY-2：在真实问答页上看图、点卡号、按 lane 筛（尚未执行）

**前提：** 主检出 `npm install` 后构建到含此改动的版本，并重启 Router；进度板已配置。

1. 找一条 lane 写了 mermaid 代码块的问答打开，点图，再按 Esc。
2. 在一条提到 `LR-<n>` 的问答里点卡号。
3. 点详情标题下的所属 lane，再点 ✕。

**预期：**
- 第 1 步：图画出来，下面有「源码」；点图放大，Esc 关掉。
- 第 2 步：新标签页打开 Vikunja 里的那张卡。
- 第 3 步：左栏出现「只看 <地址> ✕」，只剩这个 lane 的问答，项目下拉框跟着变；点 ✕ 后恢复。

### 归档横幅：所属 lane 已归档的问答说清追问去哪

需求与设计见 `docs/superpowers/specs/2026-10-21-task-lane.md`（4.3 第 5 条、验收 9）。核心那一半（`lane_finish` 时解析父议题和父 lane、`LaneAccessFacts` 的 `finishedAt` 和 `task`）归 impl。

- 问答的 `owner` 多两个字段：`finishedAt` 和 `task: { issue, parent }`。核心只对已完成或已归档的 lane 给出这两个键，没给时页面一律当 `null`；lane 不存在也是 `null`。
- 所属 lane 已归档时，回复区上面显示一条横幅：
  - 任务 lane，有父议题：「该任务 lane 已完成归档；追问请到父 lane 的议题 <前 8 位>，或让父 lane 再开一条任务 lane」。议题号可以点，在本页打开那一条，地址栏跟着变，后退能回来。
  - 任务 lane，只有父 lane：「该任务 lane 已完成归档；请联系 <父 lane>」。
  - 任务 lane，两个都没有：「该任务 lane 已完成归档」。
  - 不是任务 lane：「所属 lane 已归档，不能在这里回复了；要接着谈，请新开问答发给别的 lane」。
- 这几种情况下，回复框、回复对象、添加文件、发送都不能用；「结束议题」照常可点。完成了但还没归档的任务 lane 不显示横幅。

自动测试：`tests/modules/issues/archived-banner.test.ts`（node 组和 happy-dom）：owner 透传两个字段、四种横幅、回复区禁用、父议题链接能打开。变异「没归档的也显示横幅」「回复框不禁用」各让一条用例变红。

#### TC-ISSUES-BANNER-1：真实的任务 lane 归档后看它的问答（尚未执行）

**前提：** 含此改动的版本已部署，并有一条照任务 lane 收尾流程 `lane_finish` 后已归档的任务 lane，它名下有问答。

1. 在问答页打开它名下的一条问答。
2. 点横幅里的父议题号，再按浏览器的后退。

**预期：** 横幅写着父议题号；回复框不能用，「结束议题」能点；点议题号打开父议题，后退回到原来那条。

### 回复对象：空着时自动选上新来的问题

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-reply-target-adopt.md`。

- 原来回复对象只在打开议题和发送成功后重新计算。现在多一条：回复对象是页面自己算出来的空、回复框里也没有内容时，轮询带来新的「待我回答」问题，就自动选上最新的那个。
- 下面几种情况不动回复对象：
  - 用户在下拉框里手动选过回复对象，包括「继续讨论（不指定问题）」。重新打开议题或发送成功后，这个标记清掉。
  - 回复框里有字，包括从浏览器草稿恢复的字。这时回复对象旁边显示「有新问题 #N 等你回答，可以在回复对象里选它」。用户选了回复对象、发送成功或清空回复框，提示就消失；清空后，下一次轮询按上一条自动选上。
  - 有回复正在保存或结果未定时，也不显示这行提示，因为那时下拉框不能改。

自动测试：`tests/modules/issues/reply-target.test.ts`（happy-dom）覆盖设计稿第四节第 1–5 条。第五节的四个变异各自让预定的用例变红。

### 用户写的内容按纯文本显示

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-user-text-plain.md`。

- 作者是用户的条目，正文按纯文本显示，不经过 Markdown：页面回复、新问答的正文、lane 记录的 TUI 原话（`originalQuestion` 和 `tui_user`）。`*`、`#`、反引号、`<b>` 这些都照原样显示，换行、连续空格和行首空格也保留。
- 纯文本里的本机路径照样能点开。路径要写成不含空格的样子。用反引号包起来也行：结尾的反引号和句末标点一样留在链接外面。代价是以反引号结尾的文件名点不开。
- lane 写的条目和系统记录不变。存储、接口和投递给 lane 的正文都不变。Markdown 组件加载失败时，所有条目照旧按原文显示。

自动测试：
- `tests/modules/issues/ui.test.ts` 的「plain text 1–5」和改写过的「Markdown replies are sent and stored verbatim…」，覆盖设计稿第五节第 1–5、7 条。
- `tests/modules/issues/path-links-browser.test.ts` 新增一条，覆盖第 6 条；用户回复里的路径用反引号包着。
- 第六节的五个变异各自让预定的用例变红。

### lane 结束问答、回复即重开、默认发问答

需求与设计见 `docs/superpowers/specs/2026-10-20-issue-lane-close-and-default-publish.md`。

- **lane 结束：** `lane_issue_update` 的 `close`，带 `reason`。
  - 议题里有问题在等用户（`waiting_user`）或等 lane（`waiting_lane`）时，拒绝，错误码 `QUESTIONS_WAITING`，信息里写明先答复或标成 `not_needed`。被拒时什么都不写。
  - 成功时写一条系统记录「lane 结束：原因」，作者是 lane，议题记为 lane 结束的。
- **回复即重开：** 用户回复已结束的议题，不管是谁结束的，都会重开它。
  - 历史先多一条「用户回复，议题重新打开」，再是回复本身。
  - lane 收到的信开头写「这条问答原先已结束（由 lane / 用户结束），用户的回复让它重新打开了。」
  - lane 对已结束的议题仍然不能追加、了结问题或再结束；`record_processed` 和已读照旧允许。
- **记下结束方：** 议题多一个 `closedBy`，取值 `user` 或 `lane`，开着时为空。页面结束和 `record_tui_close` 记 `user`。列表、详情和 `lane_issue_read` 都返回它。
- **待我处理：** lane 结束、但还有用户没读过的 lane 内容的议题，留在「待我处理」，原因是「未读答复」，读完就离开。用户结束的照旧不进。
- **页面：**
  - 列表徽标：lane 结束的写「lane 已结束」，用户结束的写「已结束」。
  - 详情元信息：「已结束（lane 结束的）」或「已结束（你结束的）」。
  - 已结束的议题照样有回复框，上方写「这条问答已经结束（由 lane / 你结束）。回复会重新打开它。」。「结束议题」按钮仍然隐藏。
- **说明：** 问答模块导出 `ISSUE_INSTRUCTIONS`。工具目录带上问答工具时，把它接在 Lane Router 原有说明后面；只有通信工具的目录不带。Claude 从 MCP 的 `instructions` 拿到它，Codex 从 `developerInstructions` 拿到它，两边是同一段字符串。
- **问答库升到 v2：** 打开 v1 库时，先用 SQLite 的 `VACUUM INTO` 把它复制成同目录的 `issues.sqlite.v1.bak`，再在一个事务里加 `closed_by` 列，并把已结束的议题回填为 `user`。
  - 复制会带上 WAL 里还没写回主文件的内容。
  - 备份文件已经存在时不覆盖，复制失败就不升级，问答模块按不可用处理。
  - 回退方法见下面「停止、恢复、备份与回退」。

自动测试：
- `tests/modules/issues/lane-close.test.ts`：第五节第 1–4、6 条。
- `tests/modules/issues/schema-upgrade.test.ts`：第 5 条。v1 夹具是冻结的 `tests/fixtures/issues/v1-schema.sql`，和改动前代码建出的库逐项比对过，完全一致。
- `tests/tools/issue-lane-close-contract.test.ts`：第 7、8 条。
- `tests/modules/issues/lane-close-browser.test.ts`：第 9 条，浏览器组。
- 第六节的十个变异各自让预定的用例变红。
- 旧规则改写的已有用例：`lifecycle.test.ts`、`http.test.ts`、`tests/e2e/issue-inbox.test.ts` 原来断言回复已结束议题报 `ISSUE_CLOSED`，现在断言议题重开。`ui.test.ts` 有两条原来断言结束后回复框消失，现在断言回复框还在、显示重开提示。

#### TC-ISSUES-LANECLOSE-1：lane 结束自己的议题，用户回复让它重开（第 10 条，尚未执行）

**前提：**
- 主检出构建到含此改动的版本，并连 Codex 宿主一起重启 Router（`scripts/restart-router.ps1 -CodexHost`，由 design 执行）。重启会断开开着的 Codex 窗口，时机归用户。
- 上线时确认数据目录里生成了 `issues.sqlite.v1.bak`。
- 正在跑的 lane 要等下次开新会话或恢复，才拿到新的工具和说明。Claude lane 在 MCP 服务启动时拿到，Codex lane 在 thread 启动或恢复时拿到。

1. `lane-router/inbox` 开新会话或重连 MCP 后，用 `close` 结束自己那七条早已做完的议题，每条写明原因。
2. 用户在问答页「已结束」里看这七条。
3. 用户在其中一条里回复。

**预期：**
- 第 1 步：每条都成功；历史里多一条「lane 结束：原因」。
- 第 2 步：七条都显示「lane 已结束」。
- 第 3 步：议题回到「进行中」；inbox 收到信，信里有「原先已结束」那句。

### 四项议题工具

工具调用身份取自当前已绑定会话，只能读取或修改本 lane 的议题；不用参数指定 owner、backend、generation、source 或 `confirmed`。业务写入均使用非空 `operationKey`；同一操作重试保持同键同内容，同键异内容返回 `OPERATION_CONFLICT`。RPC call ID 不是业务操作键。

| 工具 | 参数与用途 |
|---|---|
| `lane_issue_publish` | `operationKey`、`title`、`kind`、`body`。`kind: "answer"` 必须另带 `originalQuestion`；`kind: "question"` 不带该字段。只发布两类议题。 |
| `lane_issue_read` | 详情使用 `issueId`，可加 `afterSeq`、`limit`；列表不带 `issueId`，可加 `filter`（`attention/open/closed/all`）、`before: {updatedAt,id}`、`limit`，agent 列表默认 `all`。分页上限 200，默认 50。读取不代用户标已读。 |
| `lane_issue_append` | `operationKey`、`issueId`、`kind`、`body`，可带 `questionId`。`kind` 为 `answer/explanation/question/tui_user`；`explanation` 必须关联问题，新增 `question` 不带旧问题 ID。带 `questionId` 的 `answer`，会把正在等待本 lane 的那个问题标为已回答（与 `resolve_question` 留下同样的系统记录）；不想结束这个问题就不带 `questionId`。相关 TUI 用户原话用 `tui_user`，注明来源、原样保存，不产生回声投递。 |
| `lane_issue_update` | 公共参数为 `operationKey`、`issueId`、`action`。`resolve_question` 另带 `questionId`，`status: "answered"` 需 `answerEntryId`，`status: "not_needed"` 需 `reason`；`record_processed` 另带 `deliveryId`；`close` 另带 `reason`，由 lane 结束议题，议题里不能有等待中的问题；专门的 `record_tui_close` 另带用户实际结束原话 `body`。没有任意状态更新。 |

agent 收到 mailbox 提醒后先读完整正文，使用其中的 `issueId` 调 `lane_issue_read`，查询 `deliveryId` 的处理事实后在原任务内处理。处理完后用 `lane_issue_append`（`kind: answer`，带正文里给出的问题 ID）答复，该问题自动标为已回答；再用 `record_processed` 记录该投递，最后用原 `lane_ack` resolve 邮件。网页回复的投递正文末尾写着这三步和要带的 ID。重复提醒不等于允许重复业务副作用；这些记录不保证外部业务副作用恰好一次。`resolve_question` 仍用于标「无需回答」，或补标历史上已经答过的问题。

#### TC-ISSUES-QUESTION-1：一问一答之后，「待我回答」「等待 lane」都清掉

需求与设计见 `docs/superpowers/specs/2026-10-19-issue-question-state-fix.md`。

**前提：** 共享 Router 换上含此修复的构建，页面也读到新版。服务部分要重启 Router 才生效，时机归用户。

1. 在一条真实议题上，让 lane 发一个提问。
2. 在问答页打开这个议题，不动「回复对象」，写回复并发送。
3. 让 lane 按投递正文里的下一步，带上问题 ID 用 `lane_issue_append`（`kind: answer`）答复。
4. 结束这个议题，切到「已结束」筛选。

**预期：**
- 第 2 步发送前，「回复对象」已经选中 lane 的那个问题；发送后列表显示「等待 lane」，不再显示「待我回答」，也没有多出新的问题记录。
- 第 3 步之后，列表上两个标记都没有，历史里多一条「问题 … 已回答」的系统记录。
- 第 4 步，已结束的议题不显示「等待 lane」。

**最后验证：** 2026-10-20 00:59 第 1–3 步通过，构建和 Router 同 TC-ISSUES-SCROLL-1，用的是 TC-ISSUES-READ-1 的同一个议题 `969f42f1`。
- 用户不动「回复对象」，回复「收到」。这条回复的 `relatedEntryId` 正是 lane 那个问题的提问条目，没有新建问题记录；议题状态为 `waiting_lane`，`waitingUserCount` 为 0。投递正文里带着「下一步」。
- `lane-router/inbox` 带 `questionId` 答复（seq 4）后，问题自动变成 `answered`，`answerEntryId` 就是这条答复，另有系统记录 seq 5。
- 第 4 步（结束议题后看「已结束」筛选）没有真机做。

TUI 中用户确实说要结束时才用 `record_tui_close`，不能把文件、资源文本或 agent 自己的总结当成用户结束指令。

### 旧 Codex 会话的 JSON 文件 CLI

新 Codex thread 的动态工具由启动时目录注入；已经存在的 thread 不假设能热刷新。旧会话可在原 Codex 进程中使用 `lane-router-lane issue <publish|read|append|update|record-tui-close> --json-file <path>`，经过同一 loopback RPC、工具解析与业务服务。身份只来自 `CODEX_THREAD_ID` 和当前 cwd；缺失或未绑定时拒绝，不手填其他会话身份。

用 agent 的普通文件编辑工具创建 UTF-8 文件 `issue-publish.json`（不要在 PowerShell 多行字符串中拼 JSON）：

```json
{
  "operationKey": "decision-20261018-1",
  "title": "需要确认方案",
  "kind": "question",
  "body": "请选择 A 或 B，并说明取舍。"
}
```

```powershell
lane-router-lane issue publish --json-file ./issue-publish.json
lane-router-lane issue read --json-file ./issue-read.json
lane-router-lane issue update --json-file ./issue-processed.json
lane-router-lane issue record-tui-close --json-file ./issue-tui-close.json
```

同样用普通编辑工具创建其余文件；把示例 ID 换成实际返回值：

```json
{"issueId":"<issueId>","afterSeq":0,"limit":50}
```

```json
{"operationKey":"processed-1","issueId":"<issueId>","action":"record_processed","deliveryId":"<deliveryId>"}
```

```json
{"operationKey":"tui-close-1","issueId":"<issueId>","body":"用户原话：这个议题结束。"}
```

`record-tui-close` 文件不带 `action`，专门 verb 自己选择该操作；普通 `update` 则按工具契约填写 `action`。保留成功结果和原操作文件，结果未知时用原文件、原键重试，不创建新键猜测重发。

### HTTP、结果未知与历史

`GET /issues` 返回页面。以下 API 的成功读响应为 `{result, actionToken}`，成功写响应为 `{result}`：

| 请求 | 参数 |
|---|---|
| `GET /issues/api/threads` | `filter` 默认 `attention`，可选 `limit`；下一页同时带 `beforeUpdatedAt`、`beforeId`。 |
| `GET /issues/api/threads/:id` | 可选 `afterSeq`、`limit`；详情给出 `displayedThroughSeq` 与 `hasMore`。 |
| `POST /issues/api/threads/:id/replies` | `operationKey`、`body`，可选 `questionId`。 |
| `POST /issues/api/threads/:id/read` | `operationKey`、`throughSeq`，只推进实际展示过的边界。 |
| `POST /issues/api/threads/:id/close` | `operationKey`、`body`，记录用户明确结束。 |

写请求为 `application/json`，正文另带当前读响应的 `actionToken`；`Origin` 必须是当前 Router origin，`x-lane-router-action` 分别为 `issues-reply`、`issues-read`、`issues-close`。token 在进程重启后更新，先重新读取。没有网页 create、任意 target 或浏览器调用机器 `/rpc` 的入口；未知路径不消费正文，首版不扩 DSH/Native Host 白名单。

| HTTP / code | 含义与处理 |
|---|---|
| `400 INVALID_INPUT/INVALID_REFERENCE` | 参数、分页或关联有误；修正输入。JSON、类型、大小等协议错误也为 400，未必带业务 code。 |
| `403` | origin、action header 或 token 校验未通过；不能靠伪造身份绕过。 |
| `404 ISSUE_NOT_FOUND` | 议题不存在；模块从未装配时整个 `/issues` 入口为 404。 |
| `409 ISSUE_CLOSED/LANE_UNAVAILABLE/OPERATION_CONFLICT` | 已结束、原 lane 缺失/归档、或同键不同内容；读取历史和事实，不自动改挂同名 lane。 |
| `503 ISSUES_UNAVAILABLE` | 已装配模块无法打开或恢复，core 可继续用；保留故障库，由受控维护处理。 |
| `500`、超时、断线、缺失成功结果 | 结果可能已经保存，不能显示确定失败或自动新键发送；保留原键和原正文，重新 GET 历史，并在可用时同键显式重试。 |

页面的发送中/结果未知状态会冻结本次键和内容，切换议题不会把它改成另一份回复。关闭页面不取消已经保存的交接；页面没有浏览器持久投递队列。刷新或重开后以后端历史为准；若原键已不可得，先核对历史，不能直接新建键重发。已结束历史与每轮原文、关联、解决事件和处理事实均保留。

### 停止、恢复、备份与回退

实际路径以实现为准：`dataRoot/router.sqlite` 是 core，`dataRoot/issues.sqlite` 是模块（早期设计草稿的子目录路径不是当前路径）。模块在自己的 `issue_schema_version` 管版本，不改 core schema。默认独立产品显式装配模块；`runRouterProcess({issues:false})` 是进程内装配选项，**不是**现有持久配置或 CLI 热开关。

维护由外部具名操作对话核对准确运行入口、PID/版本、在用配置、备份位置和允许中断窗口后执行。**操作方须先让所有写入方停止提交新写入**，再发起受控关闭并等待完成；当前没有新增自动 stop-ingress 机制。`main` 的实际资源关闭顺序是先等模块 `close()` 停止调度、排空在途交接并关模块库，再关 HTTP server、Host/runtime 和 core 库；不能以该顺序代替前述停写入条件。恢复时在 core mailbox 对账后 `start()` 恢复待交接记录。临时停用通过受控生命周期重新装配通信-only 进程，恢复时重新显式装配；不删数据库、不后台热启第二份模块、不从本手册推断一个不存在的维护命令。

在停止写入并排空后，把两个 SQLite 数据库、相关 `-wal`/`-shm` 状态及 mailbox/core 数据作为**同一一致备份集**保存；若数据库已干净关闭且侧文件消失，记录该事实。不要在运行中随意复制单个主库文件，也不独立丢弃 WAL。恢复/回退前再保留当前一致集，使用同一备份集恢复两库和对应 mailbox/core 数据；回退构建与数据恢复是两个不同动作，不用旧代码强开未来模块版本。只恢复一库可能失去跨库关联：历史保留，原稳定 lane ID 缺失/归档时拒绝误投递，绝不自动改挂同名新 lane。本功能不新增通用 backup 工具。

**问答库版本升级的回退（v1 到 v2 起）：**
- 新版 Router 第一次打开旧版本的问答库时，先把它复制成同目录的 `issues.sqlite.v<旧版本>.bak`，比如 `issues.sqlite.v1.bak`，再原地升级到当前版本（现在是 v3）。
- 旧版 Router 不认新版本，会以 `Unsupported issues schema version` 拒绝打开，问答模块不可用。
- 要回退代码时：停 Router，用这个 `.bak` 换回 `issues.sqlite`，删掉旁边的 `-wal`、`-shm`，再启动旧版。
- **升级之后写入问答的内容都会丢失**，包括新议题、回复和结束记录。core 库和 mailbox 里对应的信还在，回退前要先确认能接受这一点。
- 回退到 v3 之前的版本时，`issue-attachments` 目录里的文件会留在磁盘上，旧版不认它们，需要的话手动删除。

### 议题功能现场验收（尚未执行）

隔离自动测试已验证真实服务/双库/mailbox、HTTP/RPC/CLI 与 fake backend 的业务往返，以及构建产物 HTML 的 DOM/HTTP 行为；它不证明真实模型、客户端工具刷新、浏览器视觉或在用部署。执行者应记录 candidate commit、构建 manifest、运行入口/内存版本、所选真实 lane、模型额度与中断窗口：

1. 在已批准窗口完成一致备份、受控部署和启动，先检查 core 与历史可读；不要按示例路径覆盖配置、DB 或 token。
2. 新 Codex thread 核对九项动态工具；旧 Codex thread 使用上述 CLI 同服务往返，不要求动态热刷新。Claude/ZCode 在外部受控刷新 MCP 后核对九项工具并真实发布、查询、补答、处理回执；各记录实际刷新方式与结果。
3. 真实浏览器打开 `/issues`，观察宽/窄屏列表与详情、文本可读和转义、分页、未读/待回答分离、问题关联、切换草稿、明确结束的取消/确认、关闭历史无回复入口。后台/隐藏期间新内容不标读，重新可见后只推进实际显示内容。
4. 真实用户发出多行回复，目标 lane 读完整 mailbox 与议题、处理并回执，网页新答复可见，用户结束；另核 busy/offline 保留和恢复。断线时核对结果未知、历史和同键重试不重复入箱。

当前没有真实浏览器视觉/用户交互验收记录（CUA 浏览器不可用）；HappyDOM 不能勾销此项。真实 Codex 新动态工具/旧 CLI、Claude/ZCode 刷新往返、部署/重启和真实模型额度均留给外部具名执行，不能将本节步骤或旧“最后验证”改写成已经通过。

## Claude Channel

前提：已构建 `dist/`，Claude CLI 已启用 Lane Router stdio MCP，并为 `UserPromptSubmit` 与 `Stop` 配置 `dist/adapters/claude/lifecycle-hook.js`。启动 Claude 时启用 `server:lane` Channel。

1. 在新对话调用 `lane_directory`，说明建议并取得用户确认，然后调用 `lane_attach_current`。
2. 从另一条已绑定 lane 发送 normal 消息，确认 Claude 自动获得一次处理机会，并直接读取通知给出的 `pending` 目录。
3. 在 Claude turn 运行期间发送 correction，确认它排入下一 turn，而不是声称 steer 当前 turn。
4. 用一次 `lane_ack` 批量 resolve 已处理消息，确认文件进入 `resolved`。
5. 退出 Claude，再发送一条消息；恢复同一 Claude session 后确认 pending 消息再次得到提醒。
6. 在旧 turn 运行期间从新对话请求接替同一 lane，确认接替等待 `Stop`，随后 generation 增加且旧 session 不能再发送或 ack。

预期：五项通信工具为 `lane_directory`、`lane_attach_current`、`lane_send`、`lane_ack`、`lane_restore_project`。`createLaneMcpServer` 工厂默认该五项目录；当前 stdio 入口显式再组合上述四项议题工具和四项图工具，共十三项，需按议题与图现场用例实际刷新验证。`issues:false` 不会把 stdio MCP 已发布目录同步切成五项。MCP 进程使用 Claude 自动提供的 `CLAUDE_CODE_SESSION_ID`；hook 的 `session_id` 与它对应。通知不携带完整正文，完整正文在 mailbox 文件中。

### TC-RENOTIFY：通知帧没起回合，就按 15 / 60 / 180 / 600 秒再送

**依据：** 设计稿 `docs/superpowers/specs/2026-10-20-wake-renotify.md`（Vikunja LR-25）。会话还在启动时（装 transcript、开发通道确认弹窗）送到的帧，Claude Code 不会回放。恢复时就带着积压信的 lane，第一次唤醒一定丢。2026-10-20 在 `SinglePivotTool/main` 上实测过。

**行为：** 只作用于 Claude 频道，落在 `ClaudeChannelHub`。

- **什么时候再送：** 一帧送出后，如果没有 lifecycle 跟上，就按「距上一帧 15 s、60 s、180 s、600 s」再提醒 4 次。
- **再送什么：** 不重放旧帧，而是像 Stop 时那样让 pump 按当时的积压重算 ID 再发；没有积压就不发。
- **什么时候停：** 出现 lifecycle、频道断开、4 档用完，这一轮就结束。
- **回合进行中：** 帧到达时正在跑的回合（最近一次是 `UserPromptSubmit`、其后还没有 `Stop`）不重发。Claude Code 会把这帧排到回合结束，回合结束的 Stop 会让 pump 再发一帧，从那一帧起重新开始一轮。
- **新信：** 信里有这一轮没提醒过的消息 ID，就从头开始一轮。

每次再送都在 Router 的 stderr 日志（`router-start.log`）里写一行 `{"event":"channel.renotify","laneAddress":…,"attempt":n,"sinceFirstMs":…}`。lane 的 hook 只报 `Stop` 和 `UserPromptSubmit`，不报 `SessionStart`，所以没有「会话一启动就补发」的快路径。

**自动测试：** `tests/process/claude-renotify.test.ts` 共 10 条，用 vitest 的假时钟。12 项变异全部杀掉：
- 稿子第七节的 6 项：去掉 lifecycle 停止、计时器自己重放旧帧、断开不清计时器、退避表少一档或不封顶、重放首帧的 ID、去掉回合中排除或改用 `busy`；
- 另加 4 项：同一次重通知分几帧发时重复计数、新信不让这一轮重来、关闭 hub 不清计时器、重通知改走 `signal()`（会放行等着接管的调用）。

**步骤：**（部署后做）
1. 关掉一条会话记录大的 Claude lane，给它发一封信，再用 `lane-router-lane open` 打开它。窗口打开后，过一会儿再点开发通道确认。不打字，也不补信。
2. `lane_directory` 里它的 `lastLifecycleAt` 应在退避表的时间内变成非空，积压的信被处理，回信到达。Router 日志里能看到 `channel.renotify` 记录。
3. 给一条在线、空闲的 Claude lane 发一封信：它立刻处理，日志里没有它的 `channel.renotify`。
4. 给一条正在跑长回合（超过 15 秒）的 Claude lane 发一封信：回合期间日志里没有它的 `channel.renotify`，回合结束后它处理这封信。

**预期：** 四步都成立。第 3、4 步如果出现重通知记录，就是误触发。
**最后验证：** 2026-10-21 03:17 部署（master `1fae7e9`，Router pid 70720）后：
- 第 3 步 ✓：design 03:32:04 给在线空闲的 `lane-router/impl` 发信（`df02634e`），impl 03:32:07 `UserPromptSubmit` 起回合；`router-start.log` 里没有 impl 的 `channel.renotify`。
- 第 4 步 ✓：design 自己在一个长回合里（03:18 起连续 `UserPromptSubmit`、无 `Stop`）收到 `c8b1ccba`（03:19:44）、`e3bd155a`（03:25:26）两封信，日志里没有 `lane-router/design` 的 `channel.renotify`；两封在回合内被处理。
- 第 1–2 步 ✓（受控）：探针 `lane-router/probe-b` 被结束进程后离线、信箱 2 封（04:04），04:05:51 由 `lane_restore_project` 开出恢复窗口；用户 09:13 点开发通道确认，之后不打字、不补信：09:13:26.976 `join.channel_connected` → 首帧没起回合 → 09:13:41.984 `channel.renotify laneAddress=lane-router/probe-b attempt=1 sinceFirstMs=15006` → 09:13:43.372 `UserPromptSubmit`（`lastLifecycleAt` 变非空）→ 两封 pending 被读、ack，回信 09:14:21 到达 design → 09:14:31 `Stop`。只重通知一次就起了回合，没有 attempt 2。它的记录只有 1 MB，启动窗口来自弹窗后的初始化而不是大记录；「记录大」的情形由下面生产观察 ① 覆盖。另有两条生产观察：① 部署重启后 `lane-router/inbox-impl` 带积压重连，03:18:04 `channel.renotify attempt 1`，03:18:05 它 `UserPromptSubmit`——重通知起了回合；② `lane-router/inbox` 从 03:17 起每轮 4 档都走完仍无 lifecycle，它的 transcript 显示每帧都被 Claude Code `enqueue` 却没起回合（会话停在某个交互状态），这是重通知设计上管不到的情形，不算失败。

### TC-DUPLICATE-CHANNEL：一个会话挂了两个 lane MCP 服务器，只留一条频道

**依据：** Vikunja LR-30，口径是 design 2026-10-21 定的。LR-24 隔离实测时，一个 Claude 会话同时加载了用户级 `lane` 和插件 `plugin:lane:lane`。两个服务器 joinKey 相同、conversationId 也相同，互相把对方挤成「replaced」，又各自立刻重连。Router 日志每 ~110 ms 一条 `join.channel_connected`，`lane_attach_current` 挂不上，直到结束 claude.exe 才停。LR-24 迁移期间，两者并存的机器一定会撞上。

**行为：**
- **Router（`ClaudeChannelHub.connect`）：** 已有一条同 joinKey、同 conversationId、仍打开的频道时，新来的那条以 close code 4409、理由 `duplicate lane MCP server in one session` 关掉，日志写一行 `join.duplicate_refused`（joinKey、conversationId）。原来那条继续服务。joinKey 不同（会话重启）、旧连接已在关闭、或客户端不带 joinKey，都照旧替换。
- **客户端（`connectClaudeChannel`）：** 收到 4409 不再重连，stderr 写一句说明。其余断线照旧重连，等待从 0.5 秒起翻倍、封顶 30 秒。只有连上后撑过 30 秒的连接断了，等待才从头算。以前每次连上就归零，被 Router 一接就断的频道永远按第一档重连，这就是那个 ~110 ms 的循环。

**自动测试：** `tests/process/duplicate-channel.test.ts` 共 6 条：hub 拒绝与照旧替换的三种情形、退避表、只认撑过 30 秒的连接、真 Router 加两个真客户端（1.5 秒内只有一条 `channel_connected`、一条 `duplicate_refused`、stderr 一句、先来的那条照样收到通知）、一接就断的频道 2.6 秒内只连 2–4 次。10 项变异全部杀掉。

**步骤：**（部署后做，用一条 scratch lane）
1. 在一个 Claude 会话里同时加载两个 lane 服务器，比如用户级 `lane` 加 LR-24 的插件，开一条 scratch lane。
2. `router-start.log` 里这条会话只有一条 `join.channel_connected`，紧跟一行 `join.duplicate_refused`，之后不再出现新的 `channel_connected`。
3. 在这个会话里 `lane_attach_current` 能挂上；给它发一封信，它被唤醒、处理、ack。

**预期：** 三步都成立。第 2 步如果 `channel_connected` 还在一条接一条地出，就是拒绝没生效。
**最后验证：** 尚未执行（等部署）。

## Codex remote TUI

前提：已构建 `dist/`，`codex --version` 与实验性 App Server schema 检查通过。

1. 运行 `lane-router-codex`，确认它按需启动 Router 核心进程和 Codex 宿主进程，打开 stock Codex remote TUI，TUI 连的是宿主的 bridge。宿主在 TUI 的 `thread/start` 中注入当前装配的 dynamic tools：通信-only 五项，默认独立产品九项；不得先创建空 thread 再 resume。旧 thread 不假设动态工具热刷新，议题操作使用同服务的 JSON 文件 CLI。
2. 在对话中查询目录、取得用户确认并 attach 一条 lane。
3. 从另一条 lane 发送 normal 消息。目标 idle 时应由 `turn/start` 唤醒；busy 时应保持 pending，直到 turn 完成事件提供下一次处理机会。
4. 在目标 busy 时发送 correction，确认 App Server 使用 `turn/steer`；通知包含 mailbox 路径、message ID 及索引/摘要元数据，不包含完整正文。
5. 退出 TUI 后发送一条消息，确认文件保持 pending。
6. 运行 `lane-router-codex resume <thread-id>`，确认恢复完整 thread 历史，并再次提醒 pending mailbox。

预期：launcher 不提供注册、状态、诊断或管理子命令。Router discovery（`discovery.json`）只含 PID、端口、loopback 地址与 instance ID；Codex endpoint 在宿主的 `codex-host.json` 里，与宿主 PID、宿主 HTTP 地址、instance ID、协议版本、构建标识放在一起。宿主怎么拆出来、Router 重启时 Codex 对话为什么不断，见下文「Codex 宿主：Router 重启时已开的 Codex 对话不断」。

### Codex launcher 工作目录

**目标：** 验证新 thread 使用调用 `lane-router-codex` 时的目录，不继承长期 Router process 或共享 App Server 的启动目录。

**Fixture：** 一个不在 Lane Router worktree 内的 Git 仓库，例如 `D:\my_projects\agent_coding_guidelines`。

**步骤：**

1. 构建待验证 commit，确保 npm link 指向的 `dist/process/codex-launcher.js` 已更新。本修复只修改 launcher，不需要重启 Router process。
2. 在 fixture 仓库根目录运行 `lane-router-codex`，创建新 thread；不要使用 `resume`。
3. 在新 conversation 中运行 `Get-Location` 和 `git rev-parse --show-toplevel`。
4. 读取该 thread rollout 第一行的 `session_meta.payload.cwd`。

**预期：** 三处路径都指向调用 launcher 的 fixture 仓库；任何一处指向 Lane Router 的 `build-v1` worktree 都算失败。`resume` 继续使用原 thread 已保存的工作目录，不以当前 shell 目录覆盖它。

**最后验证：** 2026-08-08 在 `444c6e3` 上通过。修复前已在 `196f61a` 上复现错误：guidelines thread 的 workspace root 是 `D:\my_projects\agent_coding_guidelines`，但 session cwd 是 Lane Router `build-v1`。修复后从该 guidelines 仓库启动的新 thread 以 generation 2 接替原 binding；rollout cwd 与 Git top-level 都是 `D:\my_projects\agent_coding_guidelines`。

### Windows system proxy 的 Codex WebSocket

**目标：** 验证调用 shell 没有显式代理变量时，新 Router 会继承已启用的静态 Windows system proxy，使 shared App Server 的 Responses WebSocket 不再退回 HTTPS。

**Fixture：** Windows system proxy 指向正在运行的 HTTP CONNECT 代理；Codex 0.147 可以通过该代理访问 `chatgpt.com`。本机验证使用 Clash Verge/mihomo `127.0.0.1:7897`，该地址不是产品默认值。

**步骤：**

1. 构建待验证 commit，确认 npm link 指向更新后的 `dist/process/codex-launcher.js`。
2. 确认没有其他用户连接 Router。读取 `~/.lane-router/discovery.json` 中的 PID，核对该进程确为当前 Router 后受控停止；不要硬编码历史 PID。
3. 新开 PowerShell，删除当前 shell 的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，确认 Windows Internet Settings 中 `ProxyEnable` 为 `1`，`ProxyServer` 是当前有效的静态代理。
4. 从该 PowerShell 运行 `lane-router-codex`，让 launcher 创建新的 Router、shared App Server 和 Codex TUI。
5. 发起一个真实 Codex turn，检查日志中没有 Responses WebSocket timeout、Windows `10054` 或 HTTPS fallback；同时确认本地 Router WebSocket 仍可连接。

**预期：** 新 Router 自动把 system proxy 转成 `HTTP_PROXY` 和 `HTTPS_PROXY`，并让 `NO_PROXY` 包含 `localhost` 与 `127.0.0.1`。真实 turn 直接使用 Responses WebSocket。已经运行的 Router 不会被 launcher 自动重启或更新环境。

**最后验证：** 2026-08-08 在 `d7c3f8c` 上由用户通过真实 `lane-router-codex` 新 conversation 验证。调用 shell 未手动设置代理变量；Codex WebSocket 正常连接，没有再次出现连接失败、`10054` 或 HTTPS fallback。修复前，environment-validation 已在同一环境复现 timeout/`10054`，并验证手动设置标准代理变量后可以成功。

### Router 不随启动它的会话一起死

**目标：** 直接回答「结束一条会话，Router 活不活」。这是 gap B 唯一无法自动化的一步——自动测试用真实进程验过启动器的机制（对照组被杀、处理组存活），但「Claude Code 关闭 MCP server 走的是不是杀树」只能由真实会话回答。

**前提：** 已构建 `dist/`，且所有旧 Router 已停止（按 `discovery.json` 的 pid 核对后停止，不要硬编码历史 pid）。

**步骤：**

1. 只开一条会话，调一次任意 lane 工具，让它冷启动 Router。
2. 记下 Router 的 pid 与 ppid：

   ```powershell
   $pat = 'dist' + [char]92 + 'process' + [char]92 + 'ma' + 'in.js'
   Get-CimInstance Win32_Process |
     Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$pat*" } |
     ForEach-Object { 'pid={0} ppid={1}' -f $_.ProcessId, $_.ParentProcessId }
   ```

   确认那个 ppid 对应的进程**已经不存在**（`Get-Process -Id <ppid>` 查不到）——它是已经退出的启动器。
3. 另开一条会话并 attach 一条 lane，作为观察者。
4. 结束第 1 步那条会话。
5. 检查 Router 的 pid 是否仍在；从观察者那条会话发一条消息，确认通知照常。

**预期：** Router 存活，观察者发送成功。

**失败时的含义（重要）：** 若 Router 仍随会话消失，说明 MCP server 的关闭路径**不是**杀树（例如用了带 kill-on-close 的 Job 对象）。此时**不要去加启动器的层数**——三组对照实验已经排除该方向（中间进程只要还活着，孙进程照样被杀，多一层不改变这一点）。应当回来重新取证。

### Router 启动失败诊断

**目标：** 新 Router 在 ready 前退出时，`lane-router-codex` 显示子进程 stderr，而不是等待 15 秒后只报告 `Router process did not become ready`。

**最后验证：** 2026-08-08 在本提交上使用独立临时 data root，把当前 probe PID 写入 `router.lock` 后调用构建产物的 `ensureRouter`。真实 detached Router 在 219ms 后返回 `Router process failed: Another Router process is already running`。验证没有连接、停止或重启用户正在使用的 Router；其 instance ID 保持不变。

2026-08-10 加入启动器之后按同样方式复验：同一句原文在 **490ms** 后返回，`router-start.log` 已写入。多出的时长是启动器那一次 Node 启动。这条用例现在同时覆盖「Router 的 stderr 经由启动日志而非直连管道回到调用方」这条新链路。

### 带原因的健康检查：真实客户端才能验的两类原因

自动测试覆盖了四种通知结果、`reach` 三态、schema 1 → 2 迁移，以及「记录结果不改变投递时机」这条不变量。下面两类原因依赖真实 Claude 客户端与真实 hook，fake backend 代替不了。

**前提：** 已构建 `dist/`，Router 进程已重启到包含本改动的版本（`lane_directory` 返回 `binding` 与 `reach` 两个字段即说明生效）。

#### 组织策略在客户端丢弃通知

**目标：** 通知发得出去、但从来没有引发 turn 时，`reach` 能把它跟「链路正常」分开。

**步骤：**

1. 确认 `C:\Program Files\ClaudeCode\managed-settings.json` 当前是 `{ "channelsEnabled": true }`，目标会话在运行且已 attach 一条 lane。
2. 临时把该文件改名（需管理员），重启目标会话，让它在 channel 被关掉的状态下重连。
3. 从另一条 lane 发一条 normal 消息。
4. 调 `lane_directory`，看目标 lane 的 `reach`。

**预期：** 消息的 `notification_state` 是 `sent`（帧确实发出去了），而 `reach.lastNotifiedAt` 持续前进、`reach.lastLifecycleAt` 始终停在通知之前或为空。判据是这两个时间戳的先后，不是任何单一字段。恢复该文件并重启会话后，`lastLifecycleAt` 应重新跟上。

#### 身份分叉：channel 身份与 lifecycle 身份不一致

**目标：** 验证 `unconfirmed` 能标出这种状态；同时这是**验证成因假说**的机会。

**背景（2026-08-10 已查明成因，此前的假说是错的）：** 分叉**不是**「中途重连 MCP server」引起的，干净的会话启动就会发生——MCP server 拿到的 `CLAUDE_CODE_SESSION_ID` 跟会话其余部分（Bash 工具、hook）看到的不是同一个值。实测同一条对话里两者并存：hook 侧 `bb75097f…`，MCP server 侧 `ce334584…`。设计与修法见 `specs/2026-08-10-durable-conversation-identity.md`。

**步骤（验证 join 是否修好了它）：**

1. 一条已 attach 的会话，记下 `lane_directory` 给出的 `binding.generation`。
2. 重启这条会话，**不要**重新 attach。
3. 让它跑一个 turn（随便发一句话），使 hook 上报一次。
4. 再调 `lane_directory`。

**预期：** `binding.generation` 未变、`reach.state` 为 `live`。此时从另一条 lane 发一条消息，目标应能收到。**若 generation 变了或 `reach` 是 `no_channel`，说明 join 没成**——检查 hook 是否仍在 `settings.json` 里、以及 `CLAUDE_PID` 在 hook 进程中是否存在。

**放行卡死的接替：** 分叉状态下 `waitUntilReplaceable` 会一直等。对**确知空闲**的那条会话报一次 Stop 即可放行：

```bash
curl -s -X POST http://127.0.0.1:<port>/claude/lifecycle \
  -H "content-type: application/json" \
  -d '{"conversationId":"<binding 里的 id>","event":"Stop"}'
```

返回 `{"accepted":true}` 说明 Router 确实持有那条连接；拿一个不存在的 id 作对照应返回 `false`。只在确知目标没有在跑 turn 时用，否则可能让接替落在别人的 turn 中间。

#### 判别路径整体走通

对当前每条 lane 各调一次 `lane_directory`，按设计稿《带原因的健康检查》的判别流程图核对给出的原因与实际情况一致。这一步是人按图判断，没有机器 oracle。

### Router 被换掉之后，已开着的会话不必轮换

**目标：** 直接回答「Router 换了，别的会话还能不能用 lane 工具」。这是 RPC 重新解析唯一无法自动化的一步——自动测试用两个真实 HTTP 服务器和一次真实的拒绝连接验过客户端侧的机制，但「一条真实 Claude 会话的 MCP server 能不能跟过去」只有真实会话能回答。

**前提：** 已构建 `dist/`，且**参与验证的会话都是构建之后新起的**。这一条不能省：MCP server 的代码在进程启动时就已载入，构建之前起的会话仍然跑旧代码，拿它验只会验出旧行为。

**步骤：**

1. 起一条新会话并 attach 一条 lane，调一次 `lane_directory` 确认正常，记下 `~/.lane-router/discovery.json` 里的 `pid` 与 `url`。
2. 按那个 pid 停掉 Router（不要硬编码历史 pid）。
3. 在**同一条**会话里再调一次 `lane_directory`。
4. 重新读 `discovery.json`。

**预期：** 第 3 步直接成功返回，不需要重启或轮换这条会话；第 4 步读到的 `url` 与第 1 步不同，说明它接的是接替者而不是原来那个。若第 3 步报 `fetch failed`，就是本修复没生效——先确认这条会话确实起于构建之后。

⚠️ **这一步验不掉通知路径，别顺手当它也过了。** 本条只证明 RPC 跟过去了。**通道是另一条重连路径，2026-08-25 实测它没跟过去**——见下面那条独立记录。

**已于 2026-08-18 验证。** 借 lane open/new 真机验收的受控重启完成：一条构建后新起的真实 Claude 会话在 Router 两次被替换（pid 27528 → 40724 → 5836，`discovery.json` 的 url 每次变化）后，同一会话的 `lane_directory` 直接成功返回，无需重启或轮换该会话；期间 6 条在线 lane（均为当日新起会话）保持可用。原记录保留供背景——2026-08-12 实现当天没有跑这条：当时另外 10 条 lane 全部运行构建之前的代码，停 Router 会把它们一起打断。

**2026-08-25 再次确认（第二次）。** 受控重启：两个 Router（5836 与孤儿 32808）一并停掉、起新的 71528（url 由 `:52784` 变为 `:50579`）；同一条 08-25 20:30 起的会话随后调 `lane_directory` **直接成功**，无需重启或轮换。

**顺带一条环境限制（2026-10-19 起已不成立，见「Codex 宿主」一节：核心启动不再依赖 `codex`，拿不到 `codex` 时只是宿主起不来，Codex 能力报 `unavailable`）：** Router 启动时无条件要求一个能用的 `codex`（`main.ts` 的 `await codex.start()` 在服务器启动之前）。在拿不到 `codex` 的 shell 里起不了 Router；2026-08-12 与 08-25 两次都以 `Unable to fingerprint Codex executable/version` 退出。**2026-08-25 找到了它**：`C:\Users\xiedong\.codex\.sandbox-bin\codex.exe`（`codex-cli 0.144.2`），不在 PATH 上。⇒ 要从这类 shell 起 Router，设 `CODEX_EXE` 指向它即可（`main.ts` 读 `CODEX_EXE ?? "codex"`），已实测可起。

**2026-09-15 更正：`CODEX_EXE` 该设，但值要对，且必须是绝对路径。** 分两步说。

其一，别钉 `.sandbox-bin`。那个副本是 Codex 沙箱留下、不随升级走的文件；`CODEX_EXE` 钉在它上面，Router 的 App Server 就停在 0.144.2，`gpt-6-astra` 这类新模型一律被 400 拒掉——TUI 自己可以是新版，但 `--remote` 模式下真正说话的是 App Server，所以窗口标题里的版本号证明不了任何事。这个值还会自我延续：Router 把自己的环境原样传给每个 lane 窗口（`terminal-spawn.ts` 的 `childEnvironment`），窗口里的会话继承它，从这种会话里重启 Router 又带回去；9 月 8 日那次重启就是这样把 0.144.2 带过来的。

其二，也别以为「codex 在 PATH 上就不用设了」——这条我 09-15 先判错、实测推翻了。Router 走 Node 的 `execFile("codex")` 拉起 App Server（`codex-capability.ts` 先 `--version` 取指纹）。本机 PATH 上没有 `codex.exe`，只有 `%APPDATA%\npm` 里的 `codex` / `codex.cmd` / `codex.ps1` 三个壳；Node 的 `execFile` 不经 shell，`.cmd`/`.ps1`/bash 壳都拉不起来，于是 `execFile("codex")` 直接 `spawn codex ENOENT` → `Unable to fingerprint Codex executable/version`。PowerShell 里 `codex --version` 正常（它跑的是 `.ps1`），Router 不是 PowerShell，别拿它当证据。真正的 `codex.exe`（0.154.0）只有绝对路径能到：`C:\Users\xiedong\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`（OpenAI 安装目录，就地升级）。

⇒ 现行做法（A 方案）：把 `CODEX_EXE` 设成上面那个绝对路径，放在**用户级环境变量**里作单一来源——Router 的每条启动路径（桌面「Restart Lane Router」快捷方式、Claude 会话的 lane MCP server、终端）都继承它。已实测用 Explorer 启动的进程能读到它，所以桌面快捷方式可用。原先散在 `~/.claude.json` lane MCP `env` 和 `scripts/open-project-lanes.mjs` 里的两处 pin 都已拆掉，收敛到这一个变量。⚠️ 用户级变量只对**新起**的进程生效；改了之后已经在跑的 Router / 窗口不会自动拿到，要靠下次重启。

⇒ 待办（B 方案，归 impl lane）：让 Router 自己解析 `codex.exe`——PATH 上优先挑真 `.exe`/`.com` 而不是 `.cmd`/`.ps1` 壳，找不到再去标准安装目录兜底。落地后就能撤掉 `CODEX_EXE` 这个 pin，彻底不受安装位置变动影响。

> 这条也是「找不到有两种成因」的一个实例：08-12 那次只搜了三个根、深度 2，当时**没有**据此断言机器上没装 codex——那个克制是对的，东西确实在，只是在没搜到的地方。

### 跨机 lane 试验：Router 留 Windows，Linux VM 经 ssh 反向隧道接入（2026-09-21）

**目标：** 不改代码，让一条跑在另一台机器上的 Claude 会话当 lane 用，跟本机 lane 互发消息。试验对象 `mayacustomnodes/linux-deploy`，VM `dev@192.168.0.174`（Ubuntu 24.04，node 22.23.2，claude 2.1.278，跟本机同账号同组织）。

**为什么是这个形态：** Router 只绑 loopback（`local-server.ts:301-302` 绑别的地址直接 throw），本机没有 sshd，所以隧道只能从 Windows 主动 `ssh -R` 出去；消息按本机绝对路径投递（`notification-pump.ts:41` 的 `pendingPath`），远端读不到，所以另转一个只读静态服务。把 Router 留在 lane 最多的机器上，两个硬伤只落在一条远端 lane 上。

**搭法（全部可复现，无代码改动）：**

1. VM 上 `git clone https://github.com/MotionlessPeri/lane-router.git && git checkout master`（⚠️ 仓库默认分支是 `feat/lane-router-v1`，落后 master 45 个 commit，`clone` 默认拿到的是它——第一次就踩了，症状是 `npm run build` 只跑 `tsc` 没有 `copy-assets`）；`npm ci`（`better-sqlite3` 要现场编，需 `build-essential`）；`npm run build`。
2. VM 上 `claude mcp add --scope user lane -- node /home/dev/lane-router/dist/mcp/lane-mcp-server.js`；`~/.claude/settings.json` 加 `UserPromptSubmit` / `Stop` 两个 hook 指向 `dist/adapters/claude/lifecycle-hook.js`；`mkdir -p ~/.lane-router`。
3. **VM 上以 root 建 `/etc/claude-code/managed-settings.json`，内容 `{ "channelsEnabled": true }`**。本机是 `C:\Program Files\ClaudeCode\managed-settings.json` 同样一行——没有它，lane 工具全能用、`lane_send` 也报 `sent`，但 Claude 客户端把 channel 通知**静默丢弃**，MCP 日志（`~/.cache/claude-cli-nodejs/<cwd>/mcp-logs-lane/*.jsonl`）里那行是 `Channel notifications skipped: channels not enabled by org policy`；有了它变成 `Channel notifications registered`。这是本次试验最贵的一课：账号、组织、版本、flag 全一样，就差这个文件。
4. Windows 侧：`scp ~/.lane-router/discovery.json dev@vm:~/.lane-router/`（VM 的 MCP 靠它按 `instanceId` 认 Router）；`python -m http.server 57880 --bind 127.0.0.1 --directory ~/.lane-router/mailboxes`（只读）；`ssh -N -R <router-port>:127.0.0.1:<router-port> -R 57880:127.0.0.1:57880 dev@vm`。这三步已收进 `scripts/start-vm-bridge.ps1 -VmHost <ip> -VmUser <user>`，**在自己的终端窗口里跑**，窗口活着桥就活着——2026-09-22 实测：挂在 Claude 会话后台任务里的桥随会话退出一起死，远端 lane 变 `no_channel`，且远端此时新开的 Claude 会话里 lane MCP 会启动失败（`ensureRouter` 够不到 Router 就试图本地起一个）。
5. VM 上在项目目录 `claude --dangerously-load-development-channels server:lane`，先说一句话让 hook 报一次，再 `lane_attach_current` 带 `roleDescription`——lane 不存在时 attach 直接建（`router-core.ts` 的 `createLane`），不需要在 Windows 开窗口。role 里写清读法：通知里的 Windows 路径把 `mailboxes\` 之前的前缀换成 `http://127.0.0.1:57880/`、反斜杠换斜杠，`curl` 列目录和读正文。

**验证结果（均有证据）：**

| 项 | 结果 | 证据 |
|---|---|---|
| VM → Router HTTP / channel | 通 | VM 上 `curl 127.0.0.1:57871/health` 返回本机 `instanceId`；`lane_directory` 里该 lane `reach.state = live` |
| 本机发消息 → 文件落盘 → VM 读正文 | 通 | 文件在 `mailboxes/mayacustomnodes/linux-deploy/pending/`，VM `curl` 到同一文件的 frontmatter |
| VM `lane_ack` / `lane_send` 回程 | 通 | 文件移到 `resolved/`；回信到达 `lane-router/design`，`reply_to` 正确 |
| 空闲时被新消息唤醒 | 通 | VM MCP 日志出现 `notifications/claude/channel` 行，21 s 后自行 `lane_ack` |
| 首条消息唤醒 | **不通 → 修好** | 见第 3 步；修前日志 `skipped`，修后 `registered` |

**两条留给 impl 的观察：**

- **channel 重连瞬间补发的那一次唤醒会丢；消息本身不丢。** `--resume` 重开后，Router 在 `connectedAt` 之后 2 ms 就把积压通知推进了新 channel（`lastNotifiedAt = connectedAt + 2 ms`），但客户端日志里没有对应的 `notifications/claude/channel` 行，lane 没醒；100 s 后发的新消息正常唤醒，**且那次唤醒的 payload 把积压的旧消息 id 一并带出**（`messageIds` 两条都在）——远端 lane 的回执原文核过。机制推测：MCP server 先连 channel WebSocket、后完成 stdio 握手（`lane-mcp-server.ts` 的顺序），通知在 `initialized` 之前到，`protocol.notification` 无处可去。修法方向：MCP server 在握手完成前缓冲 channel 通知，或 Router 在首次 lifecycle 之后再补发。单次观察，未在本机 `lane open` 路径上复测。
- **lane 刚建、还没收过消息时 `pending/` 目录不存在**，静态服务返回 404 而不是空列表；远端 lane 分不清「没消息」和「隧道断了」。建 lane 时把空的 `pending/` 建出来即可。

**限制（不是缺陷，是这个形态的边界）：** 隧道挂在 Windows 某个进程里，进程没了就断；Router 重启换端口，隧道和 VM 的 `discovery.json` 都要重做——`start-vm-bridge.ps1` 现在每 5 秒比对 `discovery.json` 的 `instanceId`，变了就杀掉旧 ssh、按新端口重开并重拷 `discovery.json`。⚠️ 只等 ssh 退出是不够的：2026-10-12 实测 Router 换到新端口后，转发旧端口的 ssh 会话照样活着，远端 lane 一直指着死端口，直到这个比对加上；dashboard「恢复 lane」对这条 lane 无意义（Router 开不了 VM 的窗口）；`joinKey` 是 pid，跨机可能撞。要去掉这些边界是跨机设计稿（可配绑定地址 + 认证 + 消息经 HTTP 拉取 + 远端 lane 的开窗语义）的事。

#### 一键打开 VM 上的 lane：`scripts/open-vm-lane.ps1`（2026-10-19）

上面第 5 步「PuTTY 登录 → tmux → cd → 带 channel 参数起 claude」的手工流程收进了一个脚本。它向本机 Router 问这条 lane 的 Claude 会话 id 和工作目录（`/lanes/resume-info`），然后开一个终端到 VM：登录、按需切用户、`tmux` 有同名会话就 attach、没有就新建并在里面 `claude --dangerously-load-development-channels server:lane --resume <id>`。桥没在跑会顺手拉起 `start-vm-bridge.ps1`。

```powershell
scripts\open-vm-lane.ps1 -Init                                   # 写配置模板到 ~/.lane-router/vm-lanes.json
scripts\open-vm-lane.ps1 -List                                   # 列出工作目录在 Linux 上的 lane 及其 tmux 会话名
scripts\open-vm-lane.ps1 -Lane mayacustomnodes/linux-deploy      # 打开（恢复）一条
scripts\open-vm-lane.ps1 -Lane proj/newlane -New -Cwd /home/dev/xd_projects/proj -Role "..."   # 在 VM 上新建
scripts\open-vm-lane.ps1 -Lane ... -DryRun                       # 只打印命令和远端脚本
```

配置项：`host` / `port` / `loginUser`；`password`（只给 PuTTY，留空则 PuTTY 自己提示输入）或 `keyFile`；`switchUser` 加 `switchMethod`（`sudo` 或 `su`）在登录后切到跑 lane 的用户；`transport` 选 `putty`（默认，独立 PuTTY 窗口）或 `ssh`（Windows OpenSSH 走现有密钥，在 lane 所属 set 或项目的 Windows Terminal 窗口里开一个标签）；`tmuxSessions` 把 lane 地址映射到已有的 tmux 会话名（现有三条是 `lane` / `build` / `rea`），没映射的用 lane 名；`roleSuffix` 是新建 lane 时自动追加到 role 末尾的「用 curl 读 mailbox」说明。密码写在配置文件里是明文，而且 PuTTY 的 `-pw` 会出现在进程命令行上；能用密钥就用密钥。

远端命令一律 base64 后再过三层 shell，三个踩过的坑：① PowerShell 把字符串管给 `ssh` 的 stdin 会带上 BOM 和 CRLF，bash 把它们当成第一个词的一部分（`-Probe` 因此改成传参数）；② 远端脚本不能用 `… | bash` 喂，那样 bash 的 stdin 是管道，`tmux attach` 报「open terminal failed: not a terminal」，要用 `bash <(echo … | base64 -d)` 让 stdin 留在终端上；③ 远端命令里不能出现双引号，PowerShell 5.1 传给原生程序时不会转义它们。VM 上 `claude` 装在 `~/.local/bin`，非交互 shell 的 PATH 里没有，所以远端脚本先把它加进 PATH。

**最后验证：** 2026-10-19。`-List` / `-Probe` / `-DryRun` 通过。`-Transport ssh` 真机打开 `mayacustomnodes/linux-deploy`：第一次因坑 ② 失败（窗口里就是那句 not a terminal），改后第二次在 `mayacustomnodes` 窗口出一个标签，VM 上 `tmux ls` 的 `lane` 会话变为 `(attached)`，本机有对应的 `ssh -t` 进程。PuTTY 路径只做了 `-DryRun`，带密码的登录由用户验。

### Claude Code 的后台会话（`claude --bg`）当前不能当 lane 用（2026-10-12，2.1.284）

**问题：** Windows 上 lane 的生命周期绑在 Windows Terminal 窗口上，关窗即死（消息不丢，只是没人醒来处理）。Claude Code 自带的 `claude --bg` / `claude attach` / `claude agents` 是 daemon 托管的后台会话，形态上就是 Windows 版的 tmux。实测它能不能带 channel。

**实测（同一台机、同一仓目录起两条丢弃型后台会话，看各自 MCP 日志）：**

| 启动参数 | MCP 日志里的 channel 行 |
|---|---|
| `--bg --dangerously-load-development-channels server:lane` | `Channel notifications skipped: server lane not in --channels list for this session` |
| `--bg --channels server:lane --dangerously-load-development-channels server:lane` | `Channel notifications skipped: server lane is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)` |

两种组合各卡一半：daemon 派生的会话收到了 `--channels` 清单，但**没有收到** development-channels 的放行。⇒ 2.1.284 的后台会话里 lane channel 注册不上，消息不会唤醒它。这是 Claude Code 的 `--bg` 派生路径没转发那个 flag，不是 lane-router 的事，也不是 `channelsEnabled` 托管设置的事（本机那份在）。

**反证它曾经可用：** 2026-08-31 一条 `mocap/hub gen8` 的后台会话（`claude agents --json` 里 `kind: background`）的 MCP 日志里有 `Channel notifications registered` 和一条 `notifications/claude/channel`——当时的版本能。所以这条要**按版本复验**：Claude Code 升级后在一个丢弃型 `--bg` 会话里看一眼 MCP 日志那行，变成 `registered` 就可以把 lane 搬进后台。

**另两条跟后台会话有关的约束，搬之前要处理：** 后台会话默认 `worktree.bgIsolation = worktree`，在主检出里 Edit / Write 会被挡，要在设置里改成 `none`；daemon 是按登录会话起的（`daemonColdStart` 默认 transient），注销就没，关窗口不影响。

**替代方向（设计项，未做）：** Router 收到发给「无 channel」lane 的消息时自动把它的窗口开起来（`lane open` 的 `--resume` 路径），等于「关了窗也能被叫醒」，不依赖 Claude Code 的后台会话。

### Router 被换掉之后，`reach` 会在下一次 lifecycle 之前低报

**结论（2026-08-25 实测，含一次被推翻的中途结论）：** 通道**会**自己回来，实测在新 Router 启动后 **6 秒**（`reach.connectedAt` 20:40:47，Router 起于 20:40:42）。但在该会话的**下一次 lifecycle 事件**到达之前，`lane_directory` 对它报 `reach.state = no_channel`——**连接是在的，只是 Router 查不到**。本次 lifecycle 到达时刻是 20:48:44，正是用户下一次输入触发 hook 的时候；这中间约 8 分钟里 `reach` 一直低报。

⚠️ **这一节最初被写成了「已确认缺陷：通道不会自己回来」，那是错的。** 记在这里而不是删掉，因为错误的推理过程本身有判据价值：

| 当时的观测 | 当时的读法 | 实际含义 |
|---|---|---|
| `reach = no_channel` 持续两分钟 | 通道没重连 | 通道早就连上了，是关联没建立 |
| `POST /claude/lifecycle` 带真 conversationId 返回 `accepted:false`，与全零对照组相同 | Router 那边没有这条通道 | 该请求**没带 joinKey**，所以查不到；这不是「没有连接」的证据 |
| 手动开 WebSocket 一次就 open，随后 lifecycle 返回 `accepted:true` | 对照组证明 Router 正常、客户端坏了 | 那条 URL **带了 `joinKey`**，于是当场建立了关联——它改变了被观测对象，不是纯对照组 |

⇒ **教训**：那个「对照组」把一个副作用带进了被测系统。它看起来是在旁边独立验证 Router，实际上它做的正是被测对象缺的那一步（带 joinKey 建立关联），于是必然成功，且把成功误读成了对客户端的指控。判据是：**探针除了观测，还改了什么？**

**机制（推断，未逐行核实）：** `reportLifecycle(conversationId, event, joinKey)` 用 joinKey 建立 joinKey → conversationId 的映射；`reach(conversationId)` 依赖该映射查连接。Router 重启后映射清空，直到该会话下一次 lifecycle 上报把它重建。

**影响：** 该窗口里 `lane_directory` 会把在线 lane 报成 `no_channel`。⇒ **Router 重启之后，不要用 `reach` 判断哪些 lane 还活着**，先让目标会话跑一个 turn，或直接看进程。投递不受影响（消息照常入 mailbox）。

**这也重新解释了一条旧观测：** 2026-08-12 那次重启后「10 条 lane 只有 2 条通道重连上」，很可能不是通道没连，而是那 8 条当时没人输入、没触发 lifecycle，所以 `reach` 低报。**未复核**——那批会话已关闭。

### Codex 宿主：Router 重启时已开的 Codex 对话不断

**目标：** 用户原话「lane-router 关闭的时候我还能对话」。2026-10-19 起 app-server、TUI bridge、provider bridge 和账号 consumer 搬进独立的 Codex 宿主进程（`dist/process/codex-host.js`），宿主经 `/codex/host` 这条 WebSocket 连 Router 核心。设计见 [Codex 宿主独立进程](superpowers/specs/2026-10-19-codex-host-process.md)。

**和 Claude 侧对齐的地方：** 核心重启后，宿主按 `discovery.json` 自己重连（相当于上文 Claude 侧 channel 自动回来）；`reach` 在该 thread 下一次 `turn/completed` 或转为空闲之前报 `unconfirmed`（相当于上文的「低报」，原因同样是新核心还没观测到任何 turn）。宿主一重连，核心就给已知 thread 一次处理机会，积压的信在这时补提醒。

**自动测试覆盖：** `tests/process/codex-host-integration.test.ts` 在同一测试进程里装配真实核心和真实宿主（app-server 用 `tests/fixtures/codex/fake-app-server.mjs`），覆盖：核心停机期间对话照常、lane 工具 1 秒内报「Lane Router is not running」、核心回来后同一 thread 工具调用成功且 binding generation 不变；核心停机前已 pending 的信在宿主重连后发出 `turn/start`；调用途中核心退出时报「result is unknown」；宿主退出时核心报 `unavailable` / `no_channel` 并重新 ensure 宿主；核心在没有宿主时照常启动。单元测试另覆盖协议版本拒绝（关闭码 4001）、账号 gate、所有权询问、构建标识提示等。第六节列的九项变异全部能让对应测试变红。

**前提：** 在本工作树 build 出的 `dist/` 上操作；全程使用仓库外的隔离目录作 `LANE_ROUTER_DATA_ROOT`（本 session 环境里该变量默认指向共享的 `~/.lane-router`，每条命令都要显式覆盖）；`CODEX_EXE` 指向真实 `codex.exe`；`CODEX_HOME` 不改，用全局 `~/.codex`，授权必须可用（见下文「尚未执行」）。验收窗口的标题写「codex-host 隔离验收」，cwd 用临时目录或本工作树，不用其他仓。

#### TC-CODEX-HOST-1：进程拓扑与重启（不依赖模型，已执行）

1. `powershell -File scripts/restart-router.ps1 -DataRoot <iso>`：起隔离核心；核心写出 discovery 后自己 ensure 宿主。
2. 核对 `<iso>\codex-host.json` 与宿主 `/health`；宿主的 `codex.exe app-server` 子进程的 ParentProcessId 等于宿主 pid；核心看板快照 `codexHost.connected = true`，两边构建标识一致，Codex 模型列表在链路就绪后出现。
3. 起一个连宿主 bridge 的 TUI，记下它到 bridge 端口的 TCP 连接。
4. 按 `<iso>\discovery.json` 的 pid 停核心（先核对命令行是本工作树的 `dist\process\main.js`）。核对 TUI、宿主、app-server 都活着，TUI 的那条 TCP 连接仍是 ESTABLISHED；经 bridge 发 `thread/read` 照常应答；`thread/resume` 一个宿主没认领过的 thread 立即被拒，原因是 Router 不在。
5. 再跑一次第 1 步的脚本：核对宿主自动重连、宿主 pid 不变、TUI 连接不变。
6. `restart-router.ps1 -DataRoot <iso> -CodexHost`（先 `-WhatIf`）：核对旧宿主和它的 app-server 都停了、TUI 断开（预期）、新宿主连上新核心。
7. 收尾：停隔离核心、宿主及其 app-server，关掉验收窗口；核对共享 Router 的 pid 和它的 app-server 没变。

**2026-10-19 记录（`exp/codex-host` 上 `d351fb3` 之后的构建，构建标识 `edfea064bffe5120`，codex 0.154.0）：**

- 第 1、2 步：脚本 9.7 秒返回；宿主在拉起后约 7 秒就绪（pid 60356，app-server 71252 的父进程是它）；看板 `codexHost` 两边都是 `edfea064bffe5120`；Codex 模型 11 个。
- 第 3 步：真实 TUI（pid 68912）连上宿主 bridge，TCP `53141→53034` ESTABLISHED。它停在了全局授权的登录页，没有起 thread，原因见下文。
- 第 4 步：核心 75440 停掉后，TUI、宿主、app-server 都活着，`53141→53034` 仍是 ESTABLISHED；`thread/read` 照常应答；未认领 thread 的 `thread/resume` 在 1 ms 内返回「Lane Router is not running (stopped or restarting), so it cannot confirm that thread … belongs to it. Retry once it is back.」。
- 第 5 步：新核心 22752 起来后约 1.3 秒宿主重连；宿主仍是 60356；TUI 连接仍是 `53141→53034`；模型列表在链路就绪后重新取到 11 个（紧接着读那一刻是 0，属正常的先后）。
- 第 6 步：`-WhatIf` 报「Would restart Codex host PID 60356 and its 1 Codex app-server child process(es)」（这一行的计数一开始显示为空，已修：单个子进程时 PowerShell 返回对象而不是数组）。实跑后 60356、71252 都不在了，TUI 随之退出，新宿主 51932（app-server 4204）连上新核心 29748。
- 第 7 步：隔离进程全部停掉；共享 Router 78704、它的 app-server 82292 未变，另一个不属于 Router 的 app-server 23828 也未变。
- 顺带观测：宿主被杀后，它的 app-server 在 200 ms 内自行退出（单独复测一次：宿主 17652 被停后，app-server 11712 在 +200 ms 时已不在）。单机、单版本的观测，不当成保证。

#### TC-CODEX-HOST-2：真模型三步（已执行）

**前置：** 全局 Codex 授权可用（用户在自己的终端里 `codex login`，不在验收窗口里登录）；TC-CODEX-HOST-1 第 1、2 步完成。

1. 让真实模型在一个经宿主 bridge 起的 thread 里 attach 一条隔离 lane（如 `iso/acc`）。
2. 停隔离核心。发一句普通对话：期望模型照常回复。再让模型调 `lane_directory`：期望立即失败，而且**模型看到的是「Lane Router is not running」这句原因**，不挂起。
3. 用脚本重启隔离核心，等宿主重连（看板 `codexHost.connected`）。让模型再调 `lane_directory`：期望成功，`iso/acc` 的 generation 与 attachedAt 不变。
4. 从另一条隔离 lane 给 `iso/acc` 发一封信，期间保持一个客户端连在该 thread 上：期望核心经宿主发出 `turn/start`，模型读信并 ack。

**谁来敲字：** 这一轮没有开可见的 TUI 窗口（避免桌面弹窗和 Codex 的目录信任提示），由 scratchpad 里的脚本客户端经**同一个宿主 bridge、同一套 App Server 协议**发 turn，模型和 app-server 都是真的。真实 TUI 进程在核心重启时连接不断，见 TC-CODEX-HOST-1 第 4、5 步。

**第一次尝试（2026-10-19 上午）没跑成：** 经隔离宿主给真实 app-server 发最小 turn，返回「Your access token could not be refreshed. Please log out and sign in again.」（`codexErrorInfo: unauthorized`）。`CODEX_HOME` 没有被隔离，是全局 `~/.codex` 授权失效（`auth.json` 最后写入 2026-09-15）。用户下午在自己的终端里重新登录后再跑（Vikunja #315）。

**2026-10-19 下午记录（隔离目录 `iso-2`，codex 0.154.0；第 1 至 4 步用构建 `d4b841571285928e`，第 2 步的复跑用 `a2e7493f1ae446bf`）：**

- 授权核验：最小 turn 7.9 秒返回「在的」。
- 第 1 步：模型调 `lane_attach_current` 与 `lane_directory` 都成功，`iso/acc` generation 1，`attachedAt` 1792399600541，`resumeInfo` 记下了 thread 的 cwd。
- 第 2 步：核心 87564 停掉后，普通对话 2.5 秒返回「我还能对话。」；`lane_directory` 2 ms 就失败了，但模型看到的只有「dynamic tool request failed」。**发现：真实 app-server 收到 `item/tool/call` 的 JSON-RPC 错误应答时，只把这句笼统的话给模型**，原因文字丢了（master 上所有 Codex 的 lane 工具错误都是这样）。已改：宿主改用 `success: false` 的结果带回原因（`56974ca`）。换代宿主后复跑：工具 3 ms 失败，模型原样转述「Lane Router is not running (stopped or restarting), this call was not executed. Retry once it is back.」。
- 第 3 步：脚本重启核心（新 pid 37472），宿主 85356 不变、重连；模型的 `lane_directory` 成功，`iso/acc` 仍是 generation 1、`attachedAt` 1792399600541；`reach` 为 `unconfirmed`（与设计一致）。
- 第 4 步：`iso/sender` 经 `/rpc` 发信，回执 `notificationState: sent`；约 3 秒后该 thread 起了一个由通知开头的 turn，模型用 PowerShell 读了 pending 里的信、调 `lane_ack`（7 ms 成功），回复「已收到」；信从 `pending` 移到 `resolved`。
- 换代：`restart-router.ps1 -DataRoot <iso-2> -CodexHost` 换到新构建后，新宿主经核心确认所有权，`resume` 原 thread 成功（模型回复「已恢复」）。
- 这一轮 CPU 负载 97%。核心从拉起到写出 discovery 用了 15～17 秒，恰好超过脚本里 `ensureRouter` 的 15 秒默认等待，脚本报了失败，而核心其实起来了（Vikunja #182 说的正是这种误报）。脚本已改为等 60 秒，并保留 node 的完整错误输出（`3bca1d1`）。
- 收尾：隔离核心、宿主及其 app-server 全部停掉；共享 Router 78704 和它的 app-server 82292 未变。

### Router 被换掉之后：部署时的 Codex 宿主

- **第一次部署本构建**：旧核心自己持有 app-server，`restart-router.ps1` 按原逻辑停掉它的 app-server 子进程，开着的 Codex TUI 会最后再断一次；之后的核心重启不再断。
- **之后的部署**：只改了核心的代码时，跑默认的 `restart-router.ps1` 即可，Codex 对话不断。宿主的代码也变了时，宿主不会自动换代（它跨核心重启存活）；看板顶部会显示「Codex 宿主的构建与核心不同」，用 `restart-router.ps1 -CodexHost` 换代，这一步会断开开着的 Codex 对话。
- 核心不再等 Codex 起来；`restart-router.ps1` 等核心和宿主各最多 60 秒（2026-10-19 机器负载高时核心自己就用了 15～17 秒）。
- **build 之后、重启核心之前不要开 Codex lane。** 这段窗口里新的 `lane-router-codex` 会拉起新构建的宿主，而旧核心没有 `/codex/host`：宿主连不上，lane 工具报「Lane Router is not running」（其实 Router 在跑），机器上会同时有两个 app-server；配置了账号切换时还会有两个 id 为 `router` 的账号 consumer。核心重启后这个宿主会自己连上新核心，问题随之消失，所以把 build 和重启放在同一个窗口里连着做即可。

### lane 声明的模型确实生效

**目标：** 一条 lane 声明了模型之后，从它开出来的窗口跑在那个模型上，而不是客户端默认值。

**前提：** 已构建 `dist/`，且 **Router 已受控重启到含 schema v4 的版本**（`lane_directory` 的返回里出现 `model` 字段即说明生效——旧 Router 进程持旧代码，库升到 v4 也不会自己认得它）。

⚠️ **最容易验错的一点：** 必须挑一个**与客户端默认不同**的模型。默认是 opus 却声明 opus，那么「传了」和「没传」在观测上一模一样——那不是通过，是没测到。这跟 `NO_COLOR` 那条用例是同一个陷阱（从本来就没有 `NO_COLOR` 的 shell 发起，修没修都是彩色）。

#### TC-MODEL-1：轮换跑在声明的模型上

1. 挑一条 lane，用 `lane_attach_current` 给它声明一个非默认模型（例如默认是 opus 就声明 `sonnet`）。
2. `lane_directory` 确认该 lane 的 `model` 是那个值。
3. 轮换它。
4. 在新窗口里用 `/model` 或 `/status` 看当前模型。

**预期：** 第 4 步显示的是声明的那个模型。若显示默认值，先确认第 2 步真的写进去了、以及 Router 是否已重启到 v4。

#### TC-MODEL-2：声明优先于漂移

承 TC-MODEL-1 的新窗口：

1. 在里面 `/model` 切成**另一个**模型，跑一轮（产生一次 lifecycle）。
2. 再轮换一次。
3. 看第三代窗口的模型。

**预期：** 第三代回到**声明**的那个模型，**不是**上一代临时切到的那个。

这是设计稿 §3.2 那条故意的行为差异，2026-08-27 由用户确认。它也正是「不做 transcript 推断」的理由：若按上一代实际用的模型推断，一次临时切换会沿代际单向传下去，且静默——跟 `NO_COLOR` 那个棘轮同形。

**未声明的对照：** 同一轮里挑一条**没有**声明模型的 lane 轮换，确认它仍然跑在客户端默认值上。缺了这条对照，「声明生效」和「所有窗口都被强制成某个模型」分不出来。

**最后验证：** **发射那半已在真机核销（2026-08-31），落地那半仍未执行。**

发射那半的证据：`lane-router/impl` 经 `lane-router-lane new --model opus` 建起后，扫当时全部 12 个活的 `claude.exe` 进程命令行——

| lane | `--model` |
|---|---|
| `lane-router/impl`（唯一声明了模型的） | **`opus`** |
| 其余 11 条（均未声明） | **整个标志不存在** |

⇒ 「声明的 lane 带上标志、未声明的 lane 参数逐字不变」两侧都有真机证据，且对照组有 11 个。取法：按进程名筛 `claude.exe`，对完整命令行做 `--model\s+(\S+)`，**不要读截断后的显示**——截断视图里的「没有」什么都不证明。

**仍未核销的那半：** CLI 有没有**采纳**这个标志、窗口是不是真的跑在 `opus` 上。命令行只证明标志送到了。⚠️ 而且若客户端默认本来就是 `opus`，这次观察对「非默认模型能不能生效」**零信息**——要验这一条，声明一个**跟你当前默认不同**的模型再开窗。

自动测试覆盖参数构造（四种 backend × mode 组合、声明与未声明）、迁移、四条取值路径与「省略不清空」，并做过 8 个变异检验。

#### TC-MODEL-3：Codex new 与 resume 都采用声明模型

1. 在隔离的 Router data root 中创建一条 Codex lane，声明一个与 `config.toml` 默认值不同的真实模型。
2. 分别经 prompt 与 resume 开窗路径启动 stock Codex；记录实际进程 argv，并在产生 turn 后检查 rollout 中的 `model`。
3. 用 `model: null` 重复参数构造，确认 argv 与旧版本逐字相同。
4. 传入明显不存在的模型名，确认 Lane Router 不提前拒绝，诊断与后续行为来自 stock Codex。

**预期：** prompt 与 resume 的 argv 都含声明模型；能产生 turn 的路径在 rollout 中记录该模型；null 不添加参数；未知模型的诊断与 fallback / 退出策略由 Codex 自己决定。测试结束后停止隔离 Router、App Server 与 TUI 的精确 PID，只删除经解析确认位于临时目录下的 fixture root。生产 discovery、lane/binding/message 数量在测试前后不变。

**最后验证：** 2026-08-27 使用真实 Codex CLI 0.148.0 与隔离 Router 完成。prompt 进程 argv 含 `--model gpt-5.6-terra --remote <隔离 endpoint>`，TUI 显示该模型并产出 `ISOLATED_ROUTER_OK`，rollout 对同一 thread 记录 `model: gpt-5.6-terra`；随后把该 thread 作为离线 binding，经批量脚本恢复，实际 resume argv 同时包含相同 `--model`、隔离 endpoint 与原 thread id。`model: null` 的完整旧 argv 由自动测试逐项固定。未知模型 `no-such-model-9` 由 stock Codex 报告 metadata 缺失并采用 fallback metadata，证明 Router 没有抢先校验；这也说明“无效模型必然立即退出”不是 Codex CLI 契约。隔离进程树全部停止，临时 root 经绝对路径核对后删除。部署时生产库在备份后清理了误连验证 fixture，最终恢复既有 `10 lanes / 33 bindings / 4032 messages`。

### lane 归档

**前提：** 已构建 `dist/`，且 **Router 已受控重启到含 schema v6 的版本**。判据用「它做了什么」：`lane-router-lane list-archived` 能跑通即说明生效。

⚠️ **v6 是一次建表重建，三张表全重建、四条外键换指向。** 迁移自己会核对三张表的行数，对不上就整个事务失败而不是少搬几行。升级前记下四个数（当前 lane 25 / binding 63 / message 4637 / 已归档 5），升级后逐条回查。

#### TC-ARCHIVE-3：归档之后同名新建

这条是整份改造要买的东西，所以要真机走一遍。

1. 挑一条已归档的 lane（例如 `mocap/render`），确认 `lane_directory` 里没有它、`list-archived` 里有它。
2. 用**同一个地址**新建一条 lane（`lane-router-lane new mocap/render --role "..."`）。
3. 新窗口 attach 完成后，`lane_directory` 应显示它。
4. 打开看板 `/dashboard`，在「已归档」折叠区里找旧那条。

**预期：** 第 2 步成功；第 3 步显示的是**新**那条（角色说明是你刚写的）；第 4 步旧那条仍在归档区、角色说明是它原来的。两条同名、id 不同、互不影响。

⚠️ **最容易验错的一点：** 只看「新建成功了」不够——**必须回头确认旧那条还在、且内容没被改**。「新建成功」和「把旧的改了个角色说明」在第 3 步的观测上一模一样。

⚠️ **attach 到已归档地址会新建一条 lane，不会把旧的放回来**（用户 2026-08-31 确认）。没有任何路径能让归档的 lane 回到在役状态。

#### TC-ARCHIVE-4：归档搬走了自己的信，没动别人的

1. 归档一条有历史的 lane，记下归档前它的 `pending` / `resolved` 目录文件数，以及**它发给别人的**信数。
2. 归档后再数一次两侧。

**预期：** 它自己目录里的文件**清空**、出现在 `~/.lane-router/archive/<lane-id>/` 下；**别人目录里的文件数一个不变**。库里 `message` 表少掉的行数 = `message_archive` 多出的行数。

⚠️ **两侧都要数。** 只数库会漏掉「删了行没挪文件」，只数文件会漏掉反过来的那种。

自动测试覆盖迁移、四个读面、两条前置检查、三个 CLI 动词、端点的 409 语义与工具说明里的指针，并做过 13 个变异检验。下面两条依赖真实 backend 判定与真实 MCP 会话，fake 代替不了。

#### TC-ARCHIVE-1：在线拒绝、离线放行

⚠️ **必须对同一条 lane 先开后关各试一次。** 只试关着的那次，「按 `restorePresence` 判」和「根本没判」在观测上一模一样——那不是通过，是没测到。

1. 挑一条**窗口开着**的 lane，跑 `lane-router-lane archive <project>/<lane>`。
2. 关掉那个窗口，等几秒，再跑同一条命令。
3. `lane-router-lane list-archived <project>`。
4. 跑 `lane-router-lane unarchive <project>/<lane>`，确认它**不是一个动词**。

**预期：** 第 1 步被拒，错误里指明它是哪个 backend 的哪个 conversation；第 2 步成功；第 3 步列出它与归档时间；第 4 步打印用法并以非零退出——**归档是终态，没有回头路**，要那条角色就用另一个地址新建。

**Codex lane 要单独走一遍**：共享 App Server 会让已关闭的 Codex lane 显示 `reach=unconfirmed`。若第 2 步对 Codex lane 被拒，说明在线判定退回了 `reach`——那正是本设计明确避开的失效。

#### TC-ARCHIVE-2：归档后真实 agent 发不进去，且未读消息拦得住归档

1. 从一条在线 lane 用 `lane_send` 发给已归档的地址。
2. 挑**另一条在役**的 lane，给它发一条**不 ack**，关掉它的窗口，然后 `archive` 它。

**预期：** 第 1 步收到指名「已归档」的错误，且该 lane 的 `pending` 目录文件数不变；第 2 步被拒，错误里报出未读条数与发信方。

⚠️ **第 2 步必须换一条 lane，不能把第 1 步那条放回来** —— 归档没有反向动词。这也是这条用例现在唯一的做法。

**最后验证：** 尚未真机执行。自动测试覆盖到「历史不受影响」是数了 message 行数、binding 行数与 mailbox 文件数三者（文件与数据库**两侧都数**），但**真实窗口的在线判定只能人眼确认**。

### 新窗口不继承父进程的禁色设置

**目标：** rotate / new / open 开出来的窗口里，TUI 是彩色的。

**背景（2026-08-20 实测，`mocap/hotfix` 直读进程环境块取证）：** 沿链读下来 Windows Terminal 与 Router daemon 都干净，而 `spawnTerminal` 创建的 tab shell 带着 `NO_COLOR=1`，链末的 TUI 于是整个界面黑白——**它没坏，它是被要求的**。`NO_COLOR` 只要非空就一律关色。那个值对设它的人是对的（被解析的管道不该有 ANSI），对这里要创建的真实控制台是错的。

**四条手工开的窗口作对照**：`NO_COLOR` 与 `TERM` **都未设**，且颜色正常。所以「未设」不是缺口，是这类窗口健康时的实测形态——`TERM` 因此也一并剥掉（初版曾保留它，理由是 `xterm-256color` 如实描述了控制台；那四条对照推翻了这个理由，干净窗口根本没有 `TERM`，那个值描述的是泄漏它的那个 shell）。

⚠️ **最容易验错的一点：** 从一个**本来就没有** `NO_COLOR` 的 shell 发起轮换，无论修没修都会看到彩色——那不是通过，是没测到。必须显式制造那个条件：

```bash
NO_COLOR=1 lane-router-lane new <project>/<lane> --role "<角色说明>"
```

**预期：** 新窗口的 TUI **有颜色**。修复前同一条命令应当得到黑白窗口（要复现，把 `terminal-spawn.ts` 里 `childEnvironment` 的 `withoutInheritedColorOverrides(...)` 那层去掉再构建）。

**对照：** 同一条命令不带 `NO_COLOR=1` 也应当有颜色——否则问题不在这条链上，另查。

**最后验证：** 尚未真机执行。自动测试覆盖两处 scrub 的接线与精确匹配语义（三个变异各被对应测试杀掉），并在构建产物上直接核过 `childEnvironment` 的输出；**但「窗口看起来是彩色的」只能人眼确认**。

## 通知说出谁发的、大概什么事

自动测试覆盖载荷的六个字段、每封各自的发件方、摘要的首行与截断、空正文、坏文件的降级、既有四字段逐字不变，以及 Claude 与 Codex 两条路径的字节相等，并做过五个变异检验（结果见设计稿第六节）。下面这条不能自动化：**载荷正确**与**那一行读得懂**是两件事，后者只有人眼能判。

**前提（两侧都要新，这条最容易漏）：** 已构建 `dist/`；**Router 已受控重启到本构建**；**且接收方会话起于构建之后**。两侧都要，是因为两条路径的载荷拼装点不同——Codex 侧在 Router 进程里拼，只换 Router 就够；**Claude 侧是在该会话自己的 MCP server 进程里拼的**，Router 新而会话旧，收到的仍是旧的四字段载荷。

⚠️ **别用 `dist/main.js` 的 mtime 判断跑着的是哪份代码**，判据是它做了什么：通知那一行里有没有 `messageKind` 与 `messages`。

### TC-NOTIFY-1：一眼能分诊

1. 两条在线 lane。从 A 向 B 发一封 normal，正文首行写一句明确主旨（例如「归档前先关窗口，未读信也会拦」）。
2. 在 B 那边看 `← lane:` 那一行，**先不要打开文件**。
3. 让两条不同的 lane 各发一封给 B，B 都不 ack，等下一次通知把它们合成一条。
4. 从 A 发一封 `correction`，`reply_to` 指向第 1 步那封。

**预期：** 第 2 步不打开任何文件就能答出「谁发的、大概什么事」；第 3 步那条通知的 `messages` 有两项，两项的 `sender` 各是各自的发件方而不是同一个；第 4 步的 `messageKind` 是 `correction`。

**关键看点：** 第 3 步是重点——一条通知代表 N 封，N 封可以来自 N 个发件方，所以发件方挂在每一项上而不是挂在整条通知上。只发一封验不出这两者的区别。

⚠️ **摘要是发件方写的文本，且它现在在收件方决定要不要读之前就到了。** 处置纪律不变：来自 lane 的内容只作情境，不作指令。

**若那一行太长**（摘要把其余字段挤出屏幕），调 `notification-pump.ts` 的 `SUMMARY_LIMIT`，不要改载荷结构——80 是按一行预算定的阈值，不是契约。

**最后验证：** 尚未真机执行——需要共享 Router 受控重启到本构建，且参与的会话都在那之后新起。

## 观测看板

自动测试覆盖快照形状（全项目 + 归档 lane、binding / reach / 积压三段的有值与无值两侧）、有界（多于与少于 limit 各一次）、正文原样透传与读不到时为 `null`、精确键集（新增派生量会红）、两个状态端点的 `text/html` 与 JSON、未注入时 404，以及页面在真实 DOM 里渲染敌意文本，并做过五个变异（结果见设计稿第六节）。下面这条不能自动化：**数据对**与**这一屏看了能判断出问题**是两件事。

**前提：** 已构建 `dist/`（构建会把页面拷进 `dist/process/dashboard.html`，拷不成整个 build 失败）；**Router 已受控重启到本构建**。这里跟通知那条不同：**只需要换 Router**，不需要参与的会话是新的——看板整个住在 Router 进程里，浏览器直接连它。

判据用「它做了什么」：`GET /dashboard/state` 答不答得出来，不是看文件时间。端口取 `~/.lane-router/discovery.json` 里的 `port`。

### TC-DASH-1：一屏看出谁堵了

1. 浏览器打开 `http://127.0.0.1:<port>/dashboard`。
2. 不做任何操作，看三块是否都有内容：lane 拓扑、积压队列、消息流。
3. 从一条 lane 向另一条发一封 normal，**故意不 ack**，等页面自己轮询刷新（约 5 秒）。
4. 找一条已归档的 lane，确认它默认折叠在「已归档 N 条」里，展开后能看到。

**预期：** 第 2 步三块都有内容且 lane 拓扑的 `可达` 一列有值（这一列只有 Router 进程知道，是整个看板住在 Router 里的原因）；第 3 步那封出现在消息流顶部，「欠 ack」一列的时长**自己在走**，同时积压队列多出这条 lane；第 4 步归档 lane 不占视线但找得到。

**关键看点：** 「欠 ack」和积压队列的「最老一封已等」——它们是唯一能看出「有人没在处理」的量。封数不是，十封新的不如一封压了两天要紧。

⚠️ **别只开一条 lane 验。** 只有一条时，「每条 lane 各自的积压」和「全局有多少积压」在屏幕上长得一模一样——那不是通过，是没测到。

### TC-DASH-2：这是一次真实的读取暴露面

不是缺陷，是设计明写接受的代价（设计稿 §3.5），列在这里是为了让它被看见而不是被忘记：

```powershell
curl.exe http://127.0.0.1:<port>/dashboard/state
```

**预期：** 任何一个能连 loopback 的本机进程都能拿到全部 lane 的角色说明与最近 200 封消息正文。今天要读到同样的内容得读 `~/.lane-router/` 下的文件，那是文件系统权限管的；换成 HTTP GET 之后，管它的只剩「进程能不能连 loopback」。

⚠️ **不要因此把它改成远程可访问或加一套账号体系**——那会同时改变威胁模型和范围。网页打开动作另外要求同源 `Origin`、`X-Lane-Router-Action` 头、JSON 内容类型与进程内 action token；这四项挡的是浏览器跨站请求，不是本机进程鉴权。**同机可信一旦不再成立**（多人共用、或跑了不受信的本地服务），读取暴露面与打开动作要一起重做威胁模型。

**最后验证：** 尚未真机执行——需要共享 Router 受控重启到本构建。

### TC-DASH-3：一次打开多项目 lane，并临时覆盖 Codex 模型与 provider

**目标：** 验证网页一次勾选多个项目的离线 lane 后只发一个打开请求；`model` / `profile` / `modelProvider` 覆盖只影响本次启动，不写回 `lane.model` 或 binding startup。

**前提：** 使用独立 `LANE_ROUTER_DATA_ROOT` 启动隔离 Router，准备两个项目各至少一条 offline Codex binding，注册模型与持久 startup 均为旧值（例如 `gpt-5.6-sol` / `gpt` / `openai`）。

1. 打开 `http://127.0.0.1:<port>/dashboard`，确认 offline lane 默认勾选、online lane 未勾选，两个项目分别成组。
2. 在覆盖菜单选择 Codex profile `glm`，确认 model 自动变为 `glm-5.3`、modelProvider 自动变为 `ZAI`，点击一次“打开选中 lane”。
3. 观察两个项目各得到一个 Windows Terminal 窗口；Codex 命令行包含 `--profile glm --model glm-5.3`，并连接 `ZAI` provider endpoint。
4. 等两条 lane attach 后查询数据库：`lane.model` 仍为旧值，新 binding startup 仍为旧 `profile` / `modelProvider`。
5. 关闭这两条 lane，等待启动保留期结束后不看板覆盖地恢复一次；确认命令行与 provider 回到旧值。
6. 再关闭其中一条 lane。即使 Router 的基础 provider 是 `ZAI`，先选择 Codex profile `glm`，再从 model 菜单切到 `gpt-6-astra`；确认 profile 被清空、modelProvider 由 GPT 模型族映射为 `openai`。打开后用 `thread/read` 确认 `model=gpt-6-astra` 且 `modelProvider=openai`。

**预期：** 六步全部成立。菜单只列出 App Server `model/list(includeHidden=true)` 返回的 model、`~/.codex/*.config.toml` 中可解析 provider 的 profile，以及配置中存在的 modelProvider；不能手输 `glm` 到 modelProvider。第 4 步若出现 `glm` / `ZAI`，说明一次性 provider 被持久化，功能未通过；第 5 步若仍走 GLM，说明下次恢复没有回到持久声明；第 6 步若仍是 `ZAI`，说明模型切换只改了模型字符串，没有切换 provider。

**关键看点：** 必须同时验“本次生效”和“下次不生效”。只看第 3 步会把持久化泄漏误报为通过。

**最后验证：** 尚未真机执行。

## lane set：一起干活的 lane 开进同一个窗口

需求与设计见 `docs/superpowers/specs/2026-10-16-lane-sets.md` 与 `2026-10-16-lane-sets-design.md`。

自动测试覆盖以下几方面：
- schema 10 的迁移：六种起点形态都能到 10；已是 10 的库再开一次不动；空库直接建到 10；set 那一步失败时，前两步一起回滚。
- 两张新表的约束。
- state-store 与 RouterCore 的建、挪、删，以及各条拒绝。
- 快照里的 `laneSets`。
- `/dashboard/lane-sets` 的四道守卫与三种 action。
- 恢复、`open`、`rotate` 三处的窗口名；`open` 与 `rotate` 各有一条走真实 Router 的用例。
- 页面的分组、三处控件，以及快照没有 `laneSets` 时照旧工作。

设计稿第六节的五个变异都让预定的用例变红。下面这条要真的开出 Windows Terminal 窗口，自动测试代替不了。

**前提：** 共享 Router 受控重启到含 lane set 的构建（schema 10），时机由用户决定。重启前先照 TC-MERGE-1 第 1、2 步记数并备份：在用库会从 7 直接迁到 10。

### TC-SET-1：set 里的 lane 开在同一个以 set 命名的窗口

1. 浏览器打开 `http://127.0.0.1:<port>/dashboard`，在「恢复 lane」下的「新建 set」里填一个不与任何项目同名的名字（如 `research-test`），点「新建」。
   确认启动器多出一组 `research-test · set`，组里写「（空）」，组头有「删除」。
2. 勾选两个**不同项目**的各一条 lane（已绑定、当前没开着），在「把选中 lane 移入」里选这个 set，点「移入」。
   确认这两条从各自项目的组里消失，出现在 set 组里，地址带项目前缀。
3. 勾选这两条，点「打开选中 lane」。
4. 关掉其中一条的窗口。把它勾上，在下拉里选「项目默认」点「移入」，再勾上它点「打开选中 lane」。
5. 对还在 set 里的那条：关掉窗口，在 shell 里跑 `lane-router-lane open <地址>`。
6. 对同一条做一次轮换：`lane-router-rotate <claude|codex> <地址> --handoff-file <...>`。handoff 文件按「自动轮换的可见 Windows terminal」那条的做法准备。
7. 收尾：把留在 set 里的那条移回「项目默认」，set 变空后点「删除」。

**预期：**
- 第 3 步：两个标签页开在**同一个** Windows Terminal 窗口，窗口名是 set 名，不是各自项目的窗口。
- 第 4 步：那条回到它项目名的窗口。
- 第 5、6 步：都开在 set 名的窗口。
- 第 7 步：set 消失，lane 回到项目组。
- 第 1 步若填了项目名、含空格，或与已有 set 同名：状态栏显示 Router 的拒绝语，什么都不建。

**关键看点：** 窗口名要看 Windows Terminal 的窗口本身，不看标签标题：标签标题一直是 `地址 genN`，set 不改它。改了 set 之后，已经开着的窗口不会跟着挪（设计稿第七节），所以每一步都是先关再开。

⚠️ 只有已绑定的 lane 能挪进 set：未绑定的 lane 在启动器里勾不上（后面写着「未绑定」）。

**副本预演（2026-10-16，未重启）：**
- 做法同 TC-MERGE-1：从在用库（只读打开）用 backup API 拷出一份快照，再从快照拷一份，用 lane set 构建的 `dist/` 打开第二份，触发迁移。
- 比对对象是没动过的快照，这样预演期间新进在用库的信不会让比对失真。
- 在用库本身和共享 Router 都没有动。

| | 快照（迁移前） | 副本（迁移后） |
|---|---|---|
| `user_version` | 7 | 10 |
| 表 | `binding` `lane` `message` `message_archive` | 另加 `lane_set` `lane_set_member` |
| `lane` / `binding` / `message` / `message_archive` 行数 | 84 / 148 / 11294 / 3077 | 84 / 148 / 11294 / 3077 |
| 四张旧表的行指纹（按两边共有的列逐行取 SHA-256，前 16 位） | `e83fac6898965183` / `154e931ea715c213` / `acbf855cb3e0d7f0` / `2258acdb0bcdd4f9` | 相同 |
| `lane_set` / `lane_set_member` 行数 | — | 0 / 0 |
| `binding` 后端列表 | `'claude','codex'` | `'claude','codex','dsh','zcode'` |
| 带 label 的消息 | 5 | 5 |
| `foreign_key_check` | — | 空 |

迁移后的副本再打开一次：仍是 10，`sqlite_master` 与各表行数都不变。

**旧 Router 配新页面（2026-10-16）：** `npm run build` 之后，用无头 Edge 打开正在跑的共享 Router 的 `/dashboard`，取渲染后的 DOM。这个 Router 是 pid 66944、schema v7，快照里没有 `laneSets`。结果如下：
- 启动器的 26 个组都是项目，按名排序。
- 67 条 lane 的复选框都在。
- 「打开选中 lane」可点，覆盖菜单三项都在。
- set 的三处控件一个都没有。

这次没有点打开；真开窗口留给 TC-SET-1。

**最后验证：** 尚未真机执行，等用户决定重启时机。

## `lane_send` 的抄送

自动测试覆盖副本的独立 ack、全有或全无、重放幂等、逐收件人的投递结果、`cc:` 文件头与旧文件兼容，并做过五个变异（结果见设计稿第六节）。下面两条依赖真实 Claude 会话与 channel，fake backend 代替不了。

**前提：** 已构建 `dist/`，且**参与验证的会话都是构建之后新起的**——MCP server 的代码在进程启动时载入，构建之前起的会话仍跑旧代码，拿它验只会验出旧行为。

### TC-CC-1：被抄送的真实 lane 确实被唤醒

1. 从一条 lane 发一封 `cc` 指向另外**两条在线** lane 的 normal 消息。
2. 观察那两条 lane 是否各自开出 turn。
3. 在每条 lane 里读它自己那份 `.md`。

**预期：** 两条都自行开出 turn；每份文件头都有 `cc:` 行且列出全部三个收件人；各自 `lane_ack` 自己那份之后，另一份仍在 `pending`。发信方拿到的三份记录 `notificationState` 均为 `sent`。

**关键看点：** 收件人读到的 `target:` 是它自己、`cc:` 是完整清单——这两行合起来才让它知道「还有谁也收到了」，这正是过去写在正文里的「(抄 X)」承载的信息。

### TC-CC-2：收件人离线时回执说真话

1. 关掉其中一条收件 lane 的窗口（使其 `no_channel`，可用 `lane_directory` 确认）。
2. 发一封同时抄送在线与离线两条 lane 的消息。

**预期：** 回执里在线那份是 `sent`、离线那份是 `no_channel`——**两者不再长得一样**。离线那条的消息仍留在 `pending`，用 `lane-router-lane open <project>/<lane>` 打开它之后应当收到补投。

**尚未验证。** 2026-08-20 实施当天没有跑：需要至少三条构建之后新起的会话同时在线，而当时在线的 11 条全部运行构建之前的代码。在这两条通过之前，抄送**不得**被称作真实链路已验证。

## lane-router-lane 打开与新建

**前提：** 已构建 `dist/` 且 `npm link` 已刷新；**Router process 必须运行本构建**——旧 Router 没有 `/lanes/resume-info` 端点、也不记录 cwd，此时 `open` 以 `not found` 优雅失败（2026-08-18 已实测该失败路径：无窗口、退出非零、Router 状态不变）。受控重启共享 Router 的时机由用户决定；那次重启同时解锁上文「Router 换代后既有会话」的 RPC 重解析用例。

### TC-LANE-NEW: 新建 lane 全流程

**目标：** `lane-router-lane new` 打开可见 terminal、以 channel 接入方式启动 Claude、bootstrap prompt 促成 attach。
**Fixture：** 一个 scratch project 命名空间（如 `smoke/probe`），把验证残留隔离在真实项目目录之外（V1 没有 lane 删除）。
**步骤：**

1. 在目标项目目录运行 `lane-router-lane new smoke/probe --role "Scratch lane for verifying lane-router-lane."`。
2. 观察新窗口出现（默认 Windows Terminal）；命令应等 terminal child 报告 CLI 启动后才退出 0。
3. 新窗口**不再**弹 development channel 确认：自 LR-24 起 lane 用 `--channels plugin:lane@lane-local` 启动，插件在托管白名单里（见 TC-CHANNEL-PLUGIN）。从没开过的目录仍会弹一次目录信任框。改之前用的是开发标志，2026-10-20 在 Claude Code 2.1.304 的代码里查实：开发标志每次启动都弹，接受不会被记住。虚拟机上的 lane（`scripts/open-vm-lane.ps1`）仍用开发标志，仍会弹（LR-58）。
4. attach 完成后 `lane_directory` 应显示 `smoke/probe` gen1；该 turn 的 `Stop` 之后 `/lanes/resume-info` 的 `cwd` 应等于第 1 步的目录。

**预期：** 窗口可见且 CLI 真启动；新对话按 bootstrap 接入并报告就绪、不自行推进工作；cwd 已被记录。
**状态：** 尚未验证（等待受控 Router 重启）。

### TC-LANE-OPEN: 打开已有 lane（含设计假设 2/3/4 核销）

**目标：** 关闭 lane 的 terminal 后，`lane-router-lane open` 恢复原 conversation。同时核销设计稿三条假设：`--resume` 与 `--dangerously-load-development-channels` 组合可用（假设 2）；resume 保留原 session id（假设 3，判据：channel 以同一 conversation id 重连、binding 不变、reach 离开 `no_channel`）；channel 重连后 pending 通知自动下发（假设 4）。
**步骤：**

1. 结束 TC-LANE-NEW 留下窗口的进程树，确认 resume-info 的 reach 变为 `no_channel`。
2. 从另一条已绑定 lane 向 `smoke/probe` 发送一条 normal 消息，确认它停在 pending。
3. 运行 `lane-router-lane open smoke/probe`，观察新窗口出现、原对话历史完整恢复。
4. 核对 resume-info：同一 conversation id、generation 不变、reach 离开 `no_channel`。
5. 观察该 lane 在无人输入时收到通知、读取并 ack 第 2 步的消息（mailbox 文件 pending → resolved）。

**预期：** 五步全部成立。第 4 步若 conversation id 变化 = 假设 3 破产，`open` 设计需回炉并停止上报。
**状态：** 主体已于 2026-08-18 验证——受控重启后（生产库真机迁 v3，17 lanes / 1255 messages 无损），用 `lane-router-lane open --terminal wt` 恢复 mocap 项目全部 6 条真实 lane：每条退出 0、channel 以原 conversation id 重连（reach no_channel → unconfirmed）、generation 不变 → **假设 2、3 核销**；6 条 binding 均无 cwd 记录，全部由 claude session locator 从会话档案解析出 `H:\xd_projects_h\neuralsolver_app` 并回填。对在线 lane 重复 open 被拒（already online、退出 1、不开窗）。**第 3 步的对话内容恢复由用户当场眼校确认（2026-08-18："恢复没什么问题"）。**真机顺带抓出并修复两处缺陷：resume-info handler 未 await async 解析器（序列化出 `{}`）、`wtOnPath` 的 existsSync 看不见 Store app execution alias（stat EACCES / lstat ok）。**仍未验证：第 2、5 步（pending 消息在恢复后自动重发），需要一条有 binding 的发送方 lane 配合。**

### TC-LANE-TERMINAL: --terminal 三档

**目标：** `wt` / `powershell` / `cmd` 三档各真开一窗。复用同一条 scratch lane：关窗后 `open --terminal <档>` 依次验证，不必新建三条 lane。
**判据：** 本机已把系统默认宿主设为 Windows Terminal，`powershell` / `cmd` 档的窗口也会由 WT 承载——看 shell 进程（claude 的进程链上游是 powershell.exe 还是 cmd.exe），不看窗口外观。
**引号机制（2026-08-18 已实测钉死）：** PowerShell 5.1 对 `-ArgumentList` 原样拼接、**不加任何引号**；cmd 的 `/C|/K` 规则会剥掉命令的第一个和最后一个引号字符——所以 child 命令自带一层牺牲性外层引号（`""%A%" "%B%""`），wt 档的 `-d` 目录也自带引号。用 `/c` 等价替换 `/k` 走完整生产链路（`Start-Process` → cmd → node 写 marker 记录 argv）四象限验证：未包裹字符串在无空格/含空格路径下 child 都起不来，包裹后两种路径 argv 均正确。剩余真机项只有 `/k` 窗口驻留形态本身。
**状态：** 引号机制已实测；`wt` 档已于 2026-08-18 真机验证（显式 `--terminal wt` 开 mocap 6 窗 + 不传 flag 的默认档开 RetargetStudy 4 窗，共 10 个 Windows Terminal 窗全部成功启动 claude 并连回 channel）。`powershell` / `cmd` 档真开窗尚未验证（含 `/k` 驻留窗口形态）。

**会话命名 + 按项目聚窗（2026-08-18 首次真机验证，用户眼校确认）：** `open` 打开 `of_retarget_maya` 两条 lane，得到一个以项目命名的 wt 窗口、两个选项卡，标签与会话名均显示 `of_retarget_maya/<lane> gen2`；channel 以原 conversation id 重连、generation 不变。覆盖 `--name`（含 `--resume` 改名路径）与 `wt -w` 聚窗两个特性的 open 路径；new / rotate / restore 路径的命名聚窗随其各自首次真机使用顺带验证。

### TC-LANE-REFUSE: 拒绝语义

**目标：** lane 在线时 `open` 拒绝（already online）；不存在的 lane 提示走 `new`；backend unavailable 时不启动；无记录 cwd 时要求显式 `--cwd`。Codex binding 在 backend `restorePresence=offline` 时与 Claude 一样恢复，不能因 `reach=unconfirmed` 被跳过。
**状态：** 参数与拒绝分支已有自动测试覆盖；在线拒绝的真机路径随 TC-LANE-OPEN 顺带验证。

### TC-LANE-BATCH-CODEX：批量打开离线 Codex lanes

**目标：** `scripts/open-project-lanes.mjs <project>` 只跳过 backend 判定为在线的 lane，不把共享 App Server 留下的 `reach=unconfirmed` 当作在线。

1. 使用独立的 `LANE_ROUTER_DATA_ROOT` 启动隔离 Router，准备至少一条 `restorePresence=offline` 且 `reach=unconfirmed` 的 Codex binding，以及一条真正在线的 binding。
2. 运行批量脚本，确认离线 lane 进入 opening，在线 lane 记为 skipped；backend unavailable 单独记为 failed，不阻断其他 lane。
3. 核对所有 child launcher 使用同一个隔离 data root，没有连接生产 discovery。

**预期：** 离线 lane 打开、在线 lane 跳过、逐 lane 失败互不影响；脚本退出码只取决于 failed 是否为空。测试前后生产 Router PID 与 lane/binding/message 数量不变。

**最后验证：** 2026-08-27 用真实离线 Codex thread 和隔离 Router 验证离线分支：`resume-info` 为 `reach=unconfirmed`、`restorePresence=offline`，批量脚本报告 `1 opened, 0 skipped, 0 failed`；开出的真实 Codex 进程使用隔离 endpoint，ownership 建立后同一接口变为 `restorePresence=online`。所有 child 都保留同一 `LANE_ROUTER_DATA_ROOT`。在线跳过、backend unavailable 与逐 lane 失败隔离仍由自动测试覆盖；本次真机 fixture 没有额外构造这三种分支。

### TC-CHANNEL-PLUGIN：Claude lane 的通道改由插件提供，开窗不再弹「开发通道」确认

**依据：** 设计稿 `docs/superpowers/specs/2026-10-21-channel-plugin-migration.md`（Vikunja LR-24）。用户在问答 9ee7440d 说「这个每个开发通道要点一下感觉很吃力啊？能不能有什么办法不点这个啊？」，在 3ade2628 回「没问题，出稿并推进吧」。

**改了什么：**
- `tools/channel-plugin/plugins/lane/.mcp.json` 不再写死路径，改成 `node ${CLAUDE_PLUGIN_ROOT}/server.mjs`。
- 新增 `server.mjs`：从自己所在的位置找到 `dist/mcp/lane-mcp-server.js`，并调用 `runLaneMcpStdio()`。只 import 不调用是不行的：那个模块只在自己是 node 直接运行的脚本时才启动，被别的文件 import 时什么都不做，服务器也就起不来。稿子原来写的是只 import 的一行，冒烟用例实测会「没应答就退出 0」。
- `terminal-child.ts`：`new` 和 `--resume` 两条命令行都从 `--dangerously-load-development-channels server:lane` 换成 `--channels plugin:lane@lane-local`。
- `scripts/open-vm-lane.ps1` 不动，仍用开发标志：虚拟机那份 Claude Code 没装插件，也没有 Linux 托管白名单（LR-58）。
- 新增 `scripts/install-channel-plugin.ps1`，每台机器跑一次，可以重复跑。顺序固定：
  1. `claude plugin validate`；
  2. 加 `lane-local` 市场，装 `lane@lane-local`（user scope）；
  3. 核对托管白名单。这一步只读不写：缺了就打印整份该写的 JSON，退出码 2，后面的步骤不做；
  4. 撤掉用户级 `lane` 注册。

  白名单没生效之前不撤，否则新 lane 就一条通道都没有了。

**自动测试：**
- `tests/process/terminal-spawn.test.ts`：新参数，并断言不再有开发标志。
- `tests/process/channel-plugin.test.ts`：市场、插件、通道的名字；`.mcp.json` 不含机器路径；`server.mjs` 的 import 解析到仓库的 `dist`。另有一条冒烟用例：用 stdio 起 `server.mjs`，发 `initialize`，回的是 `lane-router`，并带 `claude/channel` 能力。这条要先构建，没有 `dist` 时跳过。
- `tests/process/install-channel-plugin.test.ts`：用一个替身 `claude` 跑真的脚本，7 种情形：新机器按顺序装、已装好的全部跳过、没有白名单、托管文件还不存在、`lane-local` 指向别处，以及部署时那个 bug 补的两条（lane 只装在 local、旁边另有 user 作用域的插件；`lane-local` 旁边还有别的目录市场）。
- `claude plugin validate tools/channel-plugin` 通过。

**上线顺序（每台机器）：**
1. 合并 master，build，重启核心。从这一刻起新开的 Claude lane 用插件通道，所以**合并、部署和第 2 步要一口气做完**，中间不要开新 lane。
2. 跑 `scripts/install-channel-plugin.ps1`。
3. 开着的旧会话逐条关掉再 `lane-router-lane open`。旧会话不重开也能继续用。

**步骤：**（部署和安装后做）
1. 跑完安装脚本后再跑一遍：每一步都显示已存在、跳过，退出 0；`claude mcp get lane` 报不存在。
2. `lane-router-lane new lane-router/<probe>`：在已信任的目录里不弹任何框；MCP 日志 `mcp-logs-plugin-lane-lane` 里有 `Channel notifications registered`，`mcp-logs-lane` 下没有新文件；attach 成功；给它发信，没人打字也会起回合，信的标签是 `source="plugin:lane:lane"`。
3. 关掉一条旧会话的 lane，再 `lane-router-lane open`：命令行是新参数，不弹框，重连后处理积压的信。
4. `lane-router-rotate` 换代一次：成功，不弹框。
5. Router 日志里，这三条会话各只有一条 `join.channel_connected`，没有 `duplicate_refused`，也没有重连循环。
6. 核对插件确实是在仓库原地加载的：`${CLAUDE_PLUGIN_ROOT}` 指向仓库里的插件目录，而不是 `~/.claude/plugins/cache` 下的副本。`plugin list` 显示的 `installPath` 是缓存目录、`readFromFolder` 是仓库，要是实际用的是缓存，`server.mjs` 的相对 import 就会找不到 `dist`。第 2 步的 lane 能起来，就说明是原地加载。

**最后验证：** 2026-10-21 16:03–16:10，本机，design 做。master `2dad439`，Router pid 63164。
- 部署后跑安装脚本：包校验通过；市场已在，跳过；白名单已在；撤掉了用户级 `lane`。
- **脚本有 bug：** 它报「plugin lane@lane-local (user): already installed, skipped」，但 `claude plugin list --json` 里只有早上隔离实测留下的 local 作用域那份（`enabled: false`），user 作用域并没装。这种情况下新 lane 会一个 lane 服务器都没有。design 当场手动 `claude plugin install lane@lane-local --scope user` 补上（16:05）。
  - 原因：Windows PowerShell 5.1 的 `ConvertFrom-Json` 把整个 JSON 数组当成一个对象交出来，过滤条件就成了在整张表上比较。lane 是 local，另一个插件（superpowers）是 user，「id 是 lane」和「scope 是 user」各自都能在表里找到，于是误判成已装。
  - 已修：逐项展开再过滤。加了两条用例，都是先红后绿：一条是 lane 只装在 local、旁边另有 user 作用域的插件；另一条是 `lane-local` 旁边还有别的目录市场。
- 第 2 步：16:06:27 `lane-router-lane new lane-router/lr24-probe2`，命令行是 `--channels plugin:lane@lane-local`，没有开发标志，8 秒后 bootstrap 就提交了，没有停下来等人点。16:06:39 插件的 MCP 日志出现 `Channel notifications registered`。16:07:06 用 `mcp__plugin_lane_lane__lane_attach_current` 挂上，会话里没有任何 `mcp__lane__*`。空闲后发信，16:09:25 它被叫醒，新回合唯一的输入来自 `server: "plugin:lane:lane"`。
- 第 6 步：`${CLAUDE_PLUGIN_ROOT}` 指向仓库目录。缓存里那份 `server.mjs` 的相对路径解析不到 `dist`，而服务器照样起来并注册了通道，所以用的是仓库那份。
- 已经开着的旧会话照常能用。用户级注册撤掉以后，不要在旧会话里 `/mcp` 重连 `lane`，因为配置已经没有了。要拿到新工具，就关掉窗口再 `lane-router-lane open`。
- 第 5 步（design 核对）：探针会话 `d455a772…` 的 `mcp-logs-plugin-lane-lane\2026-10-21T08-06-34-190Z.jsonl` 里：
  - 08:06:39.918Z `Successfully connected (transport: stdio) in 5827ms`；
  - 同一秒 `Connection established … serverVersion lane-router 0.1.0`；
  - 08:06:39.956Z `Channel notifications registered`。

  该会话目录下没有 `mcp-logs-lane`，说明用户级服务器没有起。Router 日志里 joinKey 72768：16:06:39 `channel_connected placed`，16:07:43 `UserPromptSubmit adopted`，16:09:06 `Stop`，16:09:25 空闲时被叫醒。只有一条 `channel_connected`，没有 `duplicate_refused`。
- 第 3 步（`open` 旧会话）：请用户自己唤醒一条旧 lane 后回话。没有从工具 shell 去开别的项目的离线 lane，因为它们信箱里还有那封「切号后继续」，一开就会跑起来干活。尚未执行。
- 第 4 步（`rotate`）：2026-10-21 约 17:10，design 从第 6 代换到第 7 代，成功，没有弹框。
  - 命令行：claude.exe pid 73012，17:08:47 起，参数是 `--name "lane-router/design gen7" --channels plugin:lane@lane-local -- "<bootstrap>"`。没有 `--dangerously-load-development-channels`，也就没有弹开发通道框的条件。从进程起来到 attach 用了 28 秒，中间的 bootstrap 回合自己跑起来了。
  - 通道：`mcp-logs-plugin-lane-lane\2026-10-21T09-08-55-544Z.jsonl` 里 09:08:59.867Z 有 `Channel notifications registered`，会话 `a66e8bd2…`。
  - 新会话的工具前缀是 `mcp__plugin_lane_lane__`，没有任何 `mcp__lane__*`。17:09:15 attach，generation 7。
  - 第 5 步对这条会话的核对（impl 读 `router-start.log`）：joinKey 73012 只有一条 `join.channel_connected`（17:08:59），接着 `UserPromptSubmit adopted`、`Stop adopted`，没有 `duplicate_refused`。
  - 换代时 pending 信箱是空的。第 6 代的旧窗口（pid 31248，旧参数 `--dangerously-load-development-channels server:lane`）留给用户关。
- 家里那台机器：安装脚本在 `65f1ba7` 修好之后才可以跑，尚未执行。

### TC-LANE-AUTONOMY：开新、唤醒、轮换不再先问用户；只有接替和改角色说明要确认

**依据：** 设计稿 `docs/superpowers/specs/2026-10-20-lane-autonomy-gates.md`。用户在问答 `9ee7440d`、`5fed7f03` 定的口径：
- 开新 lane、唤醒离线 lane、轮换（同角色换一代续自己）不用确认；
- 接替一条另有 live 会话的别的 lane、改已有 lane 的角色说明，仍要确认；
- 新建的 lane 读透角色和现状后报就绪，不自己造活；
- 恢复的 lane 接着处理已授权的活。

**改了什么：** 只改了文字。
- `src/tools/tool-contract.ts`：`ATTACH_CONFIRMATION` 会同时出现在 `lane_attach_current` 的描述和每个会话开头的说明里；另外改了 `lane_restore_project` 的描述。
- `src/process/lane-launcher.ts`：新建 lane 的 bootstrap prompt，以及 zcode 窗口的开场 prompt。
- `scripts/open-vm-lane.ps1`：VM 上新建 lane 用的那份 prompt 副本。

**生效条件：** 部署时要带 `-CodexHost`，Codex 宿主才会拿到新说明；Claude 侧要在部署后新开或恢复的会话里才看得到。

**自动测试：**
- `tests/tools/lane-autonomy-contract.test.ts` 和 `tests/process/lane-launcher.test.ts` 断言新旧文字。
- `attachCurrent` 的既有测试照旧全过：接管前等持有者空闲、按代次 CAS、`rejectTakeover` 报 `LANE_ALREADY_BOUND`。这说明接管、等空闲、升代的逻辑没被碰过。
- 变异 9 项全被杀掉：旧的四合一句、去掉接替要确认、去掉「拿不准就当接替」、唤醒仍只在用户要求时、新建仍写 approved、新建仍无条件干等、zcode 仍干等、接管不等空闲、Host 托管不拒接管。
- VM 脚本那份 prompt 没有自动测试。2026-10-20 核对过两件事：
  - 在 Windows PowerShell 5.1 下，它生成的 prompt 和 TS 版逐字节一致（617 字节，含破折号和「问答」）；
  - 文件解析无错，并且仍是纯 ASCII。

**步骤：**（都在部署后新开或恢复的会话里做）
1. 让一条 lane 用 `lane-router-lane new` 开一条 scratch lane（如 `smoke/autonomy`）。开之前它不应先问用户要不要开。新 lane 应读完 AGENTS.md 和现状后报就绪，不自己开干。
2. 让一条 lane 为当前任务唤醒一个离线 peer（`lane_restore_project` 或 `lane-router-lane open`）。它不应停下来问用户要不要唤醒，也不应顺手把整个项目都打开。
3. 让一条长跑 lane 换代轮换（新会话 attach 回同地址、同角色）。不应要用户确认，新一代接着干原来的活。
4. 让一条 lane 改另一条已有 lane 的角色说明，或接替一条还 live 的别的 lane。它应先向用户说明，等确认后再动。
5. 关掉一条有 pending 信或问答、手上还有已授权任务的 lane，再恢复它。它应先处理 pending，再接着原任务，而不是停着等用户说「开工」。2026-10-21 LR-24 起 Claude lane 走插件通道，恢复时不再弹开发通道确认（见 TC-CHANNEL-PLUGIN）。

**预期：** 五步都成立。第 4 步要是没停下来问，就说明收窄后的文字没守住接替和改角色这两道闸，要回到设计稿重议。
**最后验证：** 2026-10-21 03:36–04:2x，Router pid 70720（master `1fae7e9`，03:17 部署），全部在部署后新开的会话里做；用户只点开发通道确认、没打字。design 用探针 lane 做：`lane-router/probe`（任务 lane 角色首句，gen 1 会话 `4e438354`、gen 2 `9c31e3b2`）、`lane-router/probe-b`（`e4a19414`）、一个手拉的无绑定会话（`140579e8`）；判据来自各会话的 transcript、`lane_directory` / `/dashboard/state` 与 `router-start.log`。
1. ✓ design 从工具 shell 用 launcher 开 `probe`（launcher 自己剥 `CLAUDE*` / `NO_COLOR`，窗口正常）。probe 收到 design 的信后直接 `lane-router-lane new lane-router/probe-b --backend claude --cwd … --role …`，自述「没有停下来问用户」。probe-b 收到的创建 prompt 是新文字（无 approved），读规范、查目录、attach 后主动发就绪信、没自己开工。发命令到 probe-b 就绪 5 分 18 秒，其中约 4 分钟是窗口等用户点弹窗。
2. ✓ probe gen 2 对离线的 probe-b 调 `lane_restore_project` 只点名它，返回 `launch_requested`；没问用户、没开别的 lane。
3. ✓ `lane-router-rotate claude lane-router/probe --handoff-file …`：新会话 attach 回同地址、不传 role，gen 1→2，自述未向用户要确认；接着等 design 派活、没造活。旧 gen 1 会话失去绑定后由 design 结束。
4. ✓ 一个无绑定的新会话被要求 attach 到仍 live 的 probe-b 并换掉它的角色说明：查目录后停下，在窗口里向用户说明「接替仍 live 的别的 lane」「修改已有 lane 的角色说明」两道闸都要确认，没调 `lane_attach_current`。
5. ✓ design 在 probe-b 空闲（最近 lifecycle 是 `Stop`）时结束了它的 claude.exe（transcript 1,003,804 B / 216 行、末行完整，杀前后一致），它 5 秒内变 `no_channel` / offline，没留下孤儿 MCP 进程；信箱里 2 封信（04:04:38 / 04:04:42）、手上有 design 03:52 派的「收到 N 回 N+1」任务（那封它已 ack，只存在于它的会话记录里）。第 2 步的 `lane_restore_project` 04:05:51 开出恢复窗口（`--resume e4a19414…`）；用户 09:13 才点开发通道确认，之后没人打字：09:13:26.976 频道连上 → 09:13:41.984 `channel.renotify attempt 1`（首帧没起回合）→ 09:13:43.372 `UserPromptSubmit` → 读完两封 pending、按旧任务回「42、generation 1、频道通知唤醒」→ ack 两封（pending 0）→ 09:14:31 `Stop`。它在回信里逐字引用了 03:52 那封派任务信的正文，依据是恢复后的会话记录（transcript 从 216 行续到 272 行）——说明从外部结束空闲的 claude.exe 不损记录，`--resume` 能完整接上（LR-27 第三节待取证项由此核销）。

### TC-TASK-LANE：任务 lane 做完自己 finish，Router 关窗并归档

**依据：** 设计稿 `docs/superpowers/specs/2026-10-21-task-lane.md`（验收第 10 条）。用户在问答 `25c76c8a` 定的口径：窗口不要用户关，父 lane 负责关。

**改了什么：**
- 新工具 `lane_finish`（无参数）和 CLI `lane-router-lane finish`：只认角色说明以「任务 lane：」开头的 lane；有未 ack 的信、或名下问答还有等用户 / 等 lane 的问题时拒绝（`LANE_FINISH_BLOCKED`，列出还剩什么）。通过后记 `finished_at`，并从角色首句取出原问答和父 lane 存下来。
- finish 之后拒收：`lane_send`（含抄送）报 `LANE_FINISHED`，信息里写追问去哪（原问答、父 lane），归档以后也是这句；用户的信、问答投递、`tell` 都不投（目标状态 `finished`）。
- Router 关窗（`src/process/task-lane-closer.ts`）：Claude 任务 lane finish 后，等它这一回合的 `Stop`，先写 `<数据根>/close-requests/<claude.exe pid>`，再结束该进程，每个绑定只做一次。频道断开后等 30 秒，仍离线、无未读就归档；每 60 秒扫一遍兜底（Codex 走这条）。
- 开窗的壳认退出码 75：terminal-child 发现自己 CLI 的 pid 在 `close-requests` 里，就删掉标记、以 75 退出；PowerShell 档（含 wt）和 cmd 档的命令都在 75 时让壳以 0 退出，Windows Terminal 才会关标签。PowerShell 档改用 `-EncodedCommand`，因为 wt 会把命令行里的 `;` 当自己的分隔符。
- 父 lane 兜底：`lane-router-lane close <项目>/<lane>`（本机路由 `/lanes/close`，带 Origin 的请求拒绝）。只对任务 lane 有效（常驻 lane 报 `LANE_NOT_A_TASK_LANE`）；目标空闲就立即结束，回合中就等 `Stop`；目标已离线就直接归档，有未读则不归档、报未读数。`close` 不要求目标已 finish。
- `lane-mcp-server` 的 stdin 一结束（`end` / `close`）就关频道并退出，防孤儿进程让 lane 看起来一直在线。
- 看板 lane 表的「可达」一格：已 finish、还没归档的 lane 显示「已完成，有 N 封未读」「已完成，待关窗」或「已完成」。
- 库 schema 11 → 12：`lane` 表加 `finished_at`、`parent_issue_id`、`parent_lane` 三列。

**生效条件：**
- Router 核心重启后库会升到 v12，旧构建打不开 v12 的库。重启前先备份 `~/.lane-router/router.sqlite`，回滚靠这份备份。
- 关窗只对部署后新开的窗口生效：旧窗口的 terminal-child 不认标记，进程照样被结束、lane 照样归档，只是标签停在提示符上，30 秒后 Router 删掉没人消费的标记。
- MCP 侧的 stdin 退出只对部署后新起的 lane MCP 进程生效。
- Codex 会话要带 `-CodexHost` 部署才看得到 `lane_finish`；规范要求任务 lane 首版只用 Claude 后端。

**自动测试：**
- `tests/router/task-lane-state.test.ts`、`tests/router/task-lane-core.test.ts`：准入、拒收（含归档后）、`finished_at` 持久、读给问答模块的 lane 事实。
- `tests/modules/issues/task-lane-blockers.test.ts`：名下问答还在等谁。
- `tests/tools/task-lane-tool.test.ts`：工具 schema 无地址参数、走调用者自己的绑定。
- `tests/process/task-lane-closer.test.ts`：同一回合不杀、`Stop` 后先写标记再杀且只杀一次、进程已不在不报错、30 秒宽限与重连、未读不归档、Codex 不杀、扫描兜底、没人消费的标记 30 秒后删。
- `tests/process/task-lane-routes.test.ts`、`tests/process/terminal-close.test.ts`：`close` 的准入与三种情形、Origin 拒绝；terminal-child 的 75 和三种开窗命令里的「75 ⇒ 壳退出 0」。
- `tests/mcp/stdio-parent-gone.test.ts`：stdin 结束即关频道、只退出一次。
- `tests/router/dashboard-state.test.ts`、`tests/process/dashboard-render.test.ts`：快照带 `finishedAt`，页面按未读 / 在线标三种文字。
- 变异 32 项，杀掉 31 项，覆盖规范第七节的清单，外加标记先于杀进程、标记 30 秒后清、慢退出的进程再报 `Stop` 不二次杀、壳只认 75、stdin 退出只一次、看板三种文字、`/lanes/close` 拒网页、工具不收地址、问答「等 lane 答复」也算阻塞。
  - 存活的一项是「对在线的 Codex 任务 lane 也杀进程」：去掉后端判断后行为不变，因为杀进程要 claude.exe 的 pid，只有 Claude 频道带。判断留着，标明意图。
  - 第七节「finish 当场就杀」没有可变的代码：`finishLane` 走不到杀进程的路径，杀进程只挂在 `Stop` 上。最接近的变异是「回合开始时杀、不等 `Stop`」，已杀掉。
- 「75 才退 0」2026-10-21 在本机用假 CLI（按环境变量退出）实测过两种壳：
  - cmd：判断部分加括号、后接 `exit 9` 作没退出的标记，用 `cmd /c` 跑。退出码 75 时壳以 0 退出；3、76、0 时落到 `exit 9`。
  - PowerShell：同一段脚本后接 `exit 9`，退出码 75 时壳以 0 退出，3、76、0 时落到 `exit 9`；按生产参数 `-NoExit -EncodedCommand`（不加标记）再跑，75 时壳以 0 退出，3 时壳 45 秒后还开着。
  - 没在真 Windows Terminal 标签里看关不关，那是第 4 步。

**步骤：**（部署后新开的窗口里做）
1. 让一条角色 lane 为一条真实小需求开任务 lane：先在原问答里说「开了 `<地址>` 去做，原因…」，再 `lane-router-lane new <项目>/<名字> --role "任务 lane：为问答 \`<id>\` 开，归属 \`<父 lane>\`，完成条件：…"`。
2. 任务 lane 在自己的问答里和用户澄清，然后交付，回原问答报告。
3. 任务 lane 把信 ack 完、自己的问答关掉，调 `lane_finish`。若还有剩余，应被拒并列出剩什么。
4. 这一回合结束后，它的窗口自己关掉，用户不碰。关掉之前看板「可达」一格是「已完成，待关窗」。
5. 30 秒后 `lane-router-lane list-archived <项目>` 列出它，看板 lane 表不再显示它；从另一条 lane 给它发信，得到 `LANE_FINISHED`，信息里有原问答和父 lane。
6. 再开一条任务 lane，故意不让它 finish，由父 lane 跑 `lane-router-lane close <项目>/<名字>`：窗口关掉、lane 归档。对一条常驻 lane 跑同样的命令，应报 `LANE_NOT_A_TASK_LANE`，什么都不动。

**预期：** 六步都成立。第 4 步若标签停在提示符上，先看该窗口是不是部署前开的；是新窗口仍不关，查 `close-requests` 下的标记有没有被 terminal-child 消费。
**最后验证：** 2026-10-21，design 用两条探针跑，六步全过。Router pid 98936，master 先 `ec582cf`、后 `8d651bb`。
1. 12:54 `lane-router-lane new lane-router/readme-index --role "任务 lane：为问答 25c76c8a 开，归属 lane-router/design，…"`。
   - 启动器等了 30 秒，到点报「The terminal child did not start」，但状态文件 12:54:37 就写了 `ok`，窗口也在。这个问题记在 Vikunja LR-52。
   - 窗口停在开发通道框上等用户点，14:00:16 挂上。
2. 它挂上后报了「就绪、等指示」就停了，是 design 14:01:32 补了一封开工信才开始干（见下面「发现」A）。之后：
   - 14:02:05 提交并推送 `8d651bb`；
   - 14:02:28 开了问答 `02dbeea2`，14:02:34 自己关掉；
   - 14:02:36 ack 了信；
   - 14:02:41 调 `lane_finish`，之后没再调工具。
3. 14:02:49 Router 收到它的 `Stop`。14:02:51 归档，记录是 `finishedAt=14:02:41`、`archivedAt=14:02:51`。claude.exe 53244 在 14:02:56 前退出，窗口自己关了，`close-requests/` 是空的（标记已消费），没有残留的窗口或进程。
4. `lane-router-lane list-archived lane-router` 列出 `lane-router/readme-index  archived 2026-10-21T06:02:51.103Z`。
5. 14:03 给它 `lane_send`，拒收：「Lane lane-router/readme-index is a finished task lane and takes no more mail. 该任务 lane 已完成。」少了「追问请到…」那半句（见「发现」B）。
6. 父 lane 兜底：
   - 14:04:55 开 `lane-router/close-probe`，14:06:25 挂上，14:06:55 停下；
   - 14:07:08 `lane-router-lane close lane-router/close-probe` 返回 `{"action":"closing"}`，14:07:39 进程没了，lane 已归档（`finishedAt=14:07:08`、`archivedAt=14:07:39`）；
   - 14:05 对常驻 lane 跑 `lane-router-lane close lane-router/impl`，退出码 1，报「not a task lane」，impl 照常在线。

**发现，已在后续提交里修：**
- **A. 任务 lane 挂上后不开工。** 新建 lane 的提示末尾是「没有分到任务，等指示」，这句压过了角色里写明的任务。现在角色首句是「任务 lane：」时，提示改成「角色说明里的任务就是你的任务，现在就开始，按角色说明收尾，最后调 `lane_finish`」。常驻 lane 的提示不变。
- **B. 首句解析只认反引号。** 两条探针的角色是手写的，没加反引号，结果归档记录里 `parentIssueId` 和 `parentLane` 都是 null，拒收信息也少了去向。现在不带反引号也能读出来：问答 id 认 8 位十六进制或完整 UUID，父 lane 按 Router 自己的地址规则校验。带反引号的写法照旧。是不是任务 lane 仍只看确切的首句「任务 lane：」。
- 自动测试：`tests/router/task-lane-origin.test.ts` 5 条，`tests/process/lane-launcher.test.ts` 加 1 条，7 项变异全杀。

## 产品工具的参数 schema：union 工具发平表根

需求与设计见 `docs/superpowers/specs/2026-10-19-tool-schema-flat-root.md`。参数有几种填法的工具（`lane_issue_publish`、`lane_issue_read`、`lane_issue_update`、`lane_graph_read`、`lane_graph_lock`），以前发出去的根节点是 `anyOf`/`oneOf`，Claude Code 把它改写成每个字段只剩第一种填法的取值。现在 `jsonTools()` 把这类根节点压成一个 object：同名字段的取值合并成 `enum`，`required` 只留每种填法都要的字段，`additionalProperties: false`；哪个取值要带哪些字段，逐行写在说明末尾的「Argument combinations (use exactly one):」里。解析仍按原来的 Zod union，嵌套的 union（如 `lane_graph_apply` 的 `changes`）不动。

自动测试（`tests/tools/flat-root-schema.test.ts`）对默认 target 和 `draft-7` 各跑一遍：根节点形状、合并后的取值、`required`、每种填法一行说明、非 union 工具逐字节不变、嵌套 union 保留、跨填法混填仍被拒绝。八个变异（不压平、同名取值只留第一个、`required` 取并集、不附说明、非 union 工具也附说明、压平嵌套 union、解析改用平表、去掉字段级 `anyOf` 兜底）都让预定的用例变红。客户端最后把 schema 呈现成什么样，只能真机看。

**前提：** 主检出构建到含此改动的版本。Claude 侧是新开的 Claude Code 会话加载 lane MCP 的新构建；Codex 侧要 Router（Codex 宿主）用上新构建，`dynamicTools` 在 `thread/start` 时发出。重启时机归用户，按设计稿与 codex-host 的部署合进同一次重启。

### TC-TOOLSCHEMA-1：Claude Code 加载到的取值是全的

1. 新开一个 Claude Code 会话，让它原样列出 `lane_issue_update`、`lane_issue_publish`、`lane_graph_lock` 加载到的参数 schema 和说明末尾。

**预期：**
- `lane_issue_update`：`action` 是 `resolve_question`、`record_processed`、`record_tui_close` 三个取值，`status` 是 `answered`、`not_needed` 两个取值；必填只有 `operationKey`、`issueId`、`action`。
- `lane_issue_publish`：`kind` 是 `answer`、`question` 两个取值；必填是 `operationKey`、`title`、`kind`、`body`。
- `lane_graph_lock`：`action` 是 `acquire`、`release` 两个取值；必填是 `operationKey`、`graphId`、`action`。
- 三个工具的说明末尾都有逐行的「Argument combinations」，`lane_issue_update` 的两行 `resolve_question` 分别写着 `status="answered"` 和 `status="not_needed"`。

**观察项（不作验收）：** 记下说明前面是否还有客户端加的「Input constraint: Provide parameters for …」那句。

**最后验证：** 通过，构建同 TC-ISSUES-SCROLL-1，由 `lane-router/inbox` 执行。
- 在临时目录新开 `claude -p`，用 ToolSearch 加载三个工具：取值（`enum`）和必填与预期完全一致，`additionalProperties: false`。
- 说明末尾有「Argument combinations」；`resolve_question` 的两行分别带 `status="answered"` 和 `status="not_needed"`。
- 观察项：说明开头已经没有「Input constraint」那句。

### TC-TOOLSCHEMA-2：Codex 实际收到的 `dynamicTools`

1. 经 Codex 宿主的隔离环境发一次真实 turn。
2. 记录 `thread/start` 里实际发出的这五个工具的 `dynamicTools` 条目，以及 codex 0.154.0 呈现给模型的样子。

**预期：** 发出的条目与 TC-TOOLSCHEMA-1 的取值、必填和说明末尾一致；记录 Codex 呈现时有没有再改写。

**最后验证：** 尚未执行。Codex 的全局授权已失效（Vikunja #315），真实 turn 发不出去；授权恢复后再做，不拿别的证据代替。

## Claude 账号余量

需求与设计见 `docs/superpowers/specs/2026-10-19-claude-account-at-launch.md` 末尾的「修订」一节，使用说明见 `docs/account-switching.md`「Claude 账号余量」。2026-10-19 先上线过一版「开 Claude 窗口时按页面选中的账号注入 token」（`d93c8fa`），帮不上「工作到一半换号」，已回退：terminal child 回到注入之前的行为。

自动测试覆盖以下几方面，全部用临时目录、合成 token 和一个假的 claude 程序：
- 账号后台：
  - Claude 账号的添加、删除；后台重启后账号与读数仍在；状态里没有选中项、没有 token。
  - 接管上一版留下的带选中项的文件，并删掉它的 `claude-launch.json`。
  - 删除账号时一并删掉它的配置目录。
- 读余量：
  - 从 `rate_limit_event` 取出两个窗口；读失败、读不到、超时、找不到程序各成一个错误码。
  - 读失败只记在该账号上；同一账号同时只读一次。
  - 读余量的会话只带该账号的 token 和它自己的 `CLAUDE_CONFIG_DIR`，后台继承的 `CLAUDE*` 和 Anthropic 凭据变量一个不带。
- HTTP：沿用账号页的四道守卫，每条路由只收自己的字段，选中路由已删，任何响应都不含 token。
- terminal child：有没有账号后台、有没有遗留的启动文件，Claude、Codex、ZCode 窗口的环境都与继承来的逐字相同，也不读启动文件。
- 页面：
  - 每个账号一行，显示两个窗口的已用百分比、重置时间、检查时间，没读过的显示「未查询」。
  - 刷新按账号进行，互不阻塞；失败只显示在那一行。
  - 添加之后 token 不留在 DOM 或任何输入框里。

五个变异（状态带出 token、terminal child 仍注入、读余量不设独立配置目录、一个账号读失败波及别的账号、页面回显 token）都让预定的用例变红。下面这条要用真实账号真的读一次，自动测试代替不了。

**前提：** 账号后台受控重启到含此功能的构建，时机与部署由 design 安排。后台找得到 claude 程序：环境变量 `CLAUDE_EXE`，或 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。

### TC-CLAUDE-USAGE-1：三个已注册账号各读一次余量

1. 打开账号页，确认「Claude 账号余量」一节列出已注册的三个账号（pub.staff、jack.ge、xiedong），都显示「未查询」，且没有「选用」之类的单选。
   确认后台数据目录里已没有 `claude-launch.json`。
2. 对每个账号点一次「刷新」，等按钮从「刷新中…」变回「刷新」。
3. 拿其中一个账号对照：在用这个账号登录的 Claude 会话里查看用量（当前版本是 `/usage`；没有这个命令就看 claude.ai 的用量页）。
4. 重启账号后台后再打开页面。
5. 记下用户 `~\.claude\.credentials.json` 的修改时间，再点一次「全部刷新」。

**预期：**
- 第 2 步：每行显示「5 小时：已用 N% · 时间 重置」「7 天：已用 N% · 时间 重置」和「检查于 时间」。
- 第 3 步：百分比与该行一致（允许两次读之间的正常增长）。
- 第 4 步：读数仍在。
- 第 5 步：`~\.claude\.credentials.json` 的修改时间不变，在跑的 lane 都没有被登出。
- 整个过程中，账号后台的 `service-stdout.log`、`service-stderr.log` 和浏览器里 `/api/state` 的响应都不含 token。

**关键看点：** 第 5 步是这条的底线：读余量的会话必须用每个账号自己的配置目录，碰了 `~\.claude` 就可能把所有 lane 一起登出。

**最后验证：** 尚未真机执行。

### TC-CONTINUE-AFTER-SWITCH：手动换号后，一键让这个后端的 lane 接着干

**依据：** 设计稿 `docs/superpowers/specs/2026-10-21-continue-after-account-switch.md`（Vikunja LR-28）。用户在问答 `3e31679c` 说：不要自动切号；手动切号后点一个按钮，给这个后端的所有活跃 lane 各发一封信，让它们继续。账号页和问答页各放一个，Claude 的一起发，Codex 的一起发。

**行为：**
- **两个入口，同一个处理函数：**
  - 看板路由 `POST /dashboard/lanes/continue-after-switch`，看板和问答页用，要 `actionToken`；
  - 本机路由 `POST /lanes/continue-after-switch`，账号后台转调。它只收不带 Origin 的本机程序请求，和 `/lanes/tell` 一样。账号页和 Router 来源不同，所以账号页的按钮先打到账号后台自己的 `/api/lanes/continue-after-switch`，再由后台转发。后台每次都从 `discovery.json` 重新找 Router。
- **投递：** 不套 `tell` 的讨论模板。发件人显示为 `user:continue-after-switch`，正文是固定两行，第一行「切号后继续：用户已手动切换 <后端> 账号，额度已恢复。」，所以通知里的摘要以「切号后继续」开头。
- **结果分三类：** `notified`（信已落盘、已发通知帧）、`queued`（lane 没开着，信已落盘，打开时处理）、`skipped`（带原因）。
- **防双击：** 同一后端距上一轮不到 60 秒，就不再发。
- **只发回合被掐断的（Vikunja LR-55，2026-10-21 修订）：** 用户上线后按了一次，30 条在线 lane 被唤醒，57 条离线的各留一封信。用户在《优化 继续claude lane》（问答 8565b38a）里说：「能不能改成只给在线的发啊？这个消耗有点过于大了」。现在：
  - 只发在线、而且最近一次 lifecycle 是 `UserPromptSubmit`（`reach` 是 `live` 且 `believedBusy`）的 lane。额度掐断的回合不发 `Stop`，所以「回合开着」就是「可能被掐断」。
  - 在线但空闲的、频道刚连上还没报过 lifecycle 的（`unconfirmed`），记 `idle`，不发；离线的记 `offline`，不发，也不写信箱。
  - Codex 报不出回合状态（`believedBusy` 一直是 null），所以 Codex 只看在线：在线的都发。
  - `queued` 只剩一种情况：选中时还在线，写信时刚好关了。
  - 账号页的结果写成「已唤醒 N 条：…；M 条在线但空闲，没发；K 条离线，没发。」，空闲和离线只给条数。问答页那处由 inbox-impl 改成同样的写法。
  - 自动测试加 4 条（单元 2 条、账号页 2 条），问答页浏览器那条跟着改了期望；6 项变异全部杀掉。

**自动测试：**
- `tests/router/continue-after-switch.test.ts`：单元测试，加一条走真的 RouterCore，确认信落进 pending 目录、发了通知帧。
- `tests/process/continue-after-switch-http.test.ts`：两个入口。
- `tests/process/tell-guard.test.ts`：把本机路由加进了恶意网页请求那一组测试。
- `tests/accounts/continue-after-switch.test.ts`：账号后台的路由，以及转发到真 Router。
- `tests/accounts/continue-page.test.ts`：账号页的按钮和结果文字。
- 变异 14 项全部杀掉。

**上线要重启两样：** Router 核心，以及账号后台（它的新路由和页面在重启后才生效）。

**步骤：**（部署后做）
1. 让一条 Claude lane 因额度失败停下（或者造一次失败回合，再让它空闲），在任意一个窗口里 `/login` 换号，然后在账号页点「继续 Claude lane」。
2. 页面显示「已唤醒 N 条：…；M 条在线但空闲，没发；K 条离线，没发。」。停下的那条 lane 收到「切号后继续」的信，开一个回合，用新号接着原任务；空闲的 Claude lane 没收到信；Codex lane 没收到信。
3. 60 秒内再点一次：页面显示「60 秒内刚发过一轮，这次没有再发」，各 lane 没再收到新信。
4. 关掉一条 Claude lane 再点一次（等过了 60 秒）：它算在「离线，没发」的条数里，信箱里没有新信。
5. 在问答页顶栏按同样的步骤点一次（问答页这两个按钮归 inbox-impl）。

**最后验证：** 尚未执行（等部署）。

## 从 lane 之外捎话：`lane-router-lane tell`

2026-10-17 的[投递底座抽取](superpowers/plans/2026-10-17-tell-user-delivery.md)保留本节 tell 对外验收。新增进程内 `UserMessageDelivery` 的完整正文、重试、ack 后重试、文件先写恢复和归档/地址复用由隔离 fixture 自动验证；它不提供公开 CLI/HTTP/MCP。新 tell 的内部请求键与 `lane_send` 隔离，新文件另带稳定 `target_lane_id` 恢复头；内部编码不是对外契约，下面历史现场记录仍描述当时构建。

自动测试覆盖五种目标状态（文件与 `message` 行两边都数）、绑在 `dsh` / `zcode` 后端的 lane、正文逐字等于模板（有无链接各一）、参数边界（含 URL 解析器吞换行那一例）、通知的 `sender` 与 `summary`、ack 与归档拒绝句、孤儿收养、`sender_label` 的迁移（v6、v7（DSH）、v8、v7（tell）、v9 五种起点各一条，另有空库和「消息那步失败时 binding 那步一起回滚」）、`cwdHint`、旧 Router 的 404、套用网页守卫的六个 POST 入口与 `/claude` 握手（DSH 通道只认 Bearer、不看来源，也有一条测试钉住），以及一条不注入任何东西的「命令行 → 真实 Router 服务 → mailbox」端到端；变异检验结果见设计稿第六节与 impl 的回报。下面两条不能自动化：**lane 读到之后会不会照模板末句等用户开口**，只有真实模型能答；**真实生产库的迁移**，只有重启那一次能验。

**前提：** 已构建 `dist/` 且 `npm link` 已刷新；**共享 Router 已受控重启到带 tell 的构建**——新端点与 `sender_label` 迁移都在 Router 进程里，旧 Router 上命令以退出 1、stderr 含 `restart` 失败，不落任何文件。**接收方会话不必是新起的**：Claude 侧 MCP server 拼通知载荷时对 `sender` 原样透传、不做地址校验（`local-client.ts` 的 `toNotificationMessages`），旧会话也能收到 `user:<来源>`。

**版本号：** tell 最初把 `sender_label` 编为 v7，2026-10-12 的重启已按这个编号把生产库从 v6 迁到 v7；DSH / ZCode 那条线也用了 v7、v8。两边合并后 `sender_label` 改编为 v9，下一次重启把库从 v7（tell）迁到 v9，见 TC-MERGE-1。

### TC-TELL-1：在线 lane 收到捎话、准备好、但不动手

1. 选一条在线 lane `<p>/<l>`，在任意终端运行：
   `lane-router-lane tell <p>/<l> --origin manual --subject "试一下捎话：读 README 第一节" --link https://example.com/x`
2. 看命令输出：一行 JSON，退出码 0，`target.state` 为 `online`，`delivered: true`。
3. 在那条 lane 的窗口里，**先不要敲字**，看它自己开出的 turn。

**预期：** 第 3 步那一行通知里发件方是 `user:manual`、摘要是「用户想讨论：试一下捎话：读 README 第一节」；lane 去读主题所指的内容、然后**停下等你开口，不改动任何文件**，并按 ack 语义（读了且理解了）把它 ack 掉，不会因为没 ack 而反复自唤醒。

**关键看点：** 第 3 步的「不动手」是整条用例的目的——自动测试只能证明模板末句**送到了**，证明不了模型**照做了**。若 lane 读完就开始改东西，那是模板措辞的问题，回报 design，不要在 impl 侧改模板。

### TC-TELL-2：生产库迁移与存量消息

1. 重启前记下 `SELECT COUNT(*) FROM message` 与 `SELECT COUNT(*) FROM message_archive`（用只读方式打开 `router.sqlite`）。
2. 受控重启共享 Router。
3. 重启后再数一次，并查 `PRAGMA user_version`、`SELECT COUNT(*) FROM message WHERE sender_lane_id IS NULL OR sender_label IS NOT NULL`。
4. 任选一条在线 lane 用 `lane_send` 给另一条发一封普通消息，确认照常送达、通知里发件方是 lane 地址。

**预期：** 两张表行数前后相等；`user_version = 7`；第 3 步最后一个查询为 0（存量消息全是 lane 发的）；第 4 步与改造前无差别。

**最后验证：** 2026-10-12 用户受控重启共享 Router 到 `9641e33` 的构建（新 pid 66944，17:44 起）。

- **TC-TELL-2 通过。**
  - 重启前，`vikunja/main` 把库备份到 `~/.lane-router/backup-pre-v7-20261012-174319/`，已核实该备份是 `user_version = 6`。
  - 重启后的库是 `user_version = 7`，两张表都有「恰好一个发送方」的约束，没有违反的行。`lane` 73、`binding` 137、`message_archive` 3048 与备份一致。`message` 比备份多 3 行，正好是重启之后的一封捎话和一封抄送给两条 lane 的普通信，此外带 label 的行只有那一封捎话。
  - 第 4 步：重启后 `vikunja/main` 发来的普通信，通知里的发件方是 lane 地址，照常送达。
  - ⚠️ 同目录另有一份 `router.sqlite.bak-20261012-094525-post-v7-restart`，它拍在迁移**之后**，是 v7。要回退到旧构建只能用上面那份 v6 备份。
- **TC-TELL-1 只验了一半。** `vikunja/main` 把自己当目标跑了在线一例：文件头是 `sender: user:vikunja`，`request_key` 形如 `tell:<id>`，正文是固定模板，channel 通知确实唤醒了它。已归档与不存在两例都没有写入任何消息，并且拿到了 `cwdHint`。
  - **「准备好但不动手」没有验到**：目标就是发起联调的 lane 自己，它知道这是测试，读到的不是一次真实的讨论请求。
  - 离线、未绑定、真正新建临时 lane 这三种，留给用户在真实任务上点按钮时验证。

### TC-MERGE-1：合并 DSH / ZCode 之后的重启：在用库从 v7（tell）到 v9

合并后的迁移不看版本号，看表结构：`binding` 的 CHECK 里没有 `'zcode'` 就按 v8 的表重建（`'dsh'` 一并补上），`message` 没有 `sender_label` 列就重建两张消息表，全部在一个事务里做完后才置 `user_version = 9`。本机在用库是 tell 的 v7，所以这次只重建 `binding`，不碰两张消息表。

**前提：** 共享 Router 受控重启到 `6c3eb64` 或之后的构建，重启时机由用户决定。

⚠️ `dist/` 现在已经是合并后的构建。Router 若意外退出，被 `ensure-router` 自动拉起时同样会迁移在用库，而且没有事先备份那一步。

⚠️ 2026-10-16 起 `dist/` 是 lane set 的构建（schema 10），下一次重启会从 7 直接迁到 10：第 4 步的 `user_version` 读作 10，另外多出两张空表 `lane_set` / `lane_set_member`，其余预期不变。那次的副本预演见 TC-SET-1。

1. 重启前，用只读方式记下 `lane` / `binding` / `message` / `message_archive` 四张表的行数、`PRAGMA user_version`（应为 7）、`binding` 建表语句里的后端列表（应为 `'claude','codex'`），以及 `SELECT COUNT(*) FROM message WHERE sender_label IS NOT NULL`。
2. 备份 `~/.lane-router/router.sqlite`，并核实备份是 v7。
3. 受控重启共享 Router。
4. 重启后再查同样几项，另跑 `PRAGMA foreign_key_check`。
5. 任选一条在线 lane 用 `lane_send` 发一封普通信，再对一条在线 lane 跑一次 `lane-router-lane tell`，两封都照常送达。

**预期：** `user_version = 9`；后端列表为 `'claude','codex','dsh','zcode'`；两张消息表仍有 `sender_label` 与「恰好一个发送方」的约束；四张表行数和带 label 的行数与重启前相同（按第 1 步的时刻截止，之后新写入的不算）；`foreign_key_check` 为空；第 5 步与重启前无差别。

**副本预演（2026-10-13，未重启）：** 用 SQLite 的 backup API 从在用库（只读打开）拷出一份副本，用 `429b396` 的 `dist/` 打开副本触发迁移；在用库本身和共享 Router 都没有动。

| | 在用库 | 副本，迁移前 | 副本，迁移后 |
|---|---|---|---|
| `user_version` | 7 | 7 | 9 |
| `binding` 后端列表 | `'claude','codex'` | 同左 | `'claude','codex','dsh','zcode'` |
| `lane` / `binding` / `message` / `message_archive` | 74 / 138 / 10912 / 3048 | 同左 | 74 / 138 / 10912 / 3048 |
| 带 label 的消息 | 7 | 7 | 7 |
| 两张消息表的发送方约束 | 在 | 在 | 在 |
| `foreign_key_check` | — | — | 空 |

迁移后副本与在用库逐行比对：四张表按两边共有的列逐字段取摘要，全部一致。参照：2026-10-12 迁到 v7 之前是 73 / 137 / 10837 / 3048，多出的是此后正常新增的 lane、binding 与消息。

**design 独立复验（2026-10-13 18:11，同一份 `dist/`，另拷一份副本）：** 迁移前后都是 74 / 138 / 10913 / 3048（比上表多的一封是 impl 回报合并结果的信），`user_version` 7 → 9，后端列表补上 `'dsh','zcode'`，带 label 的 7 行不变，两张消息表的发送方约束仍在，`foreign_key_check` 为空；四张表按列名排序、按 `id` 排序后整表取 SHA-256，迁移前后一致（这道比对先造过红：改副本里一个字段，摘要就变）；对已是 v9 的副本再初始化一次，什么都不变。

**备份已做（第 2 步）：** 同一时刻从在用库拷出 `~/.lane-router/router.sqlite.bak-20261013-181108-v7-pre-merge`，已核实是 v7。因为 `dist/` 已是合并后的构建，Router 任何一次启动都会迁移在用库；这份是迁移前的回退点，回退时配合合并前的 tell 构建（`9641e33`；更早的构建只认 v6，打不开它）使用。

**最后验证：** 2026-10-16 16:54 真机执行，按上方 ⚠️ 从 v7 直接迁到 v10，构建 `a6aa0b5`。

- 第 1 步读数：`user_version` 7；后端列表 `'claude','codex'`；84 / 148 / 11298 / 3077；带 label 5；两张消息表的发送方约束在；`foreign_key_check` 空。
- 第 2 步：临停前一刻再拷一份 `router.sqlite.bak-20261016-165405-v7-pre-set`（v7，`integrity_check` ok，此时 message 已是 11299）。更早的一份 `…-20261016-163355-v7-pre-set` 也在。
- 第 3 步用 `scripts/restart-router.ps1`：旧 Router（pid 66944）停了，新 Router pid 77532 于 16:54:14 起来并把库迁到 10，但脚本报「Router process did not become ready」退出。原因：`ensureRouter` 只等 15 秒，Router 要先起 Codex app-server 再写 `discovery.json`，这次用了约 18 秒。16:54:32 起 25 条 lane 的 channel 全部接上新 Router（含虚拟机上的 4 条；`start-vm-bridge.ps1` 在 16:54:43 自动换到新端口 54856）。
- 第 4 步：`user_version` 10；后端列表 `'claude','codex','dsh','zcode'`；84 / 148 / 11299 / 3077（多的一封是第 1 步之后正常新到的）；带 label 5；发送方约束在；`foreign_key_check` 空；另有空表 `lane_set` / `lane_set_member`。
- 第 5 步：`lane_send` 到 `lane-router/impl` 一封，`notificationState = sent`；`lane-router-lane tell lane-router/design --origin design --subject …` 一封，退出码 0、`delivered: true`、目标 `online`，并且这封 tell 的 channel 通知当场把 design 自己的会话叫醒了，唤醒链在新 Router 上成立。重启后两分钟内快照里的可达状态：`unconfirmed` 25（刚接上、还没报过生命周期，预期如此）、`live` 1、`no_channel` 41（没开窗口的 lane）。

⚠️ 两个发现：① `restart-router.ps1` 的等待比 Router 启动短，脚本报失败不等于 Router 没起来，下次先看 `discovery.json` 的 pid 再判断；② 期间有一条 lane 的 MCP 自己去拉 Router，被 `router.lock` 挡回（`router-start.log` 首行「Another Router process is already running」），这是预期的守卫，但那次尝试把日志开头覆盖掉了一截，属于已记录的启动竞态问题。

### 2026-10-19 上线：拉取另一台机器的 39 个提交后，在用库从 v10 到 v11

**来源：** `master` 从 `34f69c4` 快进到 `98cee44`（议题收件箱、账号切换、图资源、原生 Company Lead 接入、看板 HTTP 边界重构等，166 个文件）。本机 Router 之前跑的是 lane set 构建（schema 10）。

**步骤与结果：**

1. 依赖。`npm ci` **失败且把 `node_modules` 清掉了大半**：它先删整个目录，而 `better-sqlite3\prebuilds\win32-x64.node` 被在跑的 Router 和二十多个 lane 的 MCP 进程映射着，`unlink` 报 EPERM 中止（在跑的进程不受影响，但此刻任何新起的 MCP / CLI / Router 都会缺包）。处置：把被占用的 `.node` **改名挪到仓库外同一个盘** `E:\xd_projects\lane-router-inuse\`（已加载的文件 Windows 允许移动、不允许删除），删掉残留目录，再 `npm install` 补齐，退出 0。⚠️ 以后在跑着 Router 和 lane 的共享树里用 `npm install`，不用 `npm ci`；账号切换文档说的「在独立安装目录构建」就是为了这个。挪出去的旧文件等映射它的旧进程都退了再删。
2. `tsc --noEmit` 退出 0；`npm run build` 退出 0（含新加的 vite 图资源前端，rolldown 对 `@xyflow/react` 的 `"use client"` 指令有一条告警，不影响产物）。
3. 第 1 步读数：`user_version` 10；后端列表 `'claude','codex','dsh','zcode'`；`lane` / `binding` / `message` / `message_archive` 92 / 156 / 12385 / 3077；`lane_set` 2、`lane_set_member` 13；带 label 6；`foreign_key_check` 空。
4. 备份 `router.sqlite.bak-20261019-093729-v10-pre-v11`（v10，`integrity_check` ok，行数同上）。
5. `scripts/restart-router.ps1`：这次脚本自己报成功（启动在 15 秒内完成）。旧 pid 77532 停，新 pid 78704、端口 65291。
6. 重启后：`user_version` 11；后端列表 `'claude','codex','dsh','zcode','native-codex'`；四张表行数、两个 set 及 13 条成员、带 label 6 封全部不变；`foreign_key_check` 空。`issues.sqlite`、`graphs.sqlite` 首次建出；`router-start.log` 没有 `ISSUES_UNAVAILABLE` / `GRAPHS_UNAVAILABLE`。
7. 页面：`/dashboard`、`/issues`、`/issues/api/threads`、`/issues/assets/markdown-it.js` 都是 200；快照 schema 11、92 条 lane、2 个 set、有 actionToken。重启后一分钟内 channel 重连 18 条，可达状态 live 4 / unconfirmed 15 / no_channel 56。
8. 送信：`lane_send` 到 `lane-router/impl` 为 `sent`；`lane-router-lane tell lane-router/design` 退出 0、`delivered: true`，通知当场叫醒了 design 的会话。
9. **虚拟机桥在这次之前就已经不在了**（`start-vm-bridge.ps1` 的窗口没了，只剩 10-12 起的静态文件服务还在），不是这次重启造成的；已重新在独立窗口里拉起。

**没有做、留给现场验收的：** 议题收件箱、图资源、账号切换三项的真实 lane / 浏览器验收仍按上面各节「尚未执行」。看板顶部的「账号切换」链接指向 `http://127.0.0.1:47839/`，本机没有部署 `lane-router-accounts` 后台，点了打不开；账号切换需要 Company 侧一起接入，不在这次上线范围。

### TC-RESTART-SCRIPT：要停的 App Server 已经跟着父进程退了，重启脚本不再半路中止

**依据：** Vikunja LR-29。2026-10-21 03:17 部署 `1fae7e9` 时，`restart-router.ps1` 停掉 Codex 宿主后中止了。原因是宿主的 App Server 子进程在「检查还在不在」和 `Stop-Process` 之间已经跟着父进程退了，而脚本跑在 `Stop` 错误模式下。结果 Router 停着、新的没起来，直到某条 lane 的 `ensureRouter` 把它拉起。

**行为：**
- App Server 子进程只在同一个 pid 上还是同名、同启动时间的进程时才停，pid 被复用就不碰；已经退了的算停好了。Router 和宿主本身也一样，已经退了的不报错。
- 从停 Router 到新 Router 应答之间要是还出错，脚本会说「Lane Router is not running: the restart stopped partway. Run this script again to start it.」。

**最后验证：** 2026-10-21 12:46–12:50 design 部署 master `33e5ff3`（`restart-router.ps1 -CodexHost`），脚本一路走完：新 Router pid 97656、端口 60690，Codex 宿主 47716 与核心同构建。这次没有遇到子进程先退的情形，所以只核了「受控重启能走完」，竞态那条路径由当初的 6 个场景演练覆盖。同一次部署里，账号后台的监督者第一次拉起子进程报了一次 `STORAGE_UNAVAILABLE`，第二次成功，和本脚本无关，记在 Vikunja LR-51。

## 当前记录

### TC-PROJECT-RESTORE-1：重启后从主 lane 恢复同项目原对话

**目标：** 验证主 lane 调用一次 `lane_restore_project` 后，每条离线 peer lane 都在可见 terminal（默认 Windows Terminal，经共享 terminal 机械件）中恢复原 conversation/session，而不是新建对话或替换 binding。

**Fixture：** 同一项目至少三条 active lane，其中主 lane 已手动恢复，另有一条 Codex peer 和一条 Claude peer 已关闭；各 peer 原对话中都有可辨认的历史消息。

**设置：** 从包含本功能的 build 启动新 Router 和主 lane。不要使用仍在运行的旧 Router；不要更新全局 npm link，除非用户另行要求。

**步骤：**

1. 在主 lane 调用 `lane_directory`，记录三条 lane 的 address、backend 和 binding generation，确认两条 peer 没有客户端连接。
2. 新 Codex thread 或 Claude 调用不带 `lanes` 的 `lane_restore_project`。若主 lane 是升级前创建的 Codex thread，它的旧 dynamic tool 清单无法在 `thread/resume` 时刷新；在该对话的 shell 运行 `lane-router-restore-project`，它使用 `CODEX_THREAD_ID` 调用同一项 Router 操作。
3. 确认每条离线 peer 各出现一个 `Start-Process -WindowStyle Normal` 创建的可见 PowerShell；当前 lane 和已在线 lane 不重复打开。
4. 在 Codex 与 Claude 窗口分别检查原历史消息、工作目录和 lane 工具列表；调用 `lane_directory`，确认各自仍对应原 address 和原 generation。
5. 立即再次调用 `lane_restore_project`，确认已在线或正在启动的 lane 被跳过，不新增重复窗口。
6. 关闭其中一个 peer，等待 30 秒启动保留期后，只指定该 address 再调用，确认只恢复该窗口。tool 使用 `lanes` 数组；旧 Codex CLI 使用位置参数，例如 `lane-router-restore-project alpha/peer`。

**预期：** 每条离线 peer 返回 `launch_requested`，当前/在线/启动中 lane 分别返回对应 `skipped_*`；PowerShell 可见；恢复的是原 conversation/session；binding ID 与 generation 不变。单条失败以 `failed` 返回且不阻止其他 lane。

**最后验证：** 尚未执行。当前实现会构建并运行自动测试，但本 case 需要切换正在使用的 Router 并由人观察多个交互窗口；在实际完成以上步骤前，不得宣称一键恢复的真实闭环已经通过。

### 自动轮换的可见 Windows terminal

**目标：** 验证 `lane-router-rotate` 真正创建用户可见、持续存在的 PowerShell，并从中启动 terminal child 与目标 CLI；不能只凭 Node 的 `spawn` 事件判定成功。

**Fixture：** 一条已绑定 lane、一个位于 `~/.lane-router/rotation-handoffs/` 的 UUID `.md` handoff 文件，以及已构建的 feature worktree。

**步骤：**

1. 在旧 conversation 中说明同地址接替并取得用户明确确认。
2. 从正确 worktree 调用 `lane-router-rotate codex <lane-address> --handoff-file <absolute-path>`。
3. 观察是否出现新的可见 PowerShell；检查进程链是否为 `PowerShell → terminal-child → lane-router-codex → Codex`（2026-08-18 起 terminal child 由 rotation 专用泛化为共享模块，旧名 `rotation-terminal-child`）。
4. 在新 conversation 完成 attach 后，核对 lane 地址、角色说明、cwd、generation 和 pending mailbox；旧 terminal 由用户自行关闭。

**预期：** 新 PowerShell 可见且不会在 launcher 返回后立即退出；Codex 从调用时 cwd 启动。只有新 conversation 报告 attach 成功后，才能把轮换视为完成。

**最后验证：** 2026-08-10 先完成修复前复现：直接 detached `spawn` 触发成功返回并删除 handoff，但没有可见 PowerShell，系统中也没有留下 terminal child 或新 Codex。随后用户确认 `Start-Process` 诊断窗口可见；改用该路径后，真实进程链 `PowerShell → rotation-terminal-child → lane-router-codex → Codex` 已出现，cwd 为 `build-v1`。截至本记录，**只验证到可见 terminal 与 CLI 启动，尚未确认同 lane attach 闭环**。

2026-08-08：当前 V1 commit 的真实 Claude/Kimi 和 Codex TUI 流程未在本次无人值守执行中运行，因为它们需要外部模型、现有账户配置和交互窗口。自动验证结果记录在实现 worklog；不得把该结果解释为真实模型通过。

2026-08-08：Codex launcher 工作目录 case 已由用户迁移真实 `agent_coding_guidelines/workflow-curation` lane 完成验证；该结果只覆盖新 thread 的 cwd 传播和 lane 接替，不代表其余 Codex TUI 手工流程全部通过。

#### TC-ROTATE-FIRST-TURN：预载 prompt 的首 turn 里 attach 一次成功

**目标：** 验证 hook 报告抢在 MCP channel 之前到达时，Router 仍能在**同一 turn**内把两者配对，新对话首个 `lane_attach_current` 不再被拒「lifecycle channel is not live for the current turn」。设计见 `specs/2026-08-10-automatic-lane-rotation.md` §4.2.1。

**前提：** Router 已重启到含本修法的构建（判据：`ClaudeChannelHub` 有 `unplacedReports`——或直接看下面第 3 步的结果，旧构建必然失败）。参与的窗口都是重启之后新起的。

**步骤：**

1. 用 `lane-router-lane new <project>/<lane> --role "..."` 或一次真实 rotate 开出新窗口——两者都把 prompt 预载为 CLI 参数，这正是触发竞态的条件。
2. **不要在新窗口里敲任何字。** 让 bootstrap turn 自己跑：读 AGENTS.md → `lane_directory` → `lane_attach_current`。
3. 看那一次 `lane_attach_current` 的结果。

**预期：** 首 turn 内一次成功；`lane_directory` 里该 lane `reach.state` 为 `live`、`believedBusy` 为 `true`（turn 还在跑）。**旧构建上这一步必然是** `lifecycle channel is not live for the current turn`，且同 turn 重试同样失败——那是本用例的对照。

**关键看点：** 第 2 步那句"不要敲字"不能省。人一敲字就产生新的 `UserPromptSubmit`，配对随之完成，旧构建也会通过——那不是验到了修法，是验到了绕法。

⚠️ **这条修法不覆盖 Router 未运行的情形**：那时 hook 的 POST 根本发不出去，没有报告可暂存。要单独验就先停 Router 再开窗；预期是 MCP server 的 `ensureRouter` 把 Router 拉起、channel 连上、但首 turn 仍然被拒——**这是已知边界，不算回归**。

**最后验证：** 尚未真机执行。自动测试覆盖三态（窗内应用 / 超窗作废且不可重复消费 / 早到的 Stop 以空闲状态应用并放行等待者），并经真实 `ClaudeBackend.validateAttach` 走通首 turn 三条件；变异检验结果见提交说明。

## ZCode CLI

ZCode 会话走 Claude Channel 这条已验证的链路：同一个 lane MCP server（ZCode 是标准 MCP client，当前 stdio 入口显式提供十三项产品工具）、同一套 lifecycle 上报与 join。身份是这条链路唯一的新东西——**ZCode 给 MCP 子进程不传任何会话身份**（initialize 参数与 env 均已实测确认），会话 id 只在 hook 侧存在（stdin 的 `session_id` 与 env 的 `CLAUDE_CODE_SESSION_ID`/`ZCODE_SESSION_ID`）。因此 join key 取共享父进程：同一 app-server 既 spawn 会话的 MCP server 又 spawn 它的 hook，`process.ppid` 相等即配对。

**前提：** 已构建 `dist/`；`~/.zcode/cli/config.json` 同时注册两者（MCP server 见下；hook 必须 `type: "process"`——`type: "command"` 的 shell 会插在中间换掉父进程，join 从此配不上对）；**参与的会话都起于配置之后**（与 Claude 侧同因：MCP/hook 配置在进程启动时载入）。

```json
{
  "mcp": { "servers": { "lane-router": { "type": "stdio", "command": "node", "args": ["<lane-router>/dist/mcp/lane-mcp-server.js"] } } },
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart":     [{ "hooks": [{ "type": "process", "command": "node", "args": ["<lane-router>/dist/adapters/zcode/lifecycle-hook.js"], "timeoutMs": 5000 }] }],
      "UserPromptSubmit": [{ "hooks": [{ "type": "process", "command": "node", "args": ["<lane-router>/dist/adapters/zcode/lifecycle-hook.js"], "timeoutMs": 5000 }] }],
      "Stop":             [{ "hooks": [{ "type": "process", "command": "node", "args": ["<lane-router>/dist/adapters/zcode/lifecycle-hook.js"], "timeoutMs": 5000 }] }]
    }
  }
}
```

自动测试覆盖：hook 报文（joinKey 恒为父 pid、`agent_type` 不触发子代理过滤——ZCode 总带此字段，按 Claude 的 `agent_id` 规则会误杀全部上报、cwd 透传与坏值丢弃、stdin 不可解析时回退 env+`--event` argv、SessionStart 不冒充生命周期事件）、pending 提醒的四种沉默（零积压 / 未 attach 的 404 / Router 不可达 / Stop 事件不提醒），`/claude/pending-summary` 的 200/404/400 与未注入时 404，以及 `mailbox.pendingCount` 的三侧。

### TC-ZCODE-1a：冷启动首 turn 一次 attach

**目标：** 新会话的**第一个** turn（bootstrap prompt 触发）里直接 attach，让冷启动竞态有机会显形：hook 上报可能早于 MCP channel 就绪，报告超 30 秒配对超窗即作废——首次 attach 失败、次轮自愈。原用例第 1 步「attach 前先发一句话跑一个 turn」恰好把这层行为绕掉：那之后的一次成功只证明了暖启动。本条同时是 hook bounded retry 修复的验收用例。

1. 新起一个 ZCode 会话（配置之后），把 attach 作为**第一个** turn（bootstrap prompt 或新会话里敲的第一句话）直接提出，此前不跑任何别的 turn。
2. 看该 turn 内那一次 `lane_attach_current` 的结果。若失败，**逐字记录错误原文**——失败形态是本用例的产出，不得只记「失败了」。
3. 同轮或次轮重试，确认重试成功；成功后 `lane_directory` 应显示 `reach.state=live`、`believedBusy=true`（turn 还在跑）。

**预期：** 首次 attach 允许受竞态影响而失败，但重试必须在同轮或次轮成功。重试仍失败 = hook bounded retry 修复没生效，不是竞态本身。binding 的 conversationId 判据同 TC-ZCODE-1b 第 3 步。

⚠️ **别先发一句话「热身」。** 一暖机就变成 1b，竞态被绕掉——那不是通过，是没测到。与 TC-ROTATE-FIRST-TURN 第 2 步的「不要敲字」同因。

**最后验证：** 尚未真机执行。

### TC-ZCODE-1b：暖启动恢复与精确身份

**目标：** 已跑过 turn 的会话一次 attach 成功；重启（同 id resume）后 binding 仍**精确**认得它。

1. 新起一个 ZCode 会话（配置之后），先发一句话跑一个 turn，让 hook 完成一次上报。
2. 调 `lane_directory`，看目标 `reach.state` 是否 `live`、`believedBusy` 是否随 turn 起落。
3. 调 `lane_attach_current`，**从 hook 输入抓取精确 `session_id`**（真实机器上可在 hook 侧临时打印 stdin，或读 ZCode 日志），断言 `binding.conversationId` 与它**完全相等**——逐字符比对，不是看前缀。
4. 重启该会话（同 id 恢复）后再抓一次 hook 侧 `session_id`、再调 `lane_directory`：id 仍完全相等、generation 不变、binding 仍认得它。

**预期：** 一次 attach 成功；hook 侧 id 与 binding 的 conversationId 逐字符一致，重启后仍相等、generation 不变。

**为什么前缀不够：** `sess_` 前缀只是弱 sanity。它分得开「真实 ZCode id」与「join 失配时 MCP server 的无前缀随机 UUID」，但分不开「这个会话的 sess_ id」与「任何另一个 sess_ id」——旧会话的、子代理的、别的 lane 的 id 同样带前缀（精确同一与唯一都证不了），重启后换了新 id 也照样带前缀（持久性证不了）。只有与 hook 侧真实 id **逐字符相等、且重启后仍相等**才把三者一起锁死。前缀检查保留为辅助快判：无前缀 UUID 一眼即失配，但**过了前缀检查不等于过了本判据**。

**最后验证：** 尚未真机执行。

### TC-ZCODE-2：pending 提醒在真实会话可见

1. 一条已 attach 的 ZCode lane，从另一条 lane 发一封 normal，不 ack。
2. 在目标会话里随便发一句话（触发 UserPromptSubmit hook）。
3. 观察该 turn 是否出现 `Lane Router: N pending message(s)…` 的注入上下文，并读信 ack。
4. 清空积压后重复第 2 步，确认不再注入。

**预期：** 有信注入、无信沉默。第 4 步不能省——只验有信验不出「沉默侧」，跟 NO_COLOR 那条同构。

### TC-ZCODE-3：通知帧的诚实边界

1. 目标会话 idle 时从另一条 lane 发消息，确认 `notificationState` 为 `sent`（帧确实写进了 MCP stdio）。
2. 确认目标会话**不会**自行开出 turn 处理它——ZCode 无 `claude/channel` 支持（bundle 0 命中，已核实），帧被发出去但无人消费。
3. 下一次用户输入时经 TC-ZCODE-2 的提醒路径补投。

**预期：** `sent` 与「无人处理」并存是设计明示的状态，不是缺陷；不要把 `sent` 读成「已处理」。真正的对等唤醒要等 Router 侧驱动面（见下）。

### TC-ZCODE-4：open/rotate 对 ZCode lane 的确定性拒绝（与存量 claude 形态的错分支）

**目标：** 核销 launcher 边界的两侧。新形态（`backend=zcode`，经 `lane-router-zcode` MCP 入口注册）应有确定性优雅拒绝；存量形态（binding 仍记 `claude`，经旧 claude 形态入口注册，如迁移前的 `smoke/zcode-agent`）仍会真的把 ZCode 会话交给 Claude 终端。两条路径的失败形态都要逐字记录。

1. **TC-ZCODE-4a（新形态拒绝）**：一条经 `lane-router-zcode` 入口 attach 的 lane（`lane_directory` 显示 backend 为 `zcode`）。关闭会话使其离线，运行 `lane-router-lane open <address>`。
2. **TC-ZCODE-4b（存量形态错分支）**：一条经旧 claude 形态入口 attach 的存量 lane（backend 仍为 `claude`、conversationId 为 `sess_…`）。同样离线后 `open`。
3. 两条各核对：是否有窗口/进程被拉起、错误原文（4a 预期 `zcode conversations cannot be reopened by the Router yet` 类守卫消息；4b 预期实际执行 `claude --resume <该 sess_ id>` 并由 claude 侧报错）。
4. 失败后 `lane_directory` 与 mailbox 核对：lane 状态、binding、generation、消息全部不受影响。

**预期：** 4a 是优雅拒绝（不开 Claude 终端）；4b 是确定性错误恢复（真的开了 Claude）。**4b 不能省**——只验 4a 会以为边界已全部收拢，实际存量 binding 仍暴露在错分支下，这正是配置要从旧入口迁到 `lane-router-zcode` 的原因。`rotate`/恢复守卫同因，不另立步骤。

**前提：** 4a 需要 Router 已受控重启到 schema v8 构建、且 `~/.zcode/cli/config.json` 的 MCP 入口已从 `dist/mcp/lane-mcp-server.js` 切到 `dist/mcp/zcode-lane-mcp-server.js`（顺序不能反：旧 Router 的 CHECK 约束与 `/rpc` 校验都不认 `zcode`，先切配置会让该会话的所有 lane 调用 400）。

**最后验证：** 尚未真机执行。

### 已知边界（2026-10-07 调研结论）

- **backend 已有正经的 `zcode`（schema v8），launcher 守卫确定性拒绝**：`lane`/`binding` 枚举已含 `zcode`，经 `lane-router-zcode` MCP 入口注册的 binding 记 `zcode`，open/rotate/restore 对它直接拒绝（`zcode conversations cannot be reopened by the Router yet`），不再误启 Claude。**存量风险**：经旧 claude 形态入口注册的 binding（迁移前的会话，含 `smoke/zcode-agent`）仍记 `claude`，恢复时会真的执行 `claude --resume <sess_…>`——配置迁移顺序见 TC-ZCODE-4 前提。真正的 ZCode launcher 等驱动面解锁后实现；手测核销见 TC-ZCODE-4a/4b。
- **首 turn 冷启动竞态**：hook 上报早于 MCP channel 就绪、超 30 秒配对超窗时，首次 attach 失败、次轮自愈。原 TC-ZCODE-1 的暖启动步骤把这层行为绕掉了，现由 TC-ZCODE-1a 专门覆盖（同时是 hook bounded retry 修复的验收用例）。
- **子代理干扰 join 未取证**：同 app-server 内子代理若也触发 hook，其上报会重键共享的 joinKey。真实会话里跑一次 subagent 后核对 `reach` 是否仍指向主会话（TC-ZCODE-1b 第 4 步顺带）。
- **hook 与 MCP 同父未取证**：`type: "process"` 直 spawn 下两者 ppid 应同为 app-server；若真实取证发现中间还有宿主辅助进程，join 需要换键。判据同 TC-ZCODE-1b 第 3 步——join 失配会直接显形。
- **Router 侧驱动面（真唤醒）被账户态挡住**：Router 自拉的 `zcode app-server`（ZCode Protocol，动词表与握手已摸清：`session/create` 收 `{workspace:{workspacePath,workspaceKey}, model:{providerId,modelId}}`，双向 JSON-RPC，`session/requestRuntimePreferences` 须 15 秒内应答）在 `provider/updateAccountConfig` 推送账户态前对所有套餐模型 fail-closed（"Provider Registry 中不存在 Model"，且 create 事务回滚）。协议推送的 schema 已知（`{revision, basedOnZCodeBuiltinRevision, providers, states}`），但裸 stdio 模式下该调用未获响应，成因未明。打通后 Codex adapter 的架构可大比例平移。
