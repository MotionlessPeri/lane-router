# 知识过期：现状核对与成熟做法调研

**状态：** 2026-10-20 的调研记录，供问答议题 `a8d8110d` 讨论改进措施。不是需求稿也不是设计稿：不定插件形态，不定存储位置。

**问题：** 用户最痛的是 agent 不能有效地更新知识，其次是自己看不清有哪些知识。跨项目传递靠通用仓的提升（promote）机制，用户认为够用。本文回答两件事：我们的知识实际过期到什么程度、是怎么过期的；外面有没有成熟方案可以直接用。

## 结论

1. **过期很普遍，而且多数时候更正早就有了，只是不在该在的地方。** 抽样核对的高频页面里，10 条可核对的说法有 3 条已过期、2 条前后不一致或有条件过期；lane-router 项目除本 lane 外的 5 条角色说明里有 3 条带着过期内容。最典型的是 `cc`：通用手册那句「Router 拒收 `cc`」是 08-21 从 mocap 项目的记忆里提升上来的，mocap 的记忆 08-27 就改成了「`cc` 已通」，而手册至今没改。
2. **过期有三种来路**，各自要不同的机制去拦：
   - **改事实的人不知道谁依赖它**：代码改了、部署换代了，引用它的页面没人去碰；
   - **知道的人把更正写在了自己手边**：写进本项目记忆、交接记录，没写回源头；
   - **同一页里新旧并存**：后文已经更正，前文原样留着。
3. **外面没有能整体接入的方案。** 调研过的系统没有一个会因为外部世界变了而自己发现过期：LLM wiki、Mem0、Graphiti 只在新信息写入时检查，Notion、Guru 只按时间到期，Swimm 一类只看代码 diff。真正能用的是**机制**，而且大部分很便宜：读者就地挂标记（Wikipedia、Guru）、事实写明「截至何时」并定期列出到期条目（Wikipedia、Notion）、能写成检查的说法就写成检查对着现实跑（doctest、Doc Detective，以及通用仓已有的 `verify-ue-rendering-refs.py`）。
4. **改进措施里，不少不需要 Router。** 「截至何时」和到期清单、页内标明「已被取代」、把可核的说法写成检查，都可以在规范仓和 `kb.py` 里做。Router 独有的价值在三处：它知道每条 lane 是谁、能给负责的 lane 发信；角色说明本身存在它那里；它能给用户一个跨仓的总览。第四节按这个分开列。

## 一、内部核对

### 1. 抽样一份高频变动的页面

对象是通用仓 `techniques/lane-router.md`（381 行），它描述的是 lane-router 的行为，而 lane-router 几乎每天都在改，能直接对照代码核对。逐条核对其中能对上代码或现状的 10 条说法：

| # | 行 | 手册说法 | 现状与证据 | 判定 |
|---|---|---|---|---|
| 1 | 25 | 首次安装或仓库更新后运行 `npm ci` | lane-router 项目记忆 `shared-tree-npm-install`（10-19）：共享 Router 从这棵树运行时，`npm ci` 会因 `better-sqlite3` 的 `.node` 被占用而把 `node_modules` 删坏一半，要用 `npm install`。该记忆自己写明「即使仓库文档写的是 `npm ci`」 | 有条件过期，更正只在私有记忆里 |
| 2 | 44 | Codex 宿主是独立进程，跨 Router 核心重启存活 | 10-20 刚同步过（`e3c3fb2`） | 准确 |
| 3 | 56、75 | 五项对话工具 | 核心工具仍是 5 项（`src/tools/tool-contract.ts:20-24`）；问答 4 项在手册 250 行之后有；图工具 4 项 `lane_graph_*` 在通用仓全库零提及 | 准确，缺图工具 |
| 4 | 139、364 | terminal child 的进程名 | 139 行说旧名 `rotation-terminal-child` 已于 08-18 改名，364 行排障表仍用旧名 | 页内不一致 |
| 5 | 149 | `lane_directory` 只给 `binding` 与 `reach` 两组字段，无 token 数 | 与 10-20 读到的一致（另多 `model`、`backend`） | 准确 |
| 6 | 166 | `lane_send` 的 `cc` 在 schema 里，Router 拒收 | 08-20 已实现（`019cadd`）；mocap 项目记忆 `lane-router-topology` 08-27 已记「`cc` 已通」；现在的工具说明写着可用 | 过期约 8 周，更正只在私有记忆里 |
| 7 | 198 | `open` 只支持 claude，codex 报「暂不支持」 | 08-27 `ade4344` 删掉了这条报错，`src/process/lane-launcher.ts:163-190` 现在会恢复 Codex 会话；同页 343-352 行的 10-18 恢复流程本身就用 `open` 重开过 Codex 会话 | 过期约 8 周，且与同页后文矛盾 |
| 8 | 201 | `open` 只恢复离线 lane，在线时拒绝 | `lane-launcher.ts:173` | 准确 |
| 9 | 203 | 开窗时会话以 `<project>/<lane> genN` 命名 | `lane-launcher.ts:193` | 准确 |
| 10 | 380 | `lane-router-lane` 端到端尚未真机执行 | 同页 343-352 行：10-18 已在真实环境用 `open` 恢复 10 条会话 | 被同页后文取代，未改 |

合计：准确 5 条，过期 3 条（6、7、10），不一致或有条件过期 2 条（1、4）。样本只有一页，而且是变动最频繁的一页，不能代表全库的比例；它说明的是**变动频繁的事实上，过期是常态而不是例外**。

### 2. Router 里的角色说明

lane-router 项目 5 条 lane 的角色说明（10-20 读 `lane_directory`）：

| lane | 过期内容 | 现状 |
|---|---|---|
| `design` | 「channels 卡在组织托管设置 `channelsEnabled`（服务端当前返回 404，需 Of3d 组织 Owner 开启）；在此之前 Claude backend 的 notify 会被客户端静默丢弃」 | 09-21 起本机建 `managed-settings.json` 即可开启（手册 64-71 行）；本会话正在正常收 channel 通知 |
| `impl` | 「不拥有 `docs/superpowers/specs/` 的设计稿——那是 `lane-router/design` 的」 | 现在出稿的还有 `graph`、`inbox`、`kb` |
| `inbox` | 「用户议题收件箱（/issues，看板上的问题看板）」 | 10-19 统一称「问答」（通用仓 `2179d69`） |
| `graph`、`inbox-impl` | 未发现 | — |

角色说明是写在 Router 数据库里的散文：不进 git，grep 不到，改它还要用户在该 lane 自己的对话里确认。3 条过期里，没有一条有人登记过要改（`inbox` 那条是今天本 lane 登记的 Vikunja #405）。

### 3. 对话记忆

- **分散程度**：本机 `~/.claude/projects/` 下 45 个非空记忆目录，共 690 个文件（10-20 计数）。按官方文档，记忆目录「derived from the git repository」，同一个仓的 worktree 和子目录共用一份，仓外启动的会话按启动目录另起一份（[Claude Code memory](https://code.claude.com/docs/en/memory)）。于是 curve-articulation-maya 一个项目的记忆分在 6 个目录里，共 251 个文件：主仓 118 个，子模块 `extern/curvenet` 两处 34 个，另有 3 个目录共 99 个文件来自**在 `~/.claude/projects/` 记忆目录里启动的会话**，主仓的会话读不到它们。
- **更正留在记忆里**：上面 1、6 两条，正确的说法都已经存在，只是存在某个项目的记忆里。`cc` 那条最清楚：
  - 08-21，mocap 项目的记忆 `lane-router-topology` 记下「`cc` schema 里有、Router 拒收」，同一天这段经历被提升进通用手册（`d2e4942`「统一rotate相关流程」，手册原文与记忆原文几乎逐字相同）；
  - 08-27，mocap 的记忆在同一文件顶部加了「`cc` 已通」并保留旧段落作教训；
  - 手册那段从此没动过。**提升是一次性复制，之后的更正不会跟过去。**
- **一个文件里叠着几代更正**：mocap 的 `lane-router-channel-gating` 正文先写 08-10 的结论，后面接「🛑 2026-08-27 实测：上面那条……已过期」，再接「二次校准：上面那句本身也过头」。最新的结论在最后，最先读到的是最旧的。
- **合并会让指针悬空**：同一文件记了一次实例：三份重复的协议合并成一份后，指向被删那份的引用「读起来完全正常」，但目标已经不在了。

### 4. 通用仓的更正是怎么发生的

通用仓 285 个提交里（03-13 起），按提交信息里「更正 / 修正 / 同步 / stale」这类字眼粗筛，约 10 个是在更正过期或不实的内容（字眼不全，这是下限）。量大的几次都是**集中审计**，不是日常顺手改：

- `6439d67`（07-30）：对照 UE 5.8 源码修 9 份渲染资料，「120+ 处不一致」；
- `bb807ec`（07-30）：修 18 处不存在的源码路径；
- `d6d560c`（07-19）：全库 stale 交叉引用与数字漂移。

渲染资料在那次审计后留下了一个本地的机械校验：`scripts/verify-ue-rendering-refs.py` 逐条核对文中的路径、CVar、符号是否真的存在于引擎源码。这就是「页面声明依赖、机器去核」的做法，只是目前只覆盖这一个领域。

`kb.py lint` 的过期检查只有一条：经验页（`class: experience`）复测超过 180 天报警。`techniques/lane-router.md` 是操作页（`class: procedure`），不在范围内。

### 5. 归纳：三种来路

| 来路 | 本次实例 | 当时谁知道 | 为什么没改到源头 |
|---|---|---|---|
| 改事实的人不知道谁依赖它 | 7（`open` 支持 Codex）、`design` 角色说明（channel 已通） | 改代码 / 部署的 lane | 不知道通用仓、角色说明里有依赖这个事实的话；就算想查，grep 也跨不了仓、进不了 Router |
| 知道的人把更正写在手边 | 1（`npm ci`）、6（`cc`） | 撞到问题的 lane | 源头不归它管，或者写记忆最顺手；记忆只有同一启动目录的会话读得到 |
| 同一页新旧并存 | 4、10、`channel-gating` 记忆 | 写后文的人 | 改了后文，没回头改前文；页内没有「本段已被取代」的结构 |

三种来路里，**第二种的更正已经存在**，代价最小：只缺一条把它送回源头的路。第一种要事先知道依赖关系；第三种靠页内结构或检查。

## 二、外部成熟做法

两路调研都以一手资料为准（官方文档、源码、论文），只有二手来源的已在文中标出。来源清单见文末。

### 1. 什么在触发「发现过期」

| 触发方式 | 代表 | 能拦的 | 拦不住的 |
|---|---|---|---|
| 新信息写入时比对 | LLM wiki 的收录、Mem0 论文版、Graphiti | 新写进来的东西和库里旧说法冲突 | 外部世界变了但没人写进来（`cc`、`open`） |
| 有人要求时体检 | LLM wiki 的 lint、Claude Code `/doctor prompt-audit` | 页面之间互相矛盾、引用了不存在的文件或命令 | 同上；而且要有人记得去跑 |
| 时间到期 | Notion 已验证页面、Guru、Slab、Wikipedia `{{As of}}` | 任何过期，只要到期后有人复核 | 到期之前的那段时间 |
| 代码 diff | Swimm、DOCER、Google IfThisThenThat | 文档引用的代码元素被改名、删除、改动 | 部署状态、偏好、结论；不在被扫描文本里的东西（Router 角色说明） |
| 读者报告 | Wikipedia 维护模板、Guru「request verification」、Slab | 读者撞到的任何问题 | 没人读的页面 |
| 对着现实执行 | doctest、`cog --check`、Doc Detective、本地 `verify-ue-rendering-refs.py` | 能写成断言的事实，包括部署状态 | 写不成断言的（经验、偏好、取舍理由） |

### 2. 各家要点

- **LLM wiki 及其实现**：Karpathy 原文的收录和体检都由人触发，没有盯外部变化的机制。社区实现里，Astro-Han 版（2.5k star）明确把自动钩子和定时运行留给宿主；np6126/mcp-llm-wiki（3 star）在 frontmatter 记每个来源的 `etag`，体检时算 `source_drift`，是唯一会「源变了就标页面」的，但只看 wiki 自己的原始文件。
- **Claude Code**：多个 CLAUDE.md 互相矛盾时「Claude may pick one arbitrarily」。`/doctor prompt-audit`（2.1.283 起，本机 2.1.304）按需查过时或矛盾的指令、引用了不存在的文件或命令，只出报告。默认范围是 CLAUDE.md、AGENTS.md 和 `.claude/` 下的 rules、skills 等，不含记忆，可以传路径指定范围。
- **Codex**：AGENTS.md 离当前目录近的覆盖远的；memories 按「多久没被用到」淘汰（默认 30 天，来源是代码镜像，未在官方仓核实），不按真假。
- **Mem0**：论文版每次写入时检索相似记忆，由 LLM 选「新增 / 修改 / 删除 / 不动」。2026-04 的新算法改成只新增，不再修改和删除，靠检索时按时间挑当前版本。⇒ 让 LLM 自动删旧知识风险高，自家都退回了。
- **Graphiti / Zep**：对照论文和源码核过：新事实入库时与语义相关的旧事实比对，矛盾就把旧的标成失效（`invalid_at`），不删除。必须用图数据库。
- **Swimm**：文档绑定代码元素，CI 比对，小改自动同步，大改把文档标成「potentially out of date」。闭源，默认要把部分代码送到它的服务器，企业版才有本地模式。
- **DOCER**（研究工具）：记下文档上次核验时的快照，找「那时存在、现在消失」的代码元素名。它自己承认抓不到「描述不准确」。
- **IfThisThenThat**（Google 内部，开源重写版 `ifttt-lint`）：用 `LINT.IfChange` / `LINT.ThenChange` 声明成对的两段，一边改了另一边没改就警告。
- **Notion / Guru / Slab / Confluence**：页面有负责人和核验期限，过期后通知负责人；Guru、Slab 允许读者向负责人发「请核验」。全是 SaaS。
- **Wikipedia**：任何编辑者都能在句子上挂 `{{Citation needed}}`、`{{Dubious}}`，在段落上挂 `{{Update}}`；漏写日期由 bot 补，按月的维护分类再由 bot 每周汇总成清单。写作规范禁用 now、currently 这类相对时间，要写「as of 某年某月」并配 `{{As of}}`，模板可带一个「将来去哪核对」的链接。
- **ADR**：被推翻的决定保留并标「superseded」，新旧之间双向链接（`adr-tools new -s`、MADR 的 status）。
- **对着现实执行**：Python `doctest` 跑文档里的示例；`cog --check` 重新生成嵌在文件里的片段，有变化就失败；Doc Detective 在 markdown 里嵌测试步骤（HTTP 请求、shell 命令）直接对产品跑。

### 3. 能直接用、不用开发的

| 工具 | 能做什么 | 限制 |
|---|---|---|
| `/doctor prompt-audit` | 查指令文件里的矛盾和失效引用 | 只出报告；默认不含记忆；没试过对规范仓整仓跑的效果 |
| agents-lint / driftlint | 静态查 AGENTS.md 等文件里的路径、命令还在不在 | 只覆盖路径和命令 |
| `lychee --offline --include-fragments` | 查本地链接和锚点 | 与 `kb.py lint` 的断链检查重叠 |
| `cog --check` | 必须与代码同步的片段（如工具清单、字段表）改由脚本生成 | 要先把片段改造成生成的 |

这些都只能拦一小块，拦不住第一节的主要过期。

## 三、对照：哪种机制拦哪种来路

| 机制 | 改事实的人不知道谁依赖它 | 知道的人把更正写在手边 | 同一页新旧并存 | 代价 |
|---|---|---|---|---|
| 读者就地挂标记（Wikipedia、Guru） | 读者碰巧读到时能拦 | **直接拦**：把更正挂到源头，不必有权改正文 | 能拦 | 低；要约定标记格式和汇总方式 |
| 「截至何时」+ 到期清单（Wikipedia、Notion） | 兜底，晚一个周期 | 兜底 | 让旧说法显出年代 | 低；`kb.py` 已有经验页 180 天复测，扩到全部页面即可 |
| 可核的说法写成检查（doctest、`verify-ue-rendering-refs.py`） | **直接拦**，包括部署状态 | — | — | 中；每条要写断言，只适合事实类 |
| 成对声明 / 快照比对（IfThisThenThat、DOCER） | 改名能拦，前提是对方在扫描范围里 | — | — | 中；Router 角色说明要先导出成可扫描的文本 |
| 写入前比对已有知识（Mem0 论文版） | — | **在写记忆那一刻拦**：发现新记忆和共享页面矛盾就报告 | — | 中高；每次写记忆多一次检索和比对，只能报告不能自动删 |
| 标明「已被取代」（ADR、Graphiti） | — | — | **直接拦** | 低；纯约定 |
| 按需体检（LLM wiki lint、`prompt-audit`） | — | 矛盾在扫描范围内时能拦 | 能拦 | 低；要有人记得跑 |

## 四、供讨论的改进措施

下面只列候选和代价，不做取舍，留到议题里谈。

**A. 不需要 Router，在规范仓和 `kb.py` 里做**（这部分不归本 lane，定了要交给规范仓的负责 lane）

1. **到期清单扩到所有页面**：`kb.py lint` 现在只对经验页查复测期限；扩到操作页、规范页，过期的列出来。
2. **会变的事实写明「截至何时」和「怎么核」**：照 Wikipedia 的写法，禁用「当前在跑的……」这类不带时间的说法。手册里的 `cc`、`open` 两条按这个写，过期时就会进清单。
3. **页内标明「已被取代」**：照 ADR，旧段落标出取代它的新段落，不让读者先读到旧的。
4. **lane-router 手册里可核的说法写成检查**：比如工具清单、`open` 支持哪些后端，照 `verify-ue-rendering-refs.py` 的做法对着 lane-router 源码核。
5. **试一次 `/doctor prompt-audit`**：零成本，看它对规范仓能查出什么。

**B. 需要 Router 出力**

6. **读者标记 + 通知负责 lane**：任何 lane 读到过期内容，都能挂一个带证据的标记，不必有权改正文；Router 按页面找到负责的 lane，往它的 mailbox 发信。标记存哪（写进页面所在的仓，还是存在 Router 里）是下一个要定的事。
7. **角色说明纳入检查范围**：Router 把角色说明作为知识的一部分暴露出来，供改名、到期检查时一起扫。
8. **跨仓总览页**：列出有哪些知识来源、哪些页面挂着标记或已过期，回应「自己看不清有哪些知识」。

**C. 先不做**

9. **写记忆时比对共享页面**：最对症「更正写在手边」，但每次写记忆都多一次 LLM 比对，代价最高；先看 6 能拦住多少，再决定。
10. **依赖声明 + 源头变化就标页面**（Swimm、np6126 式）：只对代码类依赖划算，等 4 做出效果再说。

## 来源

内部证据的文件、行号、提交号见正文。外部来源（P = 一手，S = 二手或仅搜索摘要）：

- P Karpathy, LLM Wiki：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- P Astro-Han/karpathy-llm-wiki：https://github.com/Astro-Han/karpathy-llm-wiki
- P np6126/mcp-llm-wiki：https://github.com/np6126/mcp-llm-wiki
- P Claude Code memory：https://code.claude.com/docs/en/memory
- P Codex AGENTS.md：https://learn.chatgpt.com/docs/agent-configuration/agents-md ；memories：https://learn.chatgpt.com/docs/customization/memories.md
- S Codex `max_unused_days` 默认值（代码镜像，官方仓路径 404）：https://forge.lthn.ai/core/core-agent-ide/commit/c528f32acb4cb8a91c73fa2b41e6a96fb8a50955
- P Mem0 论文：https://arxiv.org/html/2504.19413 ；README（ADD-only）：https://raw.githubusercontent.com/mem0ai/mem0/main/README.md
- P Zep 论文：https://arxiv.org/html/2501.13956 ；Graphiti：https://github.com/getzep/graphiti
- P Swimm Auto-sync：https://docs.swimm.io/features/keep-docs-updated-with-auto-sync/ ；本地模式：https://docs.swimm.io/trial
- P DOCER：https://arxiv.org/abs/2212.01479 ，https://arxiv.org/html/2307.04291v1
- P Chromium IfThisThenThat：https://www.chromium.org/chromium-os/developer-library/guides/development/keep-files-in-sync/ ；`ifttt-lint`：https://github.com/ebrevdo/ifttt-lint
- P Notion：https://www.notion.com/help/wikis-and-verified-pages
- P Guru：https://www.getguru.com/features/verification ，https://help.getguru.com/s/article/when-does-guru-send-me-notifications
- S Slab：https://help.slab.com/en/articles/4136379-post-verification
- P Wikipedia：https://en.wikipedia.org/wiki/Wikipedia:As_of ，https://en.wikipedia.org/wiki/Template:As_of ，https://en.wikipedia.org/wiki/Template:Update ，https://en.wikipedia.org/wiki/Template:Citation_needed ，https://en.wikipedia.org/wiki/Wikipedia:Manual_of_Style/Dates_and_numbers
- P Nygard, Documenting Architecture Decisions：https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions ；`adr-tools`：https://raw.githubusercontent.com/npryce/adr-tools/master/src/adr-new ；MADR：https://adr.github.io/madr/
- P doctest：https://docs.python.org/3/library/doctest.html ；cog：https://cog.readthedocs.io/en/latest/running.html ；Doc Detective：https://github.com/doc-detective/doc-detective ；lychee：https://github.com/lycheeverse/lychee
- P agents-lint：https://github.com/giacomo/agents-lint ；driftlint：https://github.com/alifurkangokce/driftlint
