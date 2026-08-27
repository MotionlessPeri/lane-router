# lane 声明自己的模型 设计

**状态：** 2026-08-27 已批准并实施；同日追加 Codex 模型传递与权威恢复判定。

**一句话结论：** 轮换出来的新对话拿的是 `claude` 的默认模型——产品代码里 `model` 零命中，出让方的模型也不在环境变量里，所以上一代切过的模型不会跟过去。本设计把模型做成**lane 的属性**（跟 `role_description` 并列的一列），由三条开窗路径读出来拼成 `--model`。不改 hook、不读 transcript、不加数据表，迁移是一句 `ALTER TABLE ADD COLUMN`。

## 术语表

| 术语 | 含义 |
|---|---|
| 声明的模型 | 写在 lane 上的模型名，跨代际持久，跟 `role_description` 一样属于「这个角色该怎么跑」。 |
| 漂移的模型 | 某一代对话里用 `/model` 临时切成的模型。它属于那次对话，不属于这条 lane。 |
| 三条开窗路径 | `lane-router-rotate`（轮换）、`lane-router-lane new`（新建）、`lane-router-lane open`（恢复）。它们都通过 `terminal-child` 启动 CLI。 |

## 一、问题

### 1.1 模型不会跟着轮换走

`terminal-child.ts` 的 `childCommand` 给 claude 构造的参数只有三类：`--name <标题>`、`--dangerously-load-development-channels server:lane`、以及 `--resume <id>` 或 `-- <bootstrap prompt>`。**没有 `--model`**。

全树 grep `model`（排除 `modelcontextprotocol`）**零命中** —— 产品代码完全不碰模型。`binding.startup` 是个通用 JSON 位，但至今只写过 `{}`。

⇒ 上一代若切过 `/model`，继任者拿的是 `claude` 的默认值。用户要的是「开新对话用和之前一样的模型」。

### 1.2 出让方不知道自己是什么模型

`claude --model <model>` 存在（收别名或完整名）。难点不在传，在取：**模型不在环境变量里**——扫过一遍，没有任何 `*MODEL*` 之类的会话变量（`CLAUDE_EXE` / `CLAUDE_CODE_EXECPATH` / `CLAUDE_PID` 都与模型无关）。

唯一能实测到当前模型的地方是会话自己的 transcript：`message.model` 字段，本 lane 实测为 `claude-opus-5`（538 条，另有 2 条 `<synthetic>` 需过滤）。

### 1.3 被否掉的第一版设计，以及否掉它的理由

初稿走的是「模型 = 上一代实际在用的那个」：lifecycle hook 把 `transcript_path`（Claude Code 的 stdin 载荷里本来就有，见 `guidelines/claude-code/hook-conventions.md` §5）报给 Router，launcher 在开窗时读那个文件尾部拿到模型。

它能工作，但有两个问题，**第二个是决定性的**：

1. **贵**：要动 hook 载荷、加逐会话事实、读文件、传路径。
2. 🛑 **它是一个棘轮。** 为省 token 临时切一次 sonnet，轮换就把它烤进下一代；下一代再轮换再继承，代代相传，而**没有任何东西会让人发现**。这跟 2026-08-25 修掉的 `NO_COLOR` 是同一个形状：一个临时值沿代际单向传播，且失效是静默的。

⇒ 改成「模型是 lane 的属性」之后，两个问题一起消失：声明是显式的、跨代际稳定，而且**更便宜**（不碰 hook、不碰 transcript）。

## 二、范围基线

按 `auditing-plan-scope` Phase A，在不看候选方案的前提下记录。

**用户要的结果：** 开一条 lane 的新对话时，它跑在这条 lane 该用的模型上，而不是客户端默认值。

**当前用户流程：** 用户轮换或重开一条 lane → 新窗口起来 → 若这条 lane 需要非默认模型，用户得自己在里面 `/model` 切一次，每次都切。

**信任模型：** V1《目标与边界》已定的同机可信个人环境，不改动。

**满足该流程的最小可观测行为：** 一条 lane 可以记下它该用的模型；三条开窗路径按它启动 CLI；没记的 lane 行为与今天完全相同。

这条基线**不包含**：读取或推断某次对话实际在用的模型、模型名合法性校验、按项目或全局设默认、运行中改模型。

## 三、设计

### 3.1 模型是 lane 的属性，不是对话的事实

`lane` 表加一列：

```sql
ALTER TABLE lane ADD COLUMN model TEXT;
```

nullable。**null = 不传 `--model`**，也就是今天的行为——24 条存量 lane 全部保持原样，零破坏。

它跟 `role_description` 并列的理由是它们是同一类东西：**「这个角色该怎么跑」**。review lane 是判官所以要强模型，walkthrough lane 用轻模型就够——这是角色级决定，不是上一代碰巧被切到了什么。

### 3.2 声明优先于漂移（**故意的行为差异**）

若某条 lane 声明了 opus，而用户在那代对话里临时 `/model sonnet` 跑了一阵，**下一代回到 opus，不是 sonnet**。

⚠️ 这与「和之前一样的模型」的字面读法不同：这里的「之前」指**声明**，不指**上一代实际用的**。**2026-08-27 用户明确确认这正是他要的。**

它也正是 1.3 节那个棘轮不会出现的原因：漂移不写回声明，所以不会沿代际累积。

### 3.3 谁设、谁读

| 动作 | 怎么设 / 怎么读 |
|---|---|
| 设 | `lane_attach_current(address, role_description?, model?)`。它本来就是拓扑变更工具、本来就要用户确认，是天然位置。省略 = 不改（与 `role_description` 同语义）。 |
| 设（新建时） | `lane-router-lane new <addr> --role "..." --model <m>`：既用它启动 CLI，也写进 bootstrap prompt 让新对话 attach 时带上。 |
| 读（轮换） | `rotation-launcher.ts` **已经**为了窗口标题发一次 `lane_directory` RPC（:88），从同一份返回里取 `model`，**不新增往返**。 |
| 读（恢复） | `open` 已经查 `/lanes/resume-info`，该响应加 `model`。 |
| 看 | `lane_directory` 的每条返回加 `model`，好让人一眼看出哪条声明了、哪条还没有。 |

`terminal-child.ts` 的 `childCommand` 在 model 非空时于参数前段插入 `--model <m>`；空则完全不插，参数逐字与今天相同。

### 3.4 不做模型名白名单

只校验「非空、去空白后有内容」，**不校验模型名是否有效**。

模型清单会变，硬编码的清单必然过时——而过时的表现是「拒绝一个其实有效的新模型」，属于本语料库反复警告的那类。无效名字的诊断和后续行为交给对应 CLI；Lane Router 只负责逐字传递。

### 3.5 两种 backend 使用各自的模型参数

Claude 由 `terminal-child` 直接接收 `--model <值>`。Codex 先由 `terminal-child` 把声明交给 `lane-router-codex --model <值>`，再由 launcher 把相同参数放到 stock Codex 的全局选项中。两边都不维护模型名清单：无效值由各自 CLI 诊断。真实 Codex 0.148.0 对未知名字会报告缺少 model metadata 并使用 fallback metadata，而不是在本地立即退出；Router 不覆盖这项 CLI 策略。`model` 为 null 时，两种 backend 的参数数组都与引入模型声明前逐字相同。

Codex 的 `reach` 不能用来判断窗口是否在线：共享 App Server 可以在 TUI 关闭后继续加载 thread，使离线 lane 显示 `unconfirmed`。`/lanes/resume-info` 因此同时返回 backend 的 `restorePresence`；`open` 与批量脚本只按这个值决定打开、跳过或报 backend unavailable，`reach` 只保留作通知链诊断。

## 四、范围审计

Phase B 清单——新增或扩大的产品面：持久状态 1 项（`lane.model` 列）、公开接口 3 项（`lane_attach_current` 入参、`lane_directory` 返回、`resume-info` 返回）、命令 1 项（`new --model`）。**没有**新增进程、传输、协议、数据表、信任边界或生命周期机制。

| 候选面 | 消费者与频率 | 需求依据 | 删除后果 | 已有替代 | 处置 |
|---|---|---|---|---|---|
| `lane.model` 列 | 三条开窗路径，每次开窗 | 用户 2026-08-27 原话「模型直接注册到 lane 的信息里」 | 模型仍不跟着走，每次开窗手工 `/model` | 无 | Keep |
| `lane_attach_current` 的 `model` 入参 | 用户设定时；低频 | 上一行的写入口。attach 已是要确认的拓扑变更，语义相符 | 列存在但无处可写 | 无 | Keep |
| `lane_directory` 返回 `model` | 用户与 rotate 启动器 | rotate 靠它取值（复用既有 RPC）；人靠它看哪条声明了 | rotate 要么新增一次往返，要么读不到 | 无 | Keep |
| `resume-info` 返回 `model` | `open`，每次恢复 | `open` 的取值口 | 恢复的窗口拿不到声明 | 无 | Keep |
| `new --model` | 新建 lane 时；低频 | 新建时就该能定，否则要先建再改一次 | 得建完再 attach 一次补声明 | `lane_attach_current` | Keep |
| 从 transcript 推断上一代实际模型 | —— | 无。且它是 1.3 节那个棘轮 | 无当前流程失败 | 声明 | Delete |
| 模型名白名单校验 | —— | 无。清单会过时，过时形态是拒绝有效的新模型 | 无 | `claude` 自己的报错 | Delete |
| 清除已声明模型的入口 | 无当前消费者 | 无。重新声明可覆盖，清空没有已知流程 | 无 | 重新声明 | Defer |
| 项目级 / 全局默认模型 | 无当前消费者 | 无真实需求 | 无 | 逐 lane 声明 | Delete |
| Codex 侧的模型传递 | Codex lane 的三条开窗路径 | 用户批准 Codex 真机补测后发现声明值在 `terminal-child` 丢失 | Codex lane 继续落回客户端默认模型 | stock Codex `--model` | Keep |
| `resume-info.restorePresence` | 单条与批量打开 | `reach=unconfirmed` 会把已关闭的真实 Codex lane 误报在线 | 离线 Codex lane 无法打开 | backend 已有 `restorePresence` | Keep |

`Defer` 只记录决定，不生成待办项、issue 或里程碑。重新评估条件：出现「声明过之后需要退回默认」的真实流程。

## 五、验收标准

1. `lane` 表有 nullable 的 `model` 列；`ROUTER_SCHEMA_VERSION` 为 4，迁移是 3 → 4 的一句 `ALTER TABLE`，不重建表。
2. 旧库迁移后，全部既有 lane 的 `model` 为 null，lane 条数与 role_description 不变。
3. `model` 为 null 时，`childCommand` 构造的参数**逐字**与本设计之前相同（prompt 与 resume 两种模式各验一次）。
4. `model` 非空时，Claude 与 Codex 的 prompt、resume 两种模式都把 `--model <值>` 传给各自 CLI。
5. `lane_attach_current` 传 `model` 则写入；省略则保持原值不变（与 `role_description` 同语义）。
6. `lane_directory` 与 `resume-info` 都返回 `model`，未声明时为 null。
7. `lane-router-lane new --model <m>` 既以该模型启动 CLI，也让新对话 attach 时带上该值。
8. 不新增 RPC 方法、HTTP 端点、数据表；现有 `resume-info` 增加 `restorePresence`，工具数量与名称不变。
9. 不做模型名有效性校验：一个当前不存在的模型名能被正常写入与传出。

## 六、验证方法

自动测试覆盖第 1–9 条：

- **参数构造**：`childCommand` 与 `lane-router-codex` 直接断言四种组合（claude/codex × prompt/resume）在 model 为 null 与非空时的完整参数数组。**这是本设计的牙**——第 3 条（null 时逐字不变）尤其重要，缺了它，实施成「总是插入 `--model undefined`」也能让其余测试通过。
- **迁移**：建一个 version 3 的库，塞入若干 lane，跑迁移，断言列存在、值全为 null、条数与 role_description 逐行不变。
- **写入语义**：attach 传 model → 落库；再 attach 省略 model → 值不变；再 attach 传新 model → 覆盖。
- **返回面**：`lane_directory` 与 `resume-info` 在声明与未声明两种情况下各断言一次。
- **不校验**：写入一个明显不存在的模型名（如 `no-such-model-9`），断言写入成功且原样出现在参数里。

**变异检验**（三态：变异前绿、变异后红、还原后绿，且每个变异只杀掉对应的那一条）：把「null 时不插入」改成「总是插入」、让 Codex 分支丢弃模型、把 attach 的「省略即不改」改成「省略即清空」。

自动测试**覆盖不到**、须进 `docs/manual-tests.md`：

| 用例 | 为什么机器测不了 | 怎么做 |
|---|---|---|
| 真实轮换出来的窗口跑在声明的模型上 | 需要真实 Claude 会话 | 给一条 lane 声明一个与客户端默认**不同**的模型，轮换它，在新窗口里确认当前模型是声明的那个 |
| 声明优先于漂移 | 同上 | 在上述新窗口里 `/model` 切成别的、跑一轮，再轮换一次，确认第三代回到**声明**的模型而不是刚切的那个 |

⚠️ 第一条用例必须挑一个**与默认不同**的模型，否则「传了」和「没传」在观测上一模一样——那不是通过，是没测到。这与 `NO_COLOR` 那条用例是同一个陷阱。

## 七、明确不做

- 不读取、不推断任何一次对话实际在用的模型；不碰 transcript、不改 lifecycle hook 载荷。
- 不校验模型名是否有效，不维护模型清单。
- 不做项目级或全局默认模型，不做运行中改模型，不做清除声明的入口。
- 不新增数据表、RPC 方法、HTTP 端点或对话工具；不改 `ack`、`generation`、通知投递时机或 mailbox 文件格式。
