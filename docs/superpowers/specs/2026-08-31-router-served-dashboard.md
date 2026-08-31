# 由 Router 自己伺服的观测看板 v1 设计

**状态：** 设计稿。来源：2026-08-31 dsh 评估 handoff 的决策 2 与工作项 3（见 [`2026-08-31-dsh-harness-evaluation.md`](2026-08-31-dsh-harness-evaluation.md)）。用户已批准方向与「走独立路线、不做 dsh 插件」的选型。

## 术语表

| 词 | 含义 |
|---|---|
| 看板 | 浏览器打开 Router 端口就能看的一个只读页面 |
| 快照 | 一次请求返回的、属于**同一时刻**的全部看板数据 |
| 欠 ack 时长 | 一封消息从写入到现在还没被 ack 的时长 |
| 可达状态 | `reach`：通知这条路当前是什么状况。**只存在于 Router 进程内存里**，文件层和数据库里都没有 |

## 一、问题

今天要回答「谁给谁发了什么、谁欠着 ack、哪条 lane 堵了」，只能翻文件加查库加挨个问。三件事各自的现状：

| 想知道 | 今天怎么查 |
|---|---|
| 消息流 | `~/.lane-router/mailboxes/**/pending/*.md` 逐个打开，已 ack 的还得去 `resolved` 里找 |
| lane 拓扑 | `lane_directory`，**一次一个项目**，且只有 agent 在对话里能调 |
| 谁堵了 | 没有直接手段。要交叉比对 pending 目录与各 lane 的在线状态 |

**这三件事没有一个能被人在浏览器里一眼看完**，而它们恰好是判断「协作有没有卡住」需要的全部。

### 1.1 最要紧的那两个字段，只有 Router 进程知道

`reach`（通知通道状态、最近一次生命周期事件、是否 believedBusy）由 backend 在**内存里**维护——Claude 侧来自 channel 的连接与生命周期上报，Codex 侧来自 App Server 的 `turn/completed` 与 `thread/status/changed`。

⇒ **任何不住在 Router 进程里的看板都拿不到它们。** 这是选独立路线（Router 自伺服）而不是做 dsh 插件的决定性理由，不是偏好。

### 1.2 三个面必须是同一个时刻

拓扑说某条 lane 在线、而队列说它欠着 12 封——这两句只有出自**同一个时刻**才能一起读。分三次取会得到三个时刻，读的人无从判断矛盾是真的还是取数错开了。

## 二、范围基线

用户能多做的事，只有一条：**打开浏览器，一眼看到当前的消息流、lane 拓扑、各 lane 的积压。**

不在范围内：**任何写操作**。看板上没有按钮——不能发消息、不能 ack、不能退役、不能重启。理由见 3.5。

## 三、设计

### 3.1 两个 GET，别的什么都不加

沿 `/lanes/resume-info` 与 `/lanes/retired` 的先例（`local-server.ts` 的 `handle()`，每条由一个可选依赖守门）：

| 路径 | 返回 |
|---|---|
| `GET /dashboard` | 页面本身，`text/html` |
| `GET /dashboard/state` | 一次快照，`application/json` |

**为什么快照是一个端点而不是三个**：1.2。三个面是一个视图，一次取回才是同一个时刻。

**为什么不是 WebSocket**：升级路径今天只服务 `/claude`（`local-server.ts` 的 `upgrade` 处理里 `pathname === "/claude"` 之外一律 `socket.destroy()`）。为看板加第二种协议，换来的只是把几秒的轮询延迟变成即时——而看板是给人看的，人本来就是几秒一瞥。**轮询，页面自己定时重取。**

### 3.2 页面是一个自包含文件，不取任何外部资源

单个 HTML，样式与脚本内联，**不引用任何 CDN、字体、图标**。三条理由，每条单独成立：

1. 这台机器可能没有外网；
2. 外部依赖会把「同机可信」这个威胁模型撕开一个口子；
3. 看板要能在 Router 起着、别的什么都没有的时候用。

页面**随构建产物走**（`dist/` 下的一个文件），由端点读盘后返回。不把 HTML 拼进 TypeScript 字符串——那会让它既难改又难读。

### 3.3 快照的形状

```json
{
  "capturedAt": 1788179534201,
  "router": { "pid": 27180, "port": 52494, "instanceId": "…", "schemaVersion": 5 },
  "lanes": [
    {
      "address": "lane-router/impl", "project": "lane-router",
      "roleDescription": "…", "model": "opus", "retired": false,
      "binding": { "backend": "claude", "conversationId": "…", "generation": 1, "cwd": "E:/…", "attachedAt": 1788177744405 },
      "reach": { "state": "live", "lastLifecycleAt": 1788177763531, "lastNotifiedAt": null, "believedBusy": false },
      "pending": { "count": 2, "oldestCreatedAt": 1788179172784 }
    }
  ],
  "messages": [
    {
      "id": "…", "sender": "lane-router/impl", "target": "lane-router/design",
      "kind": "normal", "replyTo": "…", "createdAt": 1788179172784,
      "state": "pending", "resolvedAt": null, "ackLane": null,
      "notificationState": "sent", "body": "…"
    }
  ],
  "truncated": { "messages": true, "limit": 200 }
}
```

三点说明：

- **`lanes` 覆盖全部项目**，含已退役的（带 `retired: true`）。今天 `listLanes(project)` 必须给项目名，所以要一个不带项目的读方法——照 `listRetiredLanes(project | undefined)` 已有的先例，传 `undefined` 即全部。**只加读，不加写。**
- **`messages` 必须有界。** 库里现有 4609 行，`allMessages()` 会把它们全搬进内存再序列化。取**最近 `limit` 封（按 `createdAt` 倒序，默认 200）**，并用 `truncated` 如实说自己截断了——一个不说自己截断的列表会被读成「就这些」。
- **`pending.count` 与 `oldestCreatedAt` 在服务端算**。让页面拿全量消息自己数，等于把「有界」这个约束丢掉。

**欠 ack 时长不进快照**：它 = `capturedAt − createdAt`，页面自己减。**服务端不发送可以由已有字段算出的量**——多一个字段就多一处会跟它的两个来源不一致的地方。

三处实施期裁定（本稿初版未规定，此处补齐；上面的示例是示例，不是穷举的契约）：

- **`reach` 整份透传**，不是上面示例里那 4 个字段。重投影会多出一处必须跟着 `ReachSnapshot` 变的地方，而 `lane_directory` 本来就是整份返回。⚠️ 尤其 `connectedAt` 不能丢——它正是分「连上了但还没跑过 turn」与「live」的那个字段，而这个区分是看板存在的理由之一。
- **正文读不到时是 `null`，不是 `""`。** 空正文是合法的，「文件读不到」是另一回事——两者若都编码成空串，就把「缺席的两种成因」合并成了一个观测。页面显示「（正文读不到）」。
- **不带项目的读方法就写成不带参数**（`listAllLanes()`），不照抄 `listRetiredLanes(project | undefined)` 的签名。看板永远要全部，一个只会收到 `undefined` 的参数是凭空多出来的取值。先例借的是「可以有一个不按项目筛的读方法」，不是那个签名。

### 3.4 正文是外部数据，页面必须当数据渲染

看板要显示消息正文（决策 2 明列），而正文是**另一条 lane 写的**。它现在要进浏览器。

⇒ **硬约束，不是建议**：

- 页面构造 DOM **只用 `textContent`，禁止 `innerHTML`**。角色说明、正文、lane 地址、cwd 一律如此——它们全都来自 lane 或用户输入。
- 状态端点返回 **JSON，永不返回 HTML 片段**。服务端不做任何拼装。
- 页面**不执行**快照里的任何字符串。

这条要有测试钉：喂一封正文含 `<script>` 与 `<img onerror=…>` 的消息，断言它**作为可见文本原样出现**。

⚠️ 这跟 [`2026-08-31-notification-says-who-and-what.md`](2026-08-31-notification-says-who-and-what.md) §3.5 是同一类问题的**不同一半**：那边的读者是 agent，风险是把内容读成指令；这边的读者是浏览器，风险是把内容**执行**成脚本。两边的缓解手段不通用，得各做各的。

### 3.5 只读，而且这是安全设计不是省事

看板上不放任何写操作，理由是**放了就得回答一个今天不必回答的问题**：

Router 的 HTTP 面绑在 loopback（`local-server.ts` 构造函数里硬性拒绝非 loopback 绑定），**没有鉴权**——这跟现有威胁模型一致：同机可信个人环境。今天这个面上的写操作只有两个入口：`/rpc`（校验 `LANE_TOOL_NAMES`，调用方带 `CallerContext`）和 lane CLI 的退役端点。

一旦看板上出现一个「退役」按钮，**同机任何一个能发 HTTP 请求的东西**（包括你打开的任意一个网页里的脚本）都能按它。那需要一层今天不存在的鉴权。

⇒ **只读是把这个问题挡在门外**，不是功能没做完。

⚠️ 但只读也不是零暴露：**`GET /dashboard/state` 会把全部 lane 角色说明与最近 200 封消息正文交给任何一个能请求 loopback 的本机进程。** 这比现状多暴露了什么，要如实写进文档——今天要读到同样的内容，需要读 `~/.lane-router/` 下的文件，那是**文件系统权限**管的；换成 HTTP GET 之后，管它的只剩「进程能不能连 loopback」。**这是一次真实的暴露面扩大**，在同机可信模型下可以接受，但不能不说。

### 3.6 页面的三块与它们各自的关键看点

| 块 | 显示 | 最要紧的一列 |
|---|---|---|
| **消息流** | 时间倒序：发件方 → 收件方、kind、正文、时间、ack 状态 | **欠 ack 时长**——它是唯一能看出「有人没在处理」的量 |
| **lane 拓扑** | 地址、角色说明、backend、generation、cwd、model、可达状态 | **`reach.state` 与 `believedBusy`**——1.1 里那两个只有 Router 知道的 |
| **积压队列** | 每条 lane 的未处理封数、最老一封的时长 | **最老一封的时长**，不是封数。10 封新的不如 1 封压了两天要紧 |

**退役的 lane 默认折叠**，可展开。它们不该占据视线，但也不该消失——「这条 lane 去哪了」是个真实会问的问题。

## 四、范围审计

| 新增 | 删除测试 | 判定 |
|---|---|---|
| `GET /dashboard/state` | 拿掉 ⇒ 没有任何数据 | **留** |
| `GET /dashboard` | 拿掉 ⇒ 只有 JSON，人要自己拼页面 | **留**——「一眼看完」是基线要求 |
| 不带项目的 lane 读方法 | 拿掉 ⇒ 只能一次看一个项目，正是今天的痛点 | **留**，且**只加读** |
| 最近 N 封消息的读方法 | 拿掉 ⇒ 只能 `allMessages()` 全量 | **留**——有界是硬要求 |
| `pending` 的两个聚合 | 拿掉 ⇒ 页面得拿全量自己数，有界失效 | **留** |
| `truncated` | 拿掉 ⇒ 截断后的列表被读成全部 | **留**——这是 1.2 那类错误的另一个面 |
| ~~欠 ack 时长字段~~ | ⇒ 页面少做一次减法 | **删**——可由已有字段算出，见 3.3 |
| ~~WebSocket 实时推送~~ | ⇒ 延迟从几秒变即时 | **删**——第二种协议换几秒延迟，见 3.1 |
| ~~看板上的写操作~~ | ⇒ 能直接操作 | **删**——见 3.5，会拉出一个鉴权需求 |
| ~~鉴权 / 令牌~~ | ⇒ 写操作可以有了 | **删**——没有写操作就没有这个需求；先加需求再加机制是反的 |
| ~~历史图表 / 统计 / 趋势~~ | ⇒ 更好看 | **删**——决策 4 说得明白：**先有观测数据再谈**。v1 的用途是产出那批数据 |
| ~~新进程 / 新端口~~ | ⇒ 与 Router 解耦 | **删**——用户明确拒绝；且 1.1 那两个字段就在 Router 进程里 |

## 五、验收标准

1. `GET /dashboard/state` 返回一次快照，含 `capturedAt`、`router`、`lanes`、`messages`、`truncated` 五个顶层键。
2. `lanes` 覆盖**全部项目**的全部 lane，退役的带 `retired: true` 一并返回。
3. 每条 lane 带 `binding`（无绑定时为 `null`）、`reach`（backend 缺席时为 `null`）、`pending.count` 与 `pending.oldestCreatedAt`（无积压时 count 为 0、oldest 为 `null`）。
4. `messages` 按 `createdAt` 倒序，长度不超过 `limit`（默认 200）；库中消息多于 `limit` 时 `truncated.messages` 为 `true`，否则为 `false`。
5. `GET /dashboard` 返回 `text/html`，页面不引用任何外部主机的资源。
6. 页面把正文、角色说明、cwd 一律用 `textContent` 写入；正文含 `<script>` 或 `<img onerror=…>` 时，它作为**可见文本**出现，不产生任何脚本执行或元素注入。
7. 快照里不含任何可由其余字段算出的派生量（尤其没有欠 ack 时长）。
8. 两个端点都是 `GET`；**没有新增任何 POST、RPC 方法或对话工具**。
9. 状态存储只新增**读**方法；`ROUTER_SCHEMA_VERSION` 不变，无迁移，表结构不变。
10. Router 仍然只绑 loopback；非 loopback 绑定仍被构造函数拒绝。
11. 两个端点在依赖未注入时返回 404，与 `/lanes/retired` 的现有行为一致——看板是可选面，不是 Router 的必需件。
12. 通知、投递、ack、退役的行为**逐字不变**：本设计不改变任何既有写路径。

## 六、验证方法

- **快照形状**：造 3 个项目、含 1 条退役 lane、若干在役 lane（有的有 binding 有的没有），断言 2、3。
- **有界**：造 `limit + 5` 封消息，断言返回 `limit` 封、倒序、`truncated.messages === true`；再造 `limit − 5` 封，断言 `false`（4）。**两侧都要造**，否则实现成恒 `true` 也全绿。
- **注入**：正文写 `<script>alert(1)</script>` 与 `<img src=x onerror=alert(1)>`，断言快照里原样、页面渲染后**该文本可见且 DOM 里没有新增 `script` / `img` 元素**（6）。这条**先造红**——把渲染改成 `innerHTML`，它必须失败。

  **这条需要一个真 DOM，所以本设计接受一次 devDependency 新增（`happy-dom`）。** 理由是它换掉了什么：没有真 DOM 就只能拿一个自己写的转义函数去断言，而那测的是那个函数，不是页面——**判官成了被测方的作者**。断言必须落在 `textContent` 与 `innerHTML` 真实语义的差别上，因为那正是被测性质本身。⚠️ 这个依赖**不是可有可无的实施细节**：删掉它，第 6 条这个安全相关的判据就失去独立判官。

  ⚠️ 两条实施期实测的边界，写在这里免得下一个人重踩：**该版本（20.12.0）解析内联脚本进树但从不执行它**（脚本元素在、文本完整、无 console 输出、无 error 事件）。做法是从**解析后的文档**里取出页面自己的脚本文本再执行——仍是浏览器会跑的那段，判官仍是 happy-dom 的真 DOM。**不覆盖「页面自己被加载起来」，那条归真机用例。** 其次：这类测试的第一版红**可能是假红**——红在「页面压根没渲染」而不是红在牙上。⇒ 必须配一条前提断言（例如「先断言某个正常字段出现了」），否则会把 harness 坏了当成测试有牙。
- **只读**：对两个路径发 POST，断言 404 或 405；断言 `LANE_TOOL_NAMES` 未变（8）。
- **无迁移**：断言 `ROUTER_SCHEMA_VERSION` 与迁移链未变，既有迁移测试仍绿（9）。
- **机械证据**：`git diff --name-only` 对 `src/router/schema.ts`、`src/tools/`、`src/mcp/`、`src/router/router-core.ts` 的写路径为空（8、9、12）。
- **变异检验**（每条要写清凭什么会红）：`truncated` 恒为 `true`；`lanes` 只返回一个项目；`pending.oldestCreatedAt` 取最新而非最老；渲染改用 `innerHTML`；端点改成接受 POST。
  ⚠️ 参照 [`2026-08-31-notification-says-who-and-what.md`](2026-08-31-notification-says-who-and-what.md) §6 的判例：**写下每个变异时先说出它凭什么会红**。上一稿有过一个恒绿的变异，实测 283 个测试一条不红。
- **真机**：Router 重启到本构建后，浏览器打开 `http://127.0.0.1:<port>/dashboard`，人眼确认三块都有内容、退役 lane 折叠、欠 ack 时长在走。进 `docs/manual-tests.md`，标明尚未执行。

## 七、明确不做

- **不做任何写操作，也不做鉴权。** 两者绑在一起：没有前者就不需要后者（3.5）。
- **不做实时推送。** 轮询（3.1）。
- **不做图表、统计、趋势。** v1 的用途是**产出**做这些判断所需的数据（决策 4）。
- **不做跨机访问。** 仍然只绑 loopback。
- **不改任何既有写路径。** 本设计是纯增量的读面。

## 八、这份稿子会被什么推翻

- **快照太大。** 200 封带正文可能已经几百 KB。若实测卡顿，先砍正文（列表只给摘要，点开再取单封），**不要**先上 WebSocket——那是解决另一个问题的。
- **同机可信不再成立**（多人共用一台机器、或跑了不受信的本地服务）。届时 3.5 那段暴露面分析要重做，且写操作与鉴权要一起考虑，不能只补一个。
- **看板用起来发现要看的不是这三块。** 那就改这三块，这正是 v1 存在的意义。
