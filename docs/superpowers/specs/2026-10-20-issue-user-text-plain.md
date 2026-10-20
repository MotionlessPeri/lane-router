# 问答页：用户写的内容按纯文本显示 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/inbox` 起草。讨论在问答议题 `9fc25ec7`「你写的内容保持纯文本，不按 Markdown 显示」。

用户在 `lane-router/design` 的 TUI 里说：「我发现一个小问题，就是我发的回复也会被渲染成md。我希望我发的回复保持纯文本」。design 把这件事转给了 inbox。inbox 在条目 #1 提了两点：「你写的」包括哪三样，本机路径照样能点开。用户回复：「没问题」。

由 `lane-router/inbox-impl` 实现，排在[lane 结束问答稿](2026-10-20-issue-lane-close-and-default-publish.md)之后、[附件稿](2026-10-20-issue-files.md)的 3.2、3.3 之前。只改页面，和这一版一起上线：构建主检出就会换掉页面，不用为它重启。push 等用户说。Vikunja #403。

## 一、问题与结论

现状：

- `entryBody`（`src/ui/issues/index.html:224-231`）对所有非事件条目都用 markdown-it 渲染，用户写的也一样。
- 用户在回复里打的 `*`、`#`、`-`、`1.`、`>`、反引号和 `|` 都会变成格式。空行、行首空格这类排版也会按 Markdown 的规矩改掉。页面上显示的就不是用户打的样子。

结论：

1. `author === "user"` 的条目，正文按纯文本显示：
   - 不经过 markdown-it，用 `textContent` 赋值。
   - 沿用已有的 `.plain-text` 样式（`white-space: pre-wrap`），换行、连续空格、行首空格都照原样。
2. 按 `author` 区分，覆盖三种来源：
   - 页面回复（`user_page`）；
   - 新问答的正文（`user_page`）；
   - lane 记录的 TUI 原话（`agent_reported_tui_user`），包括 publish 时的 `originalQuestion` 和 `tui_user` 追加。
   - `record_tui_close` 记下的原话是事件条目（`service.ts:381`），页面上本来就显示成一行灰字，不经过 Markdown，不在本稿范围内。
3. 纯文本里的本机绝对路径照样变成可点的链接：对纯文本正文同样调用 `linkLocalPaths`。
4. lane 写的条目（`author === "lane"`）和事件条目都不变。
5. 存储、接口和投递给 lane 的正文都不变，只改页面上的显示。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| 按 `author` 区分，不按 `source` | 是 | 用户确认三样都算。`author === "user"` 正好覆盖这三种来源，以后再加用户来源也不会漏 |
| 纯文本里继续识别本机路径 | 是 | 用户确认 |
| 纯文本里识别网址，变成链接 | 否 | 现在的 Markdown 也关了 `linkify`，用户没提 |
| 加「按 Markdown 显示」的开关 | 否 | 用户没提 |
| 发送框加预览 | 否 | 纯文本发出去什么样就显示什么样 |

## 三、设计

- `entryBody(text)` 加一个参数，表示按纯文本显示。`entryArticle` 传 `entry.author === "user"`。
- 纯文本分支：加 `plain-text` 类，用 `textContent` 写入正文，再调用 `linkLocalPaths(body)`。纯文本里没有 `pre`，所以也没有复制按钮。
- `linkLocalPaths` 不改：
  - 正文里没有 `code` 元素，处理行内代码的那一步自然不触发；
  - 处理文字的那一步按现有的 `TEXT_PATH` 找路径。
- 已知限制：`TEXT_PATH` 只认不含空格的路径。用户在纯文本里写含空格的路径，不会变成链接。Markdown 时可以用反引号把这种路径包起来，纯文本没有这个办法。本稿接受这一点，不另加规则。
- Markdown 组件加载失败时的回退照旧：所有条目都按纯文本显示，并显示提示条。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 处置 |
|---|---|---|---|---|
| 用户条目按纯文本显示 | 用户，每条回复 | 用户要求 | 显示和用户打的不一样 | 保留 |
| 纯文本里点开本机路径 | 用户 | 用户确认 | 用户写的路径点不开 | 保留 |
| 识别网址、显示开关、预览 | — | 用户没提 | — | 不做 |

## 五、验收标准

第 1–5 条是 happy-dom 用例（`tests/modules/issues/ui.test.ts`），第 6 条是浏览器组用例。

1. **页面回复原样显示。** 用户回复的内容包含：
   - `**粗**`、`# 标题`、`- 项`、`1. 项`、`` `code` ``、`> 引用`、`| a | b |`；
   - `<b>不加粗</b>`；
   - 连续空格、行首空格和空行。

   这条回复的 `.entry-body` 要满足：
   - 带 `plain-text` 类；
   - `textContent` 和原文逐字相同；
   - 里面没有任何元素。
2. **lane 条目不受影响。** 同样内容写在 lane 条目里，仍然渲染成标题、粗体、列表等。现有的 Markdown 用例（`question and answer history render Markdown…`）照常通过。
3. **TUI 原话也是纯文本。** 以下两种条目都按纯文本显示：
   - 带 `originalQuestion` 发布的答复，首条是 `agent_reported_tui_user`；
   - `tui_user` 追加。
4. **新问答的正文是纯文本。**
5. **用户条目里的路径能点。** 用户回复里写 `E:\a\b.md` 和 `E:/a/c/`：
   - 两处都变成 `.local-path` 按钮；
   - 按钮外的文字和原文一致，句末标点不算进路径。
6. **点击能打开。** 浏览器组的 `path-links-browser.test.ts` 加一条：点用户回复里的路径按钮，发出 `open-local-path` 请求，路径正确。
7. **改写现有用例。** `Markdown replies are sent and stored verbatim before the saved history is rendered` 改成断言回复按原文显示，没有 `strong` 和 `pre`。「发送和存储都逐字不变」的那两条断言保留。
8. `npm run typecheck`、`npm test` 全部通过。

## 六、验证方法与变异检验

- 跑法：`npm run typecheck`、`npm test`。主检出不 build。
- 变异检验：每次改坏一处，看对应的测试有没有变红，看完改回。
  - 按 `source === "user_page"` 判断，不按 `author` → 3 变红
  - 纯文本分支不调用 `linkLocalPaths` → 5 变红
  - 纯文本分支用 `innerHTML` 写入 → 1 变红
  - 所有条目都按纯文本显示 → 2 变红

## 七、边界

- 只改 `src/ui/issues/index.html` 和测试。
- 不改存储、接口、投递正文，也不改 lane 条目和事件条目的显示。
