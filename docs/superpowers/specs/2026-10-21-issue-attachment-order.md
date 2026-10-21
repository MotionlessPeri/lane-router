# 问答附件：按用户添加的顺序显示 —— 需求与设计（补充稿）

**状态：** 补充稿，2026-10-21 由 `lane-router/inbox` 起草，补[附件稿](2026-10-20-issue-files.md)。由 `lane-router/inbox-impl` 实现，随归档横幅那一批上线。要升问答库版本（v3 → v4），需要重启核心。

## 一、问题

impl 2026-10-21 跑全量时，浏览器组 `attachments-browser` 的「a pasted screenshot, a dropped file and a picked file each upload at once…」偶发失败。期望顺序是 `image.png, 日志.txt, plan.md`，实际是 `日志.txt, image.png, plan.md`。单独跑能过。

查下来，这一条用例里的两处断言各有各的问题：

- **第 94 行 `uploads`：测试写错了。** 它比的是服务器收到上传请求的先后。三个文件是同时上传的，谁先到不固定。
- **第 104 行 `saved.attachments`：是真缺陷。**
  - 历史里一条回复的附件，按 `issue_attachment.created_at` 排（`store.ts:172`）。`created_at` 是上传请求到达的时间，所以顺序跟着「哪个先传完」走。
  - 给 lane 的信按回复带的 `attachmentIds` 排（`service.ts` 的 `claim`），也就是用户在托盘里添加的顺序。
  - 结果是：用户先贴图、再拖文件，历史里可能文件排在图前面，而且和 lane 收到的信对不上。用户说「第二张图」时，两边指的可能不是同一张。

## 二、结论

一条回复或新问答里的附件，在历史里一律按用户添加的顺序显示，也就是发送时 `attachmentIds` 的顺序，和信里的顺序一致。

## 三、设计

1. **记下位置：问答库升到 v4，`issue_attachment` 加可空的整数列 `position`。**
   - 照现有的升级写法：加进 `UPGRADES`，升级前用 `VACUUM INTO` 备份成 `issues.sqlite.v3.bak`。
   - 只加列，不改已有的行。
2. **认领时写位置：** `claimAttachment` 多一个参数 `position`，就是这个附件在 `attachmentIds` 里的下标，从 0 开始。和 `issue_id`、`entry_id` 在同一条 UPDATE 里写入。
3. **读出时按位置排：** `attachmentsOfIssue` 改成 `ORDER BY position IS NULL, position, created_at, id`。
   - 升级前就有的附件 `position` 为 NULL，照旧按 `created_at` 排，显示和现在一样。
   - 历史详情按 entry 分组，不同 entry 之间的先后不受影响。
4. **没认领的附件**（草稿里的、等清理的）`position` 一直是 NULL。清理逻辑不变。
5. **修测试：** 第 94 行改成不比先后，排序后再比，或者用集合比较。第 104 行保持严格比较，修好以后它的顺序就是确定的了。

## 四、验收标准

1. **升级（node 组）：**
   - v3 的库升到 v4，只留 `.v3.bak` 一个备份；
   - 原有附件行的数据不变，`position` 为 NULL；
   - 照现有升级测试的写法，用 v3 的结构夹具。
   - v1 的库一次升到 v4 时，只留 `.v1.bak`，和现在 v1 → v3 的行为一致。
2. **顺序（node 组）：**
   - 按 C、A、B 的先后上传三个附件，回复时按 A、B、C 发送，详情里也是 A、B、C；
   - 信里列出的顺序同样是 A、B、C；
   - 新问答一样。
3. **旧数据：** `position` 为 NULL 的附件，仍按 `created_at` 排。
4. **浏览器组：** `attachments-browser` 那条按第三节第 5 条改好，在本机连跑 5 遍都过。
5. 全量 `npm test`、`npm run typecheck` 通过。

## 五、变异检验

- 读出时不按 `position` 排、仍按 `created_at` → 2 红
- 认领时不写 `position` → 2 红
- 升级时改了旧行的数据 → 1 红

## 六、边界

- 只改问答库的附件表、认领与读出、升级，以及那条测试。不改上传接口和页面托盘。
- 上线要重启核心。问答库升到 v4 以后，旧构建打不开，部署前先备份问答库。和归档横幅同一批，只重启一次。
