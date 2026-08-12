# 同类工具调研与「自己做还是换现成的」

**状态：** 2026-08-12 完成的一次性调研与决策记录。**结论：继续自己做。** 本文存在的目的是让这个问题以后不必重问——下次有人说「市面上不是有现成的吗」，读这份，不要重跑。

## 结论

调研了 12 个工具，**10 个自己拉起并拥有 agent 进程**。这不是它们缺功能，是不同的产品：它们的身份、寻址、唤醒**全部建立在「进程是我启动的」这个前提上**。

真正同形态的只有 2 个——同时满足「接管人自己启动的长期会话」**且**「在这些会话之间路由消息」——两个都过不了硬要求：

- **ai-maestro**：`install.sh` 只接受 macOS / Linux / WSL2，tmux 是硬依赖。
- **hcom**：往人正在打字的窗口写字节；名字每次启动随机生成，它自己的文档说「Never hardcode them」。

**没有可换的东西。有不少可学的东西**（第五节），但重新量过之后，真正值得做的只剩一条。

## 一、判据

「同形态」的定义是我们自己的操作模式，不是泛泛的相似：

1. 人**同时开着好几条**长期对话（Claude Code / Codex），并**亲自坐在里面**工作——不是无人值守的 worker。
2. 每条对话绑定到一个**持久的角色地址**（lane）。**对话重启后不需要人重新登记**就该认得回来。
3. lane 之间发**持久消息**：正文在文件里、消息不可修改、更正靠新消息引用原消息、接收方 ack、至少一次。
4. 一条 lane 能**唤醒另一条空闲的** lane，让交接在人没盯着那个窗口时发生。
5. **Windows，不用 tmux。**
6. **它不拥有 agent 进程**——会话是人自己开的，路由器事后接上去。

第 6 条是分水岭。业界绝大多数工具的形态是「并行拉起一队 headless agent，各自一个 git worktree」，那是另一个问题。

## 二、同形态的两个，逐项对照

| | 本项目 | hcom | ai-maestro |
|---|---|---|---|
| 接管人自己启动的会话 | 是（前提） | 是——`hcom start`「runs inside an already-running tool session rather than launching a new one」 | 部分——能发现 tmux 会话并关联，但**好的那条唤醒路径需要启动时注入环境变量**，被接管的会话只能走降级路径 |
| 唤醒空闲会话的方式 | 平台自己的通知：Claude Code Channel 通知、Codex App Server `turn/start`。**不碰 tty，也不碰人写了一半的草稿** | TCP 注入服务 → PTY master，替用户「敲」进字面标记 `<hcom>` | `tmux send-keys` 文本 → 等 150ms → 再单独 `send-keys Enter` |
| 持久角色地址，重启后无需人工重新登记 | 是（前提） | **否**——每次启动随机词命名，绑定靠启动时传入的 `HCOM_PROCESS_ID` | **否**——会话名是**推导**出来的 `{agentName}_{index}`，从不存储 |
| 消息持久化 / ack | 文件、不可修改、更正引用原消息、至少一次、接收方 ack | SQLite（经 hook）；**未见 ack 协议** | JSON 文件，但**可变**——`markMessageAsRead()` 原地重写；未见更正与 ack |
| Windows 原生、不用 tmux | 是 | **未验证**（`writes to a "PTY master"` 是 Unix 说法） | **否**——tmux 是明写的硬依赖 |

## 三、最有分量的证据：终端注入不可靠

这不是我们运气好选对了。**四个互不相干的实现，各自在给同一个毛病打补丁**：

| 实现 | 它被迫加的补丁 |
|---|---|
| GraphCode | 按 2048 字节分块，因为一次 7.3 KB 的写**整个消失**、而发送命令**仍然返回 0**；回车延后 400ms 单独发，否则触发 TUI 的粘贴启发式、消息卡在输入框 |
| 5dive | 回车最多重试 5 次，**仍然记录 SILENT DROPS**，有一次带日期的事故：一篇已批准的内容从未发出，且无任何告警 |
| ClawTeam | 围着 `time.sleep` 盲发两次回车 |
| ai-maestro | 文本与回车拆开、间隔 150ms，否则「回车丢失、agent 就那么闲着」 |
| hcom | 源码注释：不要在终端注入与人打字重叠时吃掉用户草稿 |

我们的操作模式里**每一个窗口里都坐着人**。上面这些故障模式在我们这里不是概率问题，是常态。

## 四、我们不如别人的地方

写下来是为了不自我恭维，这三条都成立：

- **依赖姿态更差。** 走终端注入的工具不受任何组织配置影响；我们的唤醒受 `channelsEnabled` 门控，且依赖两个厂商未公开的通知接口。这是攻击我们最该打的点。
- **消息层不出众。** buzz 的更正语义比我们强（删除与编辑都是独立的签名事件）；thurbox 的投递比我们干净（`UPDATE … RETURNING` 拿 exactly-once）；ClawTeam 已经有 claim-lock-ack 加崩溃恢复加死信队列。我们这块是称职，不是特别。
- **Windows + 不用 tmux 不是我们的差异化。** Grix 与 AgentsMesh 都是 ConPTY、零 tmux。只有「Windows + 不用 tmux + **能接管**」这个合取才是。

真正只有我们有的是两条：**在不是自己拉起的会话上用通知唤醒**（能唤醒人开的会话的工具全都走 tty；不碰 tty 的全都自己拥有进程，没有第三种），以及**一个新进程能重新认领的角色地址**（agent-console 的别名绑在厂商的对话 UUID 上，新开一个对话就是新地址；hcom 是每次随机；ai-maestro 从 tmux 会话名推导）。

## 五、考虑过采纳、逐条重新量之后的处置

初评时按「那些实现里做了多少工作」排序，这是错的——应该按「我们有没有它防的那个故障」。用本项目的 `扩张由证据触发` 重量之后：

| 想法 | 来源 | 处置与理由 |
|---|---|---|
| **「你不在时」摘要** | GraphCode | **保留**，但**并进轮换的 handoff 文件**，不要并排再造一套。我们已经有耐久的那一半（消息保持 pending，attach 后补投）；缺的只是呈现形式 |
| 唤醒风暴控制（合并 + 递增冷却 + 人/agent 权限之分） | Paperclip | **不做**。我们已合并同一 lane 的多条通知；递增冷却防的「反复唤醒却无产出」未发生过；权限之分属于多租户威胁模型，与本项目「同机可信个人环境」不符 |
| `awaitingInput` 在场档 | GraphCode | **不做**。停在权限提示前的会话**确实**在一个未结束的 turn 里，`believedBusy: true` 是对的。加这一档只区分「在算」与「在等人」，不修任何缺陷 |
| 回复策略三态 + 防乒乓 | CompanyHelm | **不做**。每条 lane 里坐着人，人就是环路守卫；且 `lane_ack` 与 `lane_send(reply_to)` 已经把「处理完」和「回话」分开了 |
| 注册表防损坏 | Grix | **不做**。正文本来在文件里，`mailbox.reconcile` 能从文件重建记录 |
| 死信隔离 | ClawTeam | **不做**。消息由 Router 自己写入，读不出来的情况基本不存在 |
| 角色图与升级路由 / 地址发现工具 | 5dive / CompanyHelm | **不做**。`lane_directory` 已是发现工具；人在环的升级由 `role-lane-coordination` 承担 |
| 跨机签名日志与断线重放 | buzz | **Park**。没有跨机需求。真要跨机时，这是比本表其余全部加起来都大的改动，须先出稿 |

## 六、两个具体产品的定性

**hcom**（Rust，164 个源文件，约 11 个 agent CLI）——最接近的一个，机制由本项目直接读源码确认：

- `src/pty/inject.rs`：*"TCP injection server — accepts text on a local port and writes to PTY master."*
- `src/notify/wake.rs`：*"TCP wake — connect-and-close pings that unblock poll loops in target processes."*（唤醒的是 hcom 自己的轮询循环，不是 agent 的 turn）
- `src/hooks/claude.rs`：*"A wake is only ever the exact `<hcom>` marker. In particular, do not consume a user's draft when terminal injection and typing overlap."*
- `src/commands/start.rs`：*"Runs inside an already-running tool session rather than launching a new one."*

所以它**能**接管你自己开的会话，但那条路上消息是靠 hook 在你**下一次跑 turn 时**插进来的；**把空闲会话叫醒需要它拥有那个 pty**。

**Grix**（`grix.im`）——原始问题里被提到的那个，实测**方向相反**：`grix-connector` 用 ConPTY 自己拉起 `claude --name grix-<id> --session-id|--resume …`，进程池化、空闲约 5 分钟驱逐；唯一在理论上能接管外部 agent 的代码路径是**未被引用的死代码**。产品定位是把工作留在 IM 里而不是散落在终端——**人坐在 Grix 的聊天客户端里，不坐在 CLI 里**。

另需避坑：`grixprotocol` / grix.finance 是无关的 DeFi 项目，Rust 的 `grix` crate 也无关。

## 七、会改变这个结论的事

- **需要第三种 agent CLI**（我们只支持 Claude 与 Codex，hcom 支持约 11 种）。若届时该厂商不提供任何通知接口，答案是**混合传输**——通知唤醒用于 Claude/Codex，注入唤醒隔离到那些 lane——而不是整体迁移。若走到这一步，第五节里被否掉的在场判定会**变成必需**，因为注入进有人的窗口正是我们刻意避开的那件事。
- **lane 需要跨机器**。届时文件 mailbox 需要 buzz 那套 per-channel 水位加断线重放。**先出稿再动**。
- **`channelsEnabled` 被组织收走**。这是我们唯一的单点依赖。发生时唤醒会静默失效（发送侧仍报 `sent`），`reach` 会显示通知在前进而 lifecycle 不动。

## 八、诚实边界

- **调研范围不等于全部范围。** 覆盖的是一份策展清单（`awesome-agent-orchestrators`，90+ 条）加针对性检索，**不是穷举**。「没有同类工具」这句话的正确读法是「在上述范围内没有」。这个品类每周都在长新东西，本文有日期。
- **证据分层**：hcom 的机制由本项目**亲自读源码**确认（上引四段原文）。其余 11 个由并行的调查者给出，它们报告为源码级证据，**但本项目没有逐个复核**。凡涉及否掉某个候选的关键事实，重新决策前应当自己复核一次。
- **一处已修正的错误**：调研备忘曾把 ai-maestro 发送 `notifications/claude/channel` 列为「绕过 `channelsEnabled` 的可能后路」，并当成最高价值的未决问题。**不成立**——那正是本项目自己在发的 method（见 `src/adapters/claude/channel-bridge.ts`），受同一个门控。调查者没有本项目的上下文，协调者有。
- **成本**：一次性并行调研耗约 208 万 subagent token、26 分钟。结论值这个价（它把「要不要推倒重来」一次性关掉了），但这个量级不适合作为常规动作。
