# 问答页唤醒 Claude lane：说清要点一下确认 —— 需求与设计（补充稿）

**状态：** 补充稿，2026-10-20 由 `lane-router/inbox` 起草，补[新问答稿](2026-10-20-issue-start-from-page.md)的页面文案。由 `lane-router/inbox-impl` 实现。插件迁移后作废（[LR-24 迁移稿](2026-10-21-channel-plugin-migration.md) 4.6）：Claude lane 不再弹确认框，页面上 Claude 和 Codex 的说法相同；唤醒结果里的 `backend` 字段保留。

## 一、问题

上线后的真机验收（问答 `205a897d` 第 20 条）里，用户说：「我点了。每次新开claude lane我都要点一下」。

impl 查了本机 Claude Code 2.1.304 的程序：

- 弹出的是 `DevChannelsDialog`，标题「WARNING: Loading development channels」，按钮是「I am using this for local development」和「Exit」。
- 只要通道能用，每次启动都会弹，不会记住，也没有设置能免掉。
- 我们的启动参数带 `--dangerously-load-development-channels server:lane`（`src/process/terminal-child.ts:58-59`），所以 Router 每次新开或恢复 Claude lane 都会弹。

能免掉弹窗的路线是把 lane 通道做成插件，再列进组织白名单。这要 design 先实测，再由用户拍板，不在本稿范围内。

另一处：窗口连上那一刻送到的提醒，Claude 不会起回合（`205a897d` 第 19 条复测）。点完确认以后，lane 可能停着不动；再来一封信就能叫醒它。design 会另出重通知补丁。

现在问答页说的是「没开着，发出后会打开它的窗口」和「已经让 Router 打开它的窗口」，用户会以为发出去就会自动处理。

## 二、结论

在这两样免掉之前，页面要把话说清楚。只对 Claude lane 这样说；Codex lane 没有这个弹窗，文案不变。

## 三、设计

1. **唤醒结果带上后端。** `IssueWakeResult` 里 `launch_requested` 和 `skipped_launching` 两种结果多一个 `backend` 字段，取值同 binding 的 backend。`issueWakePort` 本来就从 binding 取 lane，直接带上即可。`skipped_online` 和 `failed` 不变。
2. **新问答的 lane 列表**：没开着的 Claude lane 写「没开着，发出后会打开它的窗口；窗口打开后要你在窗口里点一下确认」。没开着的 Codex lane 照旧。
3. **发送后的提示**（新问答和回复共用 `wakeNotice`）：
   - `launch_requested` 且是 Claude：「已发送。这个 lane 没开着，已经让 Router 打开它的窗口。窗口打开后，请在窗口里点『I am using this for local development』；点完它要是没动，在这条问答里再回一句就能叫醒它。」
   - `skipped_launching` 且是 Claude：「已发送。这个 lane 正在打开；窗口要是停在确认提示上，请点『I am using this for local development』。」
   - 其他后端和其他结果照旧。
4. 「点完它要是没动，再回一句」这半句，等重通知补丁上线后删掉。代码里在这半句旁边写一行注释，指向本稿。LR-25 真机通过后已删（2026-10-21）。

## 四、验收标准

1. node 组：`issueWakePort` 打开 Claude lane 和 Codex lane 时，结果分别带 `backend: "claude"` 和 `"codex"`；`skipped_online`、`failed` 不带。
2. happy-dom：
   - lane 列表里，没开着的 Claude lane 显示新文案，没开着的 Codex lane 显示原文案；
   - `wakeNotice` 对 Claude 的 `launch_requested` 和 `skipped_launching` 给出上面的新文案，对 Codex 和其他结果给出原文案。
3. `npm run typecheck`、`npm test` 通过。

## 五、变异检验

- 不区分后端，Codex 也显示确认提示 → 2 变红
- `issueWakePort` 不带 `backend` → 1 变红

## 六、边界

只改唤醒结果的字段、页面文案和测试。不改启动参数，不碰插件路线。
