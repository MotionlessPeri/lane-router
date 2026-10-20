# 「切号后继续」：用户手动切号后，一键让该后端所有活跃 lane 继续 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-21 由 `lane-router/design` 起草；用户在问答 `3e31679c` 定口径；impl 审稿后修订（4.1 投递层与去重、4.3 账号页路线、返回三类）。Vikunja LR-28。实现：`lane-router/impl`（Router 两条路由 + 账号后台转发 + 账号页按钮）、`lane-router/inbox-impl`（问答页顶栏按钮，调看板路由）。上线：重启核心 + 主检出 build + **重启账号后台**（账号页按钮才生效，这一步要用户同意）；不需要 `-CodexHost`。

## 一、问题与结论

用户原话：「主要是claude lane。我没要自动切号，我要我手动切号之后有一个按钮，我点了就会把所有因为额度满了卡住的lane发一条消息让他继续。退一步给所有活跃的lane发也可以。」「可以账号页问答页各一个。我觉得应该是一种agents一起发。比如claude的一起发，codex的一起发这种」

**结论**：不做任何账号自动化。加一个**按后端分**的动作「继续 <后端> 的 lane」：Router 给该后端的全部活跃 lane 各投一封标准信并唤醒；不识别谁卡在额度上。账号页、问答页各一个入口，背后同一个处理函数。

## 二、术语

| 词 | 含义 |
|---|---|
| 活跃 lane | 有 active binding、未归档的 lane。 |
| 后端 | `claude` / `codex`。zcode、dsh 首版不列，接口的枚举可扩。 |
| 标准信 | 固定正文的用户来信：走 `UserMessageDelivery.deliverUserMessage`（`tell` 底下那层），source `{kind:"user", origin:"user:continue-after-switch"}`；**不套 `tell` 的讨论模板**。 |
| 账号后台 | `src/accounts/http-server.ts`，`http://127.0.0.1:47839/` 的独立进程，提供账号页。 |

## 三、取证

- **Claude lane 共用一份凭据**：LR-9 回退后 launcher 不再给 lane 注入单独账号，所有 Claude lane 跑默认配置目录、共用 `~/.claude/.credentials.json`；用户观察（LR-5 记录）一个窗口 `/login` 后，其它运行中的会话在下次刷新 token 时自动用上新号 ⇒ **用户手动切号这一步已覆盖全部 Claude lane**，缺的只是一次唤醒重试。
- **Codex lane**：账号切换走宿主 app-server 的账号 RPC（`docs/account-switching.md`），切完同样只缺重试。
- **额度失败的回合已经结束**，会话空闲；一封新信即触发新回合（现有唤醒机制；若落在启动窗口，LR-25 重通知兜底）。
- **识别不可靠**：Claude 的 lifecycle hook 只报 `Stop` / `UserPromptSubmit`，不报失败原因 ⇒ 首版不识别「谁卡在额度上」，发给该后端全部活跃 lane（用户接受）。
- **`tell` 的正文不能复用**（impl）：`tellBody`（`src/router/tell.ts:113`）结尾写死「等用户在这个终端里开口；在那之前不要改动任何东西」，与「从中断处继续」相反。`deliverUserMessage` 与 `tell` 同一条落盘 + 通知帧路径，只是不套讨论模板；它会告诉调用方目标是 `online` / `offline` / `unbound` / `archived` / `missing`。
- **账号页拿不到看板 `actionToken`**（impl）：账号后台与 Router 是两个进程、不同源；`/dashboard/...` 的防护要求 Router 自己的页面加 token。问答页与 Router 同源，能直接调看板路由。

## 四、设计

### 4.1 接口

两条路由，**共用一个处理函数**：

- `POST /dashboard/lanes/continue-after-switch`，body `{ "backend": "claude" | "codex" }`，需看板 `actionToken`（与 `/dashboard/lane-sets`、`/dashboard/lanes/open` 同一防护）——问答页用。
- `POST /lanes/continue-after-switch`，同 body，`refuseWebPage` 防护（只收不带 Origin 的本机程序，与 `tell` 的入口一样）——账号后台用，Router 地址从 `discovery.json` 读。

行为：对该后端的全部活跃 lane，各投一封标准信（`deliverUserMessage`），返回

```
{ backend, notified: [address…], queued: [address…], skipped: [{ address, reason }…] }
```

`notified` = 目标 `online`、已发通知帧；`queued` = 目标 `offline`、信已落盘、等它下次打开才处理；`skipped` = `unbound` / `archived` / 去重等。

幂等：**同一后端距上一轮不到 60 秒就不发**（滑动窗口，不按钟面分钟分桶——impl 指出分桶防不住跨秒的双击），`skipped` 里标明 `reason: "deduplicated"`；超过 60 秒照发——用户切了两次号就该发两次。无持久状态，时刻在内存。

### 4.2 标准信

正文固定（中文），第一行作摘要：

> 切号后继续：用户已手动切换 <后端> 账号，额度已恢复。
> 若你上一回合因额度 / 容量失败而停下，请从中断处继续原任务；若没有停下，忽略本信并 ack。

source `{ kind: "user", origin: "user:continue-after-switch" }`；不新造消息类型、不加 subject 字段（通知摘要取正文首行）。

### 4.3 入口

- **账号页**（`src/accounts/` 的网页）：每个后端区块旁一个按钮——「继续 Claude lane」「继续 Codex lane」。按钮调账号后台自己的同源接口（复用现有 `x-account-action` 防护），账号后台转调 Router 的本机路由。
- **问答页顶栏**（`src/ui/issues/index.html`，inbox-impl）：同样两个按钮，直接调看板路由。
- 两处点击后按三类显示：已通知 N 条（地址）、已落盘等打开 N 条（地址）、跳过（地址 + 原因）；接口失败显示原因。按钮不做二次确认（动作无害：多发一封信的代价是一次 ack）。

### 4.4 lane 侧

无需改动：收到标准信按正文行事。规范里加一行（`techniques/lane-router.md`）：「收到『切号后继续』信：上一回合若因额度失败，从中断处继续；否则 ack 即可。」

### 4.5 不做

自动切号；按 lane 改凭据；识别「卡在额度上」；新表或持久状态；zcode / dsh 的按钮（接口枚举可扩，入口按需加）；CLI `lane-router-lane continue`（没有需求，推迟）。

## 五、范围审计

| 候选面 | 使用者/频率 | 需求依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 看板路由（问答页用） | 用户每次切号后 | 原话（explicit） | 要逐条 lane 手发 | 手发 | 保留 |
| 本机路由（账号后台用） | 同上 | 原话「各一个」（explicit）+ 账号页不同源、拿不到 token（取证） | 账号页按钮做不出来 | B：账号页只放链接跳问答页（不是「各一个」） | 保留，与看板路由共用处理函数 |
| 账号后台转发接口 + 按钮 | 同上 | 同上 | 同上 | 同上 | 保留 |
| 问答页按钮 | 同上 | 原话「各一个」 | — | — | 保留（inbox-impl） |
| 走 `deliverUserMessage` 而非 `tell` | — | `tell` 模板与需求相反（取证） | lane 读到「别动等用户开口」 | — | 保留 |
| 返回 `queued` 一类 | 用户 | 推断（免得用户以为离线 lane 已唤醒） | 用户误判 | 看板看 presence | 内化（返回字段 + 页面显示，无新状态） |
| 60 秒滑动去重 | 防双击 | 推断（体验） | 双击发两轮 | 用户克制 | 内化，无配置 |
| 识别「卡在额度上」 | — | 用户接受退一步 | 无 | 全发 | 推迟 |
| 自动切号 | — | 用户明确不要 | — | — | 删除 |
| 新表 / 持久状态 | — | 无 | — | 邮件本身即记录 | 删除 |
| CLI `continue` | — | 无（impl 提「几乎不费事」，不是需求） | 无 | 两个按钮 | 推迟 |

不新增进程、协议、持久状态、工具、参数；新增两条 Router 路由（同一处理函数）、账号后台一条转发接口、两处按钮。

## 六、验收标准

自动测试（node 组，dashboard / 投递既有夹具）：

1. `backend=claude` 只给 claude 后端的活跃 lane 发；codex 后端、已归档、无绑定的不发；返回的 `notified` + `queued` 与实际登记的信一致，`skipped` 列出未发的及原因。
2. 信正文逐字等于 4.2（两行），source origin 为 `user:continue-after-switch`；**不含** `tell` 模板的任何句子。
3. 看板路由缺 / 错 `actionToken` → 拒绝，不发任何信；本机路由带 Origin 的请求 → 拒绝（`refuseWebPage`）；两条路由对同一 body 的结果相同。
4. 60 秒内对同一后端第二次调用不重复发（`notified` / `queued` 为空，`skipped` 标 `deduplicated`）；时钟推过 60 秒再调用照发；不同后端互不影响。
5. 在线 lane：pending 目录有文件且收到通知帧，进 `notified`；离线 lane：pending 目录有文件、**无**通知帧，进 `queued`。
6. 账号后台转发接口：缺 `x-account-action` 防护头 → 拒绝；正常请求按 discovery 转调 Router 并原样返回三类结果。
7. 既有 `tell`、投递、dashboard 路由、账号后台路由测试全过；`npm test`、`npm run typecheck` 全过。

浏览器（issues 组）：

8. 问答页顶栏两个按钮存在；点击调看板路由；按三类显示；接口报错时显示原因。

真机：

9. 让一条 Claude lane 真撞额度（或制造一次失败回合后让它空闲），用户手动切号，点问答页「继续 Claude lane」：该 lane 收到信、起回合、用新号继续原任务；一条没卡的 Claude lane 只 ack；一条离线 Claude lane 显示在「已落盘等打开」；Codex lane 没收到。记 `docs/manual-tests.md`。
10. 账号页按钮同 9 走一遍（账号后台重启后）。

## 七、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`；主检出不 build（build 归部署）。
- 变异（改坏一处看对应用例变红，看完改回）：去掉 backend 过滤 → 1 红；改正文一个字或改走 `tell` → 2 红；去掉 token 检查或去掉 `refuseWebPage` → 3 红；去重改回分钟分桶 → 4（跨秒双击）红；只写文件不发通知帧 → 5 红；离线 lane 也进 `notified` → 5 红；转发接口不带防护 → 6 红。

## 八、边界

- 只改 Router 核心的两条路由、账号后台一条转发接口与账号页、问答页顶栏；不改账号切换本身；不改任何 lane 工具或 instructions。
- 上线：重启核心 + 主检出 build + 重启账号后台（用户同意后）；不需要 `-CodexHost`。可与 LR-27 一批（LR-27 要 `-CodexHost`，一批就整体带）。
- 后续若 hook 能报失败原因，再把「全发」收窄为「只发卡住的」，另起小稿。
