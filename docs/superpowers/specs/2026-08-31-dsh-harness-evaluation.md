# 迁到 deepseek harness？评估记录与四项决策

**状态：** 2026-08-31 完成的一次性评估与决策记录。**结论：不迁；dsh backend 可行且便宜，用户主动缓做。** 本文存在的目的跟 [`2026-08-12-prior-art-and-build-vs-adopt.md`](2026-08-12-prior-art-and-build-vs-adopt.md) 一样——让这个问题以后不必重问。下次有人说「要不要换到 dsh 上」，读这份，不要重跑。

## 术语

| 词 | 含义 |
|---|---|
| dsh | DeepSeek 官方 agent harness（GitHub `deepseek-ai/deepseek-harness`，CLI 名 `dsh`，TypeScript，Cordis 插件内核，developer preview） |
| `dsh-company` | 第三方 dsh 插件，把 dsh 编排成「AI 软件公司」：根会话当 Founder、可续跑的 subagent 当员工，配工作 DAG、审批、预算与 Web 控制台 |
| 观测看板 | 决策 2 的只读 dashboard，展示 lane 拓扑与消息流 |

## 一、结论

**不迁。** 这不是「dsh 不行」——恰恰相反，评估的结果是给 dsh 加一个 backend **成本落在最低档**：不需要 launcher（dsh 自己能冷恢复会话）、不需要 joinKey 机制（会话 id 持久且可由调用方指定）、通知就是一次 loopback HTTP POST。参照本仓库 `PlatformBackend` 现有形状估：新增约 400–600 行，加十几处 `BackendName` 相关小改，加一次 schema 迁移。

**定性务必记准**：这一条是**已评估、可行且便宜、用户主动缓做**。不是「做不成」，也不是「太贵」。跟 `dsh-company` 结合那条随之一起缓。把它记成「太贵」或「不可行」，将来重新决策时会从错误的起点出发。

缓做的理由不在技术面：当前的痛点是**看不见**——谁给谁发了什么、谁欠着 ack、哪条 lane 堵了，这些今天只能靠翻文件和问。多一个 backend 不缓解这个，观测看板才缓解。

## 二、四项决策

| # | 决策 | 定性 |
|---|---|---|
| 1 | **通信治理层**：在 lane-router 内做机械 enforcement——路由白名单、频率预算、未 ack 背压、强制收件人声明 | 方向已批准，**本轮只出设计稿，不动代码** |
| 2 | **观测看板走独立路线，不做 dsh 插件**：由 Router 进程自己伺服，加只读状态端点加一个静态页路由，浏览器开 Router 端口即看，不新增进程 | 已批准，需单独走 spec 与用户 gate |
| 3 | **dsh backend 缓做** | 已评估、可行且便宜、用户主动缓做 |
| 4 | **顺序：看板先于治理层** | 已批准 |

**决策 2 选独立路线的决定性理由**：可达性与忙碌状态只活在 Router 进程的内存里，文件层根本没有——看板若走 dsh 插件就拿不到这两样，而它们正是要看的东西。加上用户不接受看板依赖一个开着的 dsh web 进程。

看板 v1 的信息面三块：

- **消息流时间线**——发件方到收件方、kind、正文、时间、ack 状态与欠 ack 时长；
- **lane 拓扑**——角色说明、binding 的 generation 与 backend、可达状态、cwd；
- **每条 lane 的 pending 队列**——未处理封数、最老一封积了多久。

**决策 4 的理由**：看板零风险纯只读，立即缓解可观测性痛点；而且**先有观测数据再定治理阈值**——频率预算该定多少、背压从第几封开始，现在没有任何数据支撑，拍出来的数字只会是猜的。

另有一个独立小项，跟上面四项无依赖关系：**notification 组装时带上 `sender` 与正文摘要一行**。Claude CLI 里 `← lane: {...}` 那行目前只有索引字段，看不出谁发的、大概什么事。

## 三、dsh backend 的证据

证据分两层，**必须分开读**：

| 标记 | 含义 |
|---|---|
| 【源码核验】 | 评估方在本机 clone 逐字核过 |
| 【本项目复核】 | **本项目自己**在同一份 clone 上重核过，附引用位置 |
| 【静态分析】 | 只读了包内文档与类型声明，未运行 |
| 【待核】 | 未钉死 |

版本锚：本机 clone `E:\xd_projects\deepseek-harness`，`package.json` 版本 `0.1.0-rc.5`，HEAD `47f9438`。**下面每一条都只对这个版本成立**——dsh 是 developer preview，`/api` 明确没有稳定性承诺。

### 唤醒原语

【源码核验】【本项目复核】`POST /api/session.prompt` 一个调用就完成「按 id 冷恢复 + 投递用户回合 + 唤醒跑 turn」。方法表在 `packages/host/apiproxy/src/fetch/handler.ts:99`；冷恢复在 `packages/api/remotes/src/agent-lookup.ts:162`，`ctx.agents.resume({ resumeSessionId })`，其上的注释写明「Live Agents are reused, ordinary cold sessions resume once per identity」——活着的复用，冷的按身份恢复一次。

【源码核验】【本项目复核】Agent 接口另有三档，`packages/core/agent/src/runtime-types.ts`：

- `followup()`——排一个普通后续回合并**唤醒**，该消息独占自己的 turn；
- `steer()`——插进最近的一步，空闲的会开一个新 turn，正在跑的在下一个步骤边界消费。对应本项目的 correction 语义；
- `inject()`——投递上下文但**不唤醒**，正在跑的在稍后的步骤边界取走，空闲的就一直挂着。

三档跟本项目现有的投递语义对得上，不需要为 dsh 造新概念。

### 会话身份

这一条**评估方的摘要有出入，本项目复核时修正**。

摘要写「会话身份是 `session-<uuid>`」。实际读到的是两条不同的路径：

- `packages/core/session/src/index.ts:866`——store 自己铸的是 `session-<n>`，`private counter = 0`（794 行）是**进程内计数器**，去重只查 `this.store.has(sessionId)`，即只跟**当前进程 store 里的**会话比，不跟磁盘上所有历史会话比；
- `packages/core/agent-loop/src/index.ts:358`——`${id}-session-${randomUUID()}`，这是配置里声明的 agent 走的路径，不是 store 的默认铸法。

**这个出入不推翻结论，但换了理由。** 「不需要 joinKey」成立靠的是另外两件事，都复核过：会话 id 会**持久化**，以及 `session.create` 的请求体接受可选的 `sessionId`（`packages/host/apiproxy/src/api/sessions.schema.ts:105`）——调用方可以自己命名会话。所以 lane-router 要建的会话，身份由 lane-router 自己定，不靠 dsh 铸。

【待核】留下的问题是：**用户自己在 `dsh` 里开的会话，其自动铸出的 `session-<n>` 会不会跨进程重启撞号。** 计数器每个进程从 0 起，去重只看内存里的 store——如果持久层在启动时不预载已有 id，两次运行就都会从 `session-1` 开始。真要做 backend 时这条必须先钉死，因为「接管用户自己开的会话」正是本项目的形态；钉法是开两次 dsh、各建一个会话、看磁盘上的 id。

【本项目复核】另一处小出入：持久化不止 JSONL 一种。`packages/session/` 下同时有 `session-persistence-jsonl`（zstd 压缩，仅这个包里出现 zstd）和 `session-persistence-sqlite` 两个后端。落盘根目录取 `DSH_HOME`，未设时回落 `~/.dsh`（`packages/attachment/attachment-local/src/index.ts:25`）。

### 工具桥：MCP 这条路是关着的，但关在哪一层要说清

评估摘要把这条留成【待核】——「`mcp-client` 转发调用时是否捎带会话标记（如 MCP `_meta`），若带，MCP 路线复活」。**本项目复核，这条可以关掉了，答案是不带。**

- `packages/mcp/` 下构造 `tools/call` 的地方只有一处，`mcp-client/src/tools.ts:73`：`{ method: 'tools/call', params: { name: rawName, arguments: args } }`——没有 `_meta`，没有任何会话标记；
- 同一文件里 `exec` 只被用了两次：取 `exec.signal`（76 行）和往下传（243 行），没有别的用途。

⚠️ **但限制归属要写准，否则将来会照着一个错前提做决定。** 这不是 MCP 协议做不到，也不是 dsh 不知道是谁在调用——`ToolExecution` 接口里**明明白白带着** `readonly agent?: Agent`，注释写「The agent on whose behalf the call runs (set by the agent loop)」（`packages/core/tools/src/index.ts:325`）。身份在桥这一侧**是有的，只是没往协议上放**。

⇒ 所以准确的说法是：**dsh 的 mcp-client 桥不转发会话身份**。往上一层（MCP 协议）和往下一层（dsh 运行时）都不是障碍。推论有两条：其一，`lane_attach_current` 需要「当前会话是谁」，走 MCP 拿不到，所以工具桥推荐原生 Cordis 插件——`ctx.tools.register()` 的 `execute(args, exec)` 能从 `exec.agent.session.header` 取会话 id 与 cwd，转调 Router 现有的 `/rpc`，构造 `CallerContext{backend:'dsh', conversationId, cwd}`，估一两百行；其二，**上游给 `tools/call` 补一个 `_meta` 就能让 MCP 路线复活**，这是一个值得盯的上游变化，不是一堵永久的墙。

（背景：dsh 是单 host 进程承载多会话、每个 MCP server 一条共享连接，所以「哪个会话在调用」本来就必须显式携带，不能从连接推断。）

### 三条风险

1. **`/api` 无稳定性承诺。** 它是给自家浏览器前端用的 BFF，rc 版本，两周出过 6 个 release。本机 clone 是 `0.1.0-rc.5`（本项目核过），评估方报告 2026-08-31 当天 npm 上的 latest 已是 `0.1.1-rc.2`（**本项目未核**）。**这个对比是当日快照，不是长期事实**，重新决策时自己再查一次。集成必须钉版本。
2. **`/api` 无鉴权**，只有 loopback 加 Host 头围栏，源码自述「this fence is not an auth layer」。跟本项目现有的「同机可信个人环境」威胁模型一致，不新增暴露面——但要写进文档，不能默认读者知道。
3. **lane 拓扑必须用平级的根会话，不要用 dsh 的 subagent 树。** 【本项目复核】这条比摘要说的更硬：`agent-lookup.ts` 里有一道专门的围栏，凡是 subagent 拥有的会话，冷恢复直接被拒（`ApiRemoteSubagentSessionOwnership` / `apiRemoteSubagentOwnershipError`，131、141、149、160 四处）。所以不是「子会话续跑要求父会话当时 live」这么软——**通过 `/api` 按 id 恢复一个 subagent 会话会直接报错**。只有根会话的冷恢复是全自动的。

### `dsh-company`

【静态分析】0.1.2，钉 dsh `0.1.1-rc.2`。同一个问题空间的层级式协调插件：持久 mailbox、事件驱动调度、审批与预算与 toolFilter 三档治理、六视图控制台。**未在本机运行过。**

对本项目的价值不在于采纳它，而在于两点：它证明了 dsh 的插件层**足以承载机械治理与观测 UI**（即决策 1 与 2 若将来要迁到 dsh 上并非不可能）；它的 `docs/architecture.md` 是 dsh 插件接缝的现成参考。

## 四、会改变这个结论的事

- **需要第三种 agent CLI 而它恰好是 dsh。** 那时 backend 从「缓做」变成「要做」，本文第三节就是现成的施工依据。
- **上游给 `tools/call` 补上 `_meta` 或等价的会话标记。** 工具桥从原生 Cordis 插件退回 MCP，省掉一个插件的维护。
- **`/api` 从 BFF 转正为有稳定性承诺的公开接口。** 风险 1 消失，钉版本的成本随之下降。
- **观测看板做完之后仍然看不清。** 若真实数据显示痛点不在可观测性而在别处，决策 4 的排序理由就不成立，要重新排。

## 五、诚实边界

- **本文是二手记录加局部复核，不是本项目独立完成的评估。** 原评估在另一个项目的对话里完成（`agent_coding_guidelines`，2026-08-31），本项目**没有重跑**。上面标【本项目复核】的五处是本项目在同一份 clone 上重核并给出引用位置的；标【源码核验】而无【本项目复核】的，是评估方报告的源码级证据，本项目**未逐条复核**。凡要据某条否掉或启动一项工作，先自己核那一条。
- **复核不是抽查一遍就全对了。** 复核了 5 条，其中 **2 条有出入**（会话 id 铸法、持久化后端数量），**1 条把【待核】关掉了**（MCP 不带会话标记）——出错率不低。这正是不能把其余未复核条目当既成事实的理由。
- **`dsh-company` 从未运行。** 关于它的一切都是读包内文档与类型声明得来的。
- **所有源码断言只对 `0.1.0-rc.5` / `47f9438` 成立。** 这是 developer preview，两周 6 个 release；行号尤其会漂，引用行号时配了符号名与文件路径，以符号名为准。
- **npm latest 的比较是 2026-08-31 当日快照**，不是长期事实。

## 六、后续工作项

按序，每项在本项目按仓库惯例走 spec 加用户 gate：

1. ~~dsh 评估记录文档~~——即本文。
2. **notification 带上 sender 与正文摘要**——小改，可单独一个 slice。
3. **看板 v1**：spec、用户批准、实施。新增只读端点与静态页属于公开接口，按惯例需单独说明伺服流程并取得用户确认。
4. **治理层设计稿**（design only）。预挂一个关键设计题：**路由策略是拓扑级配置，修改权限不能交给 agent 自己**——照 `lane_attach_current` 的先例走「在对话里解释 + 用户明确确认」，否则白名单会被被治理的那一方自己放开。

## 佐证指针（同机可达）

- dsh 源码 clone：`E:\xd_projects\deepseek-harness`（`0.1.0-rc.5`，HEAD `47f9438`）。
- dsh 架构此前一轮三票核验记录：`E:\xd_projects\agent_coding_guidelines\_radar\2026-08-17.md`。
- `dsh-company` 包：`E:\xd_projects\dsh_company\dsh-company-0.1.2.tgz`（内含 README 与 `docs/architecture.md`）。
- 原始 handoff：`E:\xd_projects\_agent_private\agent_coding_guidelines\handoffs\2026-08-31-dsh-evaluation-handoff-to-lane-router.md`。
