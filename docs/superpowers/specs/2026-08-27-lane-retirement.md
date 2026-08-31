# lane 退役 设计

**状态：** 2026-08-27 草稿，待用户批准。批准前不得修改代码。

**一句话结论：** lane 没有退场机制，每次架构重构后 directory 就积一层 role 已失义的 lane，而硬删被存储结构堵死——`lane.address` 被三处外键 `ON DELETE RESTRICT` 引用，删它必须先毁掉全部消息历史。本设计把「删除」实现成**退役**：`lane` 表加一个 `retired_at` 列，退役的 lane 从 `lane_directory` 消失、不可再投递、批量开窗跳过，而消息与 binding 历史一个字节不动。入口是 CLI，`lane_directory` 的工具说明里放指针。不新增数据表、不新增对话工具、不碰 mailbox 文件。

## 术语表

| 术语 | 含义 |
|---|---|
| 退役 | 把一条 lane 标记为不再使用。使用者看到的效果等同于删除（目录里没有、发不进去），但存储层什么都没被删。 |
| 活跃 binding | `binding.inactive_at IS NULL` 的那一条，即这条 lane 当前的主人。每条 lane 至多一条。 |
| `restorePresence` | backend 对「这个对话此刻是不是真的开着」的权威判断，取值 `online` / `offline` / `unavailable`。**不是** `reach`——见 3.3。 |
| 消费方情况材料 | `mocap/design` 2026-08-27 转来的使用侧情况。它是**背景**不是需求单：用户当日裁定需求与设计在本对话处理。 |

## 一、问题

### 1.1 lane 只能新增，不能退场

对话工具五个、CLI 四个 bin，全树 grep `deleteLane|retire|archive` **零命中**——没有任何退场路径。而 lane 是持久角色边界，架构一变，按旧架构命名和定职责的 lane 就失义了。

⚠️ **它不是一次性的。** `mocap` 侧的情况材料指出项目还会继续演化，每次重构都会再积一层。所以退役是**反复发生的日常动作**，不是一次性清理——这条直接影响入口形态（见 3.4）。

### 1.2 硬删被存储结构堵死，不是「还没做」

`lane.address` 是主键，被三处外键引用，全部 `ON DELETE RESTRICT`：

```
message.sender_lane  → lane(address)   ON DELETE RESTRICT
message.target_lane  → lane(address)   ON DELETE RESTRICT
message.ack_lane     → lane(address)   ON DELETE RESTRICT
binding.lane_address → lane(address)   ON DELETE RESTRICT
```

而 `src/router/database.ts:10` 无条件 `foreign_keys = ON`。

**实测**（在生产库副本上做，未碰真库）：

| 动作 | 结果 |
|---|---|
| 删 `MobuLiveLink/dev`（被 10 条 message、1 条 binding 引用） | `SQLITE_CONSTRAINT_TRIGGER` 拒绝 |
| **对照组**：新建一条无人引用的 lane 再删 | 成功删 1 行 |
| 关 `foreign_keys` 再删原目标 | 成功，但留下悬空引用的 message 与 binding |

对照组是这组实验的关键：它证明拒绝来自**引用**，不是来自「lane 不可删」这条规则。

⇒ 所以硬删的真实代价是**先毁掉这条 lane 的全部消息历史**。而消息历史有实际取证价值（消费方情况材料给了实例）。**「退役而非硬删」因此不是风格偏好，是唯一可行形状。**

### 1.3 退役解决不了的那件事，要先说清楚

轮换每次都产生一条新对话，旧 binding 转为失效。实测当前：**25 条 lane、63 条 binding（活跃 25、失效 38），`~/.claude/projects/` 下 487 个 transcript 合计 1005 MB**，最大单个 96 MB。

⚠️ **退役一条 lane 不会减少任何 transcript。** 哪怕把一个项目全部退役，那 1 GB 一个字节都不会少——transcript 是 Claude Code 自己的会话存储，不归 Lane Router 管，也不由 `retired_at` 影响。

用户 2026-08-27 裁定：**对话清理是独立的下一个迭代**（方向倾向保留近期、按某种缓存/保留策略清理久远的）。本稿不碰它，写在这里是为了防止有人指望退役顺带解决它。

## 二、范围基线

按 `auditing-plan-scope` Phase A，在不看候选方案的前提下记录。

**用户要的结果：** 重新规划 lane 集合时，能让已失义的 lane 从工作面上消失，而不必忍受 directory 越积越长。

**当前用户流程：** 架构重构 → 旧 lane 的 role 不再契合 → 只能用 `lane_attach_current` 原地改 role 凑合，或者新建一条、把旧地址永远留在 directory 里。

**信任模型：** V1《目标与边界》已定的同机可信个人环境，不改动。

**满足该流程的最小可观测行为：** 一条 lane 可以被标记为退役；退役后它不出现在 `lane_directory`、发不进去、批量开窗不碰它；没退役的 lane 行为与今天完全相同；消息与 binding 历史不受影响。

这条基线**不包含**：删除任何消息 / binding / mailbox 文件、清理 transcript、按项目批量退役、退役原因或备注、地址改名。

## 三、设计

### 3.1 一个列，语义是「使用者眼里它已经不在了」

```sql
ALTER TABLE lane ADD COLUMN retired_at INTEGER;
```

nullable。**null = 在役**，也就是今天的行为——25 条存量 lane 全部保持原样，零破坏。schema v4 → v5，迁移照抄 `model`（v3→v4）与 `cwd`（v2→v3）的先例：一句 `ALTER TABLE ADD COLUMN`，不重建表。

⚠️ **用户说的是「删除 lane」，实现是「退役」，这不是偷换。** 从使用者角度两者可观测行为一致：目录里没有、发不进去、批量开窗不碰。差别只在存储层——历史留着，而那正是它必须留着的理由（1.2）。稿子里保留「退役」这个词，是为了让读代码的人不误以为有东西被删了。

### 3.2 退役改变四件事，且**只有**这四件

| 面 | 退役后 |
|---|---|
| `lane_directory` | **不返回**该 lane（默认隐藏） |
| `lane_send` | 目标已退役时**拒绝**，错误里说明它已退役 |
| `lane_restore_project` 与批量开窗脚本 | **跳过**，不当作可恢复目标 |
| `lane-router-lane open` | **拒绝**，提示该 lane 已退役 |

**不改变**：mailbox 文件（`pending` / `resolved` 一个字节不动）、已有 message 行、已有 binding 行、`generation` 规则、通知投递时机。

### 3.3 什么时候拒绝退役

两条前置检查，各自防一种静默损坏：

**① 目标对话还开着 ⇒ 拒绝。** 否则会把一条还在跑的对话踢成无主，而且因为 directory 隐藏了它，**没有任何人能发现这个状态**。

⚠️ 判「在不在线」用 **`restorePresence`，不用 `reach`**。这条有实测背书：共享 App Server 能在 TUI 关闭后继续加载 thread，使已关闭的 Codex lane 显示 `reach=unconfirmed`；`resume-info` 因此已经在返回 `restorePresence`，直接复用。用 `reach` 会把已关闭的 lane 误判成在线而拒绝退役——**方向是安全的，但会让功能对 Codex lane 基本不可用**。

**② 还有未 ack 的 pending 消息 ⇒ 拒绝**，并报出条数与发信方。退役会让这些消息永远无人处理，而且悄无声息。消费方情况材料给了「靠 resolved 历史定责」的实例，说明这类信息在这个环境里确实会被回头查。

拒绝时两条都要把**具体数字**说出来（在线的说明它是哪个对话、pending 的说明有几条来自谁），否则使用者只能靠猜。

**退役时顺带**把活跃 binding 置为失效（`deactivateBinding`，现成方法）。否则会留下「已退役 + 仍有主人 + 目录里看不见」这种没人能观测到的状态。

### 3.4 入口是 CLI，并且必须配指针

```
lane-router-lane retire       <project>/<lane>
lane-router-lane unretire     <project>/<lane>
lane-router-lane list-retired [<project>]
```

**为什么是 CLI 而不是第六个对话工具：**

- 退役的目标是**已经死掉的** lane，清理时人多半在 shell 里重规划，未必有哪条 lane 开着。MCP 工具需要调用方已 attach（像 `send` / `ack` / `restore_project`），CLI 用合成身份，不需要。
- 它是**反复**发生的动作（1.1），该好用、可脚本化。
- 授权形态**更强不是更弱**：MCP 那套是「agent 提议、用户在对话里确认」，CLI 是人自己敲的，中间没有 agent 的解读环节。
- V1《非目标》已删除「面向用户的管理 CLI」，但 `lane-router-lane` 这个 bin 已经存在（`new` / `open`），退役是同一类「开窗/管窗」动作，加动词不是新增管理面。

🛑 **但 CLI 有一个已被实测咬过的代价，必须配套修掉：不知道就等于不存在。**

2026-08-25 实测：`lane-router-lane open` 一直存在且无项目作用域，而 `mocap/render` 因为自己常驻的工具清单里没有它，得出「跨项目开不了 lane」这个错结论**并转发了出去**。CLI-only 会重演这个。

⇒ 配套（与当日对 `lane_restore_project` 的修法同形，已验证有效）：**`lane_directory` 的工具说明里写明退役走该 CLI**；`lane_send` 拒绝已退役目标时，错误信息里给出 `unretire` 的命令原文。

**`unretire` 为什么现在就做：** 它就是把列写回 null，与 `retire` 同等便宜。不做的话，退役就是一个「不可逆 + 目标从 directory 消失」的操作——而它会被反复使用，迟早退错一条。**`list-retired` 同理**：退役的 lane 不在 directory 里，没有它就无从知道自己退过什么、更无从 unretire。三个动词是一组，缺一个另两个就不好用。

### 3.5 地址不可复用，改名不做

退役的 lane 仍然占着它的地址：`lane_attach_current` 到一个已退役的地址**拒绝**，提示先 `unretire`。

理由是结构性的：历史消息还指着那个地址，让一条新 lane 顶同一个名字会让取证变歧义。

⇒ 这也回答了消费方问的「改址 / 换名」：`lane.address` 是主键且被三处外键引用，改名等于改主键，代价与删除同级。而且**不必做**——`lane_attach_current` 已经能原地改 `role_description`，职责随时可改；地址只是稳定标识符。**痛点真正要解的是退役，不是改名**：废 lane 退役掉之后，名字失义就不再是问题。

## 四、范围审计

Phase B 清单——新增或扩大的产品面：持久状态 1 项（`lane.retired_at`）、公开接口 3 项（`lane_directory` 过滤、`lane_send` 拒绝、`attach` 拒绝已退役地址）、命令 3 项（三个 CLI 动词）。**没有**新增进程、传输、协议、数据表、对话工具、信任边界或生命周期机制。

| 候选面 | 消费者与频率 | 需求依据 | 删除后果 | 已有替代 | 处置 |
|---|---|---|---|---|---|
| `lane.retired_at` 列 | 全部读 lane 的路径 | 用户 2026-08-27「我们先处理删除 lane 这个需求」 | 无退场机制，directory 每次重构积一层 | 无 | Keep |
| `lane_directory` 默认隐藏 | 每次查目录；高频 | 痛点原话就是「directory 会积一层废 lane」 | 退役了但还看得见，等于没退 | 无 | Keep |
| `lane_send` 拒绝已退役目标 | 发信方；每次 | 退役的语义就是「地址不可再投递」 | 消息进了没人看的信箱，静默丢失 | 无 | Keep |
| 批量开窗与 `restore_project` 跳过 | 每次批量恢复 | 同上：退役的不该被当作可恢复目标 | 退役的 lane 被重新开出来 | 无 | Keep |
| `attach` 拒绝已退役地址 | 创建/接替时 | 3.5：地址复用会让历史取证变歧义 | 新 lane 顶了旧名字，历史指向歧义 | 无 | Keep |
| CLI `retire` | 重规划时；低频但反复 | 上述全部的入口 | 列存在但无处可写 | 无 | Keep |
| CLI `unretire` | 退错时 | 3.4：反复使用的不可逆操作迟早退错；成本等同 retire | 退役不可逆 | 无 | Keep |
| CLI `list-retired` | unretire 之前 | 退役的不在 directory 里，没有它无从知道退过什么 | `unretire` 实际不可用 | 直接查 SQLite | Keep |
| 工具说明与错误信息里的 CLI 指针 | 撞到拒绝的 agent | 3.4 实测：CLI-only 会让 agent 得出「做不到」并转发 | 重演 2026-08-25 那次误判 | 无 | Keep |
| 硬删 lane / 删除消息或 binding | —— | 无。1.2 证明代价是毁掉全部历史 | 无当前流程失败 | 退役 | Delete |
| 清理 transcript / 对话保留策略 | —— | **用户裁定为独立的下一个迭代** | 1 GB 仍在，但与本流程无关（1.3） | —— | Defer |
| 按项目批量退役 | 无当前消费者 | 无。逐条退役 + shell 循环即可 | 无 | `for` 循环 | Delete |
| 退役原因 / 备注字段 | 无当前消费者 | 无真实需求 | 无 | `role_description` 可写 | Delete |
| 地址改名 | —— | 3.5：代价同删除，且痛点由退役解掉 | 无 | 改 `role_description` | Delete |

`Defer` 只记录决定，不生成待办项、issue 或里程碑。transcript 那条的重新评估条件由用户在下一个迭代给出。

## 五、验收标准

1. `lane` 表有 nullable 的 `retired_at` 列；`ROUTER_SCHEMA_VERSION` 为 5；迁移是 4 → 5 的一句 `ALTER TABLE`，不重建表。
2. 旧库迁移后全部既有 lane 的 `retired_at` 为 null，lane 条数、`role_description`、`model` 逐行不变。
3. `retired_at` 为 null 时，`lane_directory` / `lane_send` / `open` / 批量开窗的行为**逐字**与本设计之前相同。
4. 退役后：`lane_directory` 不返回该 lane；`lane_send` 以指名「已退役」的错误拒绝；`open` 拒绝；批量开窗与 `restore_project` 跳过。
5. 目标 `restorePresence` 为 `online` 时退役被拒，错误里指明是哪个对话；`offline` 时允许。
6. 目标有 pending 消息时退役被拒，错误里给出条数与发信方。
7. 退役成功时，该 lane 的活跃 binding 被置为失效；mailbox 的 `pending` 与 `resolved` 目录文件数与内容不变；message 与 binding 行数不变。
8. `unretire` 使上述全部行为回到退役前；`list-retired` 列出退役的 lane 与退役时间。
9. `lane_attach_current` 到一个已退役地址被拒，错误里给出 `unretire` 的命令原文。
10. `lane_directory` 的工具说明含退役 CLI 的指针；不新增对话工具、RPC 方法或数据表。**沿 `/lanes/resume-info` 的先例新增 lane 管理 HTTP 端点**。

> ⚠️ **实施期更正（2026-08-27）**：本条初稿写的是「不新增对话工具、RPC 方法、**HTTP 端点**或数据表」，那让 §3.4 的 CLI 入口**无法实现**——`/rpc` 只接受 `LANE_TOOL_NAMES`（`local-server.ts` 硬校验），而退役必须由 Router 执行（「目标在不在线」要读 `restorePresence`，那是 backend 运行时状态，CLI 拿不到；CLI 直接写库会绕过全部前置检查并制造第二个写者）。
>
> 该条的真实意图是**不扩大 agent 可见的对话工具面**，写稿时顺手把 HTTP 端点一并禁掉，是把话说过头了。`/lanes/resume-info` 正是为 `lane-router-lane` 加的同形端点，本设计沿它的先例。对话工具仍是 5 个，agent 可见面不变。用户 2026-08-27 裁定走此路。

## 六、验证方法

自动测试覆盖第 1–10 条：

- **未退役逐字不变**：对 `lane_directory` 的返回、`lane_send` 的结果、`open` 的参数构造各断言一次完整值。**这是本设计的牙**——缺了它，实施成「无条件过滤/拒绝」也能让其余测试通过。
- **迁移**：建 version 4 的库，塞入带 `model` 的若干 lane，跑迁移，断言列存在、值全为 null、其余列逐行不变。
- **两条拒绝各自独立**：`online` 但无 pending → 只因在线被拒；`offline` 但有 pending → 只因 pending 被拒。**分开验**，否则一条实现就能同时让两条测试变绿。
- **历史不受影响**：退役前后数 mailbox 文件数、message 行数、binding 行数，三者逐一相等。这条要数**文件与数据库两侧**——只数库会漏掉「删了文件没删行」。
- **往返**：retire → 断言四面行为 → unretire → 断言四面行为回到初始。
- **不校验**：退役一条不存在的 lane 报明确错误，而不是静默成功。

**变异检验**（三态：变异前绿、变异后红、还原后绿，每个变异只杀对应的那条）：把 directory 过滤改成无条件隐藏、把在线判定从 `restorePresence` 换回 `reach`、去掉 pending 检查、退役时不失效 binding、`unretire` 不清空列。

自动测试**覆盖不到**、须进 `docs/manual-tests.md`：

| 用例 | 为什么机器测不了 | 怎么做 |
|---|---|---|
| 真实在线的 lane 拒绝退役 | 需要真实会话与真实 backend 判定 | 开着一条 lane 的窗口，对它 `retire`，确认被拒且指明对话；关掉窗口再退役，确认成功 |
| 退役后真实 agent 发不进去 | 需要真实 MCP 会话 | 从另一条 lane `lane_send` 给已退役地址，确认收到指名「已退役」的错误 |

⚠️ 第一条必须**同一条 lane 先开后关各试一次**：只试关着的那次，「按 `restorePresence` 判」和「根本没判」在观测上一样——那不是通过，是没测到。

## 七、明确不做

- 不删除任何 lane / message / binding 行，不删除任何 mailbox 文件。
- 不清理 transcript、不做对话保留策略——用户裁定为独立的下一个迭代（1.3）。
- 不做按项目批量退役、不做退役原因或备注字段、不做地址改名。
- 不新增对话工具、数据表、RPC 方法或 HTTP 端点。
- 不改 `generation` 规则、通知投递时机、`ack` 语义或 mailbox 文件格式。
