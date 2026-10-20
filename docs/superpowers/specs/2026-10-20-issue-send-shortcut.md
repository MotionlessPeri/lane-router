# 问答页：用键盘发送，可选 Ctrl+Enter 或 Enter —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-20 由 `lane-router/inbox` 起草，由 `lane-router/inbox-impl` 实现。只改页面：构建主检出就会换掉页面，不用重启。

用户在问答页给 `lane-router/design` 开了一条新问答（`188c0fef`「实现ctrl + enter发送的功能」），原话：「能不能实现一个Ctrl + enter发送的功能啊？现在只能手点很费劲啊？最好能搞个设置切换ctrl + enter 和纯 enter」。design 把这件事转给了 inbox。

## 一、现状

- 回复框（`#reply-body`）和新问答正文（`#new-body`）都是 `textarea`。页面没有任何按键处理（`index.html` 里没有 `keydown`），只能点「发送回复」或「发送」。
- 新问答的标题框（`#new-title`）是表单里的单行输入框，按 Enter 会触发浏览器默认的表单提交。

## 二、结论

1. 两种发送方式，默认 **Ctrl+Enter**：
   - **Ctrl+Enter 发送（默认）：** Ctrl+Enter 发送，Enter 照常换行。
   - **Enter 发送：** Enter 发送，Shift+Enter 换行，Ctrl+Enter 也发送。
2. 默认选 Ctrl+Enter，因为回复常常是多行，纯 Enter 容易误发；用户自己可以切换。
3. **用输入法打字时按 Enter 永远不发送。** 中文输入法用 Enter 上屏候选词，这时 `keydown` 的 `isComposing` 为真（或 `keyCode` 为 229），一律不处理。
4. 用快捷键发送，和点发送按钮走同一条路。按钮不能点的时候（还有附件在上传、有附件上传失败、正在发送），快捷键也不发送。
5. 设置是每个浏览器自己的偏好，回复框和新问答框共用一个，存在 `localStorage`，不进 Router 数据库。

## 三、设计

- **按键处理：** 在 `#reply-body` 和 `#new-body` 上监听 `keydown`：
  - 输入法组字中（`isComposing` 或 `keyCode === 229`）：直接返回。
  - 判断这次按键算不算「发送」：
    - Ctrl+Enter 模式：`Enter` 且按着 `ctrlKey` 或 `metaKey`；
    - Enter 模式：`Enter` 且没按 `shiftKey`。
  - 算发送时，先 `preventDefault()`，再看对应的发送按钮：按钮可用就 `form.requestSubmit(按钮)`，不可用就什么都不做，按键也不会插入换行。
- **标题框：** `#new-title` 里按 Enter 不再提交表单，改成把光标移到正文；按 Ctrl+Enter 照样发送。这样在标题框里顺手按的 Enter 不会把只有标题的问答发出去。
- **切换控件：** 在两个输入区的 `.compose-bottom` 里，各放一个小下拉框，选项是「Ctrl+Enter 发送」和「Enter 发送」，放在发送按钮左边。
  - 改其中一个，另一个跟着变。
  - 发送按钮的 `title` 写当前快捷键，比如「Ctrl+Enter 发送」。
- **存储：** 键名用 `lane-router.issues.send-key`，取值 `ctrl-enter` 或 `enter`。读写都包在 try/catch 里；读不到或读到别的值，就按 `ctrl-enter` 处理，页面照常能用。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 处置 |
|---|---|---|---|
| Ctrl+Enter 发送 | 用户，每条回复 | 用户原话 | 保留 |
| 切换成 Enter 发送 | 用户 | 用户原话「最好能搞个设置切换」 | 保留 |
| 输入法上屏不发送 | 用户，每次打中文 | 不处理的话，打中文时一按 Enter 就会误发 | 保留 |
| 标题框里 Enter 不提交 | 用户，新开问答 | 现在按 Enter 会直接提交，和发送方式不一致 | 保留 |
| 设置存进 Router、跨浏览器同步 | — | 用户没提 | 不做 |
| 其他快捷键 | — | 用户没提 | 不做 |

## 五、验收标准

第 1–6 条是 happy-dom 用例（`tests/modules/issues/`），第 7 条是浏览器组（真 Edge），第 8 条是总跑。

1. **默认 Ctrl+Enter。** 回复框和新问答正文里：Ctrl+Enter 各发出一次请求（回复走 `/replies`，新问答走 `threads`），请求体和点按钮发出的一样；只按 Enter 不发请求。
2. **Enter 模式。** 切换后：Enter 发送；Shift+Enter 不发送；Ctrl+Enter 发送。两个输入框都要试。
3. **输入法。** 带 `isComposing: true` 的 Enter 和 Ctrl+Enter，在两种模式下都不发送；`keyCode` 为 229 时也一样。
4. **按钮不可用时不发送。** 有附件还在上传时、正在发送时，用快捷键都不发出请求。
5. **设置。**
   - 回复框里切换以后，新问答框的下拉跟着变；重新加载页面后，设置还在。
   - `localStorage` 读写抛错时，按 Ctrl+Enter 模式工作，页面不报错。
   - 存了未知的值时，也按 Ctrl+Enter 模式。
6. **标题框。** 在 `#new-title` 里按 Enter，不发请求，光标移到 `#new-body`；按 Ctrl+Enter 则发送。
7. **浏览器组。** 在真 Edge 里用键盘输入两行文字（Enter 换行），再按 Ctrl+Enter 发出：历史里出现这条回复，内容是两行。切到 Enter 模式后，按 Enter 能发出。
8. 已有的浏览器和 happy-dom 用例全部通过；`npm run typecheck`、`npm test` 全部通过。

## 六、变异检验

- 不判断 `isComposing` → 3 变红
- 发送按钮不可用时也调 `requestSubmit` → 4 变红
- 默认值写成 Enter 模式 → 1 变红
- 两个下拉各存各的，不同步 → 5 变红
- 标题框按 Enter 仍然提交 → 6 变红

## 七、边界

- 只改 `src/ui/issues/index.html` 和测试，不改后端、接口和存储结构。
- 上线只要构建主检出，不用重启 Router。
