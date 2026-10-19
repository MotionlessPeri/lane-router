# 产品工具 schema 根节点改为平表 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-19 由 `lane-router/inbox` 起草。用户在问答议题 `1c9e7df1` 里回复「可以，修一下吧」；平台口径由 `lane-router/design` 认可（消息 `9b376994`「是修不是扩」；`9ba444e9` 看过稿子：「平台口径 OK，可以派给 impl，不用再走用户审」）。实施归 `lane-router/impl`，第五节是验收标准。Vikunja #342。

## 术语表

| 词 | 含义 |
|---|---|
| 工具目录 | `ToolCatalog`（`src/application/tool-catalog.ts`）。`jsonTools()` 生成每个工具发布出去的 inputSchema |
| union 工具 | 参数 schema 是 Zod `union` 或 `discriminatedUnion` 的工具。现在有 5 个：`lane_issue_publish`、`lane_issue_read`、`lane_issue_update`、`lane_graph_read`、`lane_graph_lock` |
| 分支 | union 里的一种合法填法，即一个 `.strict()` 的 object |
| 平表根 | 根节点是 `{ type: "object", properties, required, additionalProperties: false }`，没有 `anyOf`/`oneOf`/`allOf` |

## 一、问题与结论

`jsonTools()` 发布的是 `{ ...z.toJSONSchema(schema), type: "object" }`（`tool-catalog.ts:41`）。对 union 工具来说，根节点是 `anyOf`/`oneOf`，没有 `properties`。两个消费端走的是同一条路：Claude（MCP）经 `src/mcp/tool-schemas.ts:10`，Codex 经 `src/adapters/codex/dynamic-tools.ts:8`（`draft-7`）。

2026-10-19，在 `lane-router/inbox` 会话里实测 Claude Code 加载到的 schema：

- `lane_issue_update`：`action` 只有 `const "resolve_question"`，`status` 只有 `const "answered"`。
- `lane_issue_publish`：`kind` 只有 `const "answer"`。
- `lane_graph_lock`：`action` 只有 `const "acquire"`。
- 这几个工具都是 `required: []`、`additionalProperties: true`，说明前面还多了一句「Input constraint: Provide parameters for …」。这句话不在我们的源码里，是客户端加的。
- 对照：`lane_graph_apply` 在 `changes.items` 里嵌套的 `oneOf`，Claude Code 原样保留。被改写走样的只有**根节点**的 union。

调用本身能成功，因为服务端按 Zod 完整校验，客户端没有拦。但模型看到的说明是错的：合法的取值被说成不存在，严格性也丢了。

结论：在 `jsonTools()` 里统一把 union 工具的根节点压成平表根，把分支之间的组合规则写进说明；解析仍用原来的 Zod union。改这一处，Claude 和 Codex 两边一起修好。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| 在 `jsonTools()`（或它调用的一个共享 helper）里集中压平，不逐个工具改 | 是 | 两个消费端都走它；以后新增的 union 工具自动覆盖（design 口径） |
| 只压平根节点，嵌套的 union 保持原样 | 是 | 实测 Claude Code 保留嵌套的 `oneOf`；压平嵌套会丢失 `changes` 这类数组元素的分支信息 |
| `properties` 取各分支字段的并集；同名字段的 `const`/`enum` 合并成一个 `enum` | 是 | 让所有合法取值都出现在说明里 |
| `required` 取各分支 required 的交集 | 是 | 只有每种填法都必须带的字段才标为必填 |
| 根节点设 `additionalProperties: false` | 是 | 各分支本来都是 `.strict()`；至少能挡住拼错的字段名（design 建议） |
| 分支间的组合规则由程序从分支自动生成，附加在说明后面 | 是 | 平表丢掉了「这个取值下还要哪些字段」的结构化信息，说明文字成了模型唯一的依据（design 指出）。自动生成的规则不会和 Zod 不一致 |
| 解析仍用 Zod union，服务端是唯一的事实来源 | 是 | 平表只是给模型看的说明，不放松校验 |
| 非 union 工具的输出逐字节不变 | 是 | 现有的 5 个通信工具契约测试照旧成立 |

## 三、设计

### 3.1 压平规则

输入是 `z.toJSONSchema(schema, target)` 的结果。根节点有 `anyOf` 或 `oneOf`、并且每个元素都是 object 时，才压平；否则原样输出（只补 `type: "object"`，与现状相同）。

- `properties`：按分支顺序合并字段，字段顺序取它第一次出现的位置。同名字段：
  - 各分支给出的 schema 完全相同 → 保留一份。
  - 都是同一基础类型的 `const` 或 `enum` → 合并成 `{ type, enum: [按出现顺序去重] }`。
  - 其他情况 → 该字段写成 `anyOf: [各分支的 schema]`。这是字段级的 `anyOf`，不在根节点；当前目录里没有这种情况，规则只作兜底。
- `required`：各分支 `required` 的交集，按第一次出现的顺序排列。
- `additionalProperties: false`，`type: "object"`。保留 `$schema`。

### 3.2 组合规则说明

给 union 工具的 `description` 后面附一段，由分支自动生成，例如：

```
Argument combinations (use exactly one):
1. kind="answer": operationKey, title, originalQuestion, body
2. kind="question": operationKey, title, body
```

- 每个分支一行：先写该分支**所有** `const` 字段，再列它的 required 字段，然后在 `optional:` 后面列可选字段。`lane_issue_update` 有两个分支的 `action` 都是 `"resolve_question"`，要靠 `status` 的 `const` 区分，所以两行都必须写出 `status=`，否则看起来完全一样（design 提醒）。
- 非判别的 union 也按这种格式列出，例如 `lane_issue_read` 写成「1. issueId; optional: afterSeq, limit」「2. optional: filter, before, limit」。
- 措辞用英文，和现有工具说明一致。非 union 工具的说明不变。

### 3.3 代码落点

| 位置 | 改动 |
|---|---|
| `src/application/tool-catalog.ts` | `jsonTools()` 调用压平函数，附加组合规则说明 |
| 新的共享 helper（文件名由 impl 定，放在 `src/application/` 下） | 3.1 和 3.2 的纯函数 |
| `tests/tools/` | 见第五节 |

不改：各模块的 Zod schema 和解析、工具名、工具说明的正文、MCP 与 Codex 两个适配器、`codex-capability.ts` 的外壳校验。

### 3.4 生效方式

- Claude 侧：lane MCP 进程用自己构建产物里的目录生成 schema，新开的 Claude 会话加载新构建后就能拿到。以实施时核实为准。
- Codex 侧：`dynamicTools` 在 `thread/start` 时发出，Router（或 Codex 宿主）用上新构建后才生效。
- 不管哪一侧，都要先在主检出构建；构建时机和共享 Router 何时重启，由用户决定。
- design 建议：做完后标为「待部署」，和 codex-host 的部署合进同一次 Router 重启，不要为它单独重启一次（Vikunja LR-10）。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| 集中压平根节点 | 全部 lane，每次加载工具 | 实测走样；用户决定修 | 模型继续看到错误的取值 | 无 | 保留 |
| 自动生成组合规则说明 | 模型，每次调用 union 工具 | 平表会丢掉分支约束 | 模型不知道哪种取值要带哪些字段 | 手写说明（会和 Zod 不一致） | 保留 |
| 根节点 `additionalProperties: false` | 模型 | 各分支本来就是 strict | 拼错的字段名只能靠服务端报错 | 服务端 Zod | 保留 |
| 契约测试覆盖全部产品工具和两个 target | 测试 | 现在只覆盖 5 个通信工具 | 下一个 union 工具再次走样也没人发现 | 无 | 保留（只加测试） |
| 把 union 工具拆成多个单一形状的工具 | 无 | 无 | — | 平表根 | 删除：会改工具名，影响所有 lane |
| 压平嵌套的 union | 无 | 实测嵌套能正确显示 | — | — | 删除 |

## 五、验收标准

第 1–6 条要有自动测试；第 7、8 条要在真实环境里核实。

1. 对 `productToolCatalog` 的 `jsonTools()` 输出，默认 target 和 `draft-7` 各跑一遍：每个工具的 inputSchema 根节点都是 `type: "object"`、带 `properties`、`additionalProperties: false`，并且根节点没有 `anyOf`/`oneOf`/`allOf`。
2. 取值完整：
   - `lane_issue_update`：`action` 的 enum 是 `[resolve_question, record_processed, record_tui_close]`，`status` 的 enum 是 `[answered, not_needed]`。
   - `lane_issue_publish`：`kind` 的 enum 是 `[answer, question]`。
   - `lane_graph_lock`：`action` 的 enum 是 `[acquire, release]`。
3. `required`：
   - `lane_issue_update` 是 `[operationKey, issueId, action]`；`lane_issue_publish` 是 `[operationKey, title, kind, body]`；`lane_graph_lock` 是 `[operationKey, graphId, action]`。
   - `lane_issue_read` 和 `lane_graph_read` 为空。
   - `properties` 的字段集合等于各分支字段的并集。
4. 5 个 union 工具的说明都以原说明开头，后面附组合规则；每个分支各占一行，该分支的所有 `const` 字段和 required 字段都出现在那一行里；`lane_issue_update` 的两行 `resolve_question` 分别带 `status="answered"` 和 `status="not_needed"`。非 union 工具的说明和 inputSchema，与改动前逐字节相同。现有 `tool-entry-contract.test.ts` 不改。
5. `lane_graph_apply` 的 `changes.items` 仍是原来的嵌套 `oneOf`，6 个分支都在。
6. 解析不变：跨分支混填，例如 `lane_issue_publish` 传 `{ kind: "question", originalQuestion: "x", … }`、`lane_issue_update` 传 `{ action: "record_processed", status: "answered", … }`，仍被拒绝；各分支的合法输入仍然通过。MCP SDK 能接受新目录（`issue-entry-contract.test.ts` 继续通过）。
7. 真机，Claude：主检出构建后，新开一个 Claude Code 会话，查看 `lane_issue_update`、`lane_issue_publish`、`lane_graph_lock` 加载到的 schema，取值和 required 应符合第 2、3 条。记下「Input constraint」那句还在不在：这是观察项，不是验收项。记入 `docs/manual-tests.md`。
8. 真机，Codex：经 Codex 宿主的隔离环境发一次真实 turn，记录实际发出的 `dynamicTools` 条目，以及 codex 0.154.0 呈现给模型的样子。目前 Codex 的全局授权已经失效（Vikunja #315），这一条可能被卡住；卡住就在交付里如实写「尚未执行」和原因，不用别的证据代替。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`。主检出不 build，测试一律用临时目录。
- 变异检验（每次改坏一处，看对应的测试有没有变红，看完改回）：
  - 不压平 → 1 变红
  - 同名 `const` 只保留第一个 → 2 变红
  - `required` 取并集 → 3 变红
  - 不附加组合规则说明 → 4 变红
  - 对非 union 工具也附加说明 → 4 变红
  - 压平嵌套的 union → 5 变红
  - 解析改用压平后的 schema → 6 变红

## 七、边界

- 只修发布出去的 schema，不改任何工具的语义、名称和解析。
- 客户端把 schema 改写成什么样，最终要靠第 7、8 条的真机结果确认；单元测试只能证明我们发出去的东西是对的。
- 「Input constraint」那句话会不会消失，不作承诺。
