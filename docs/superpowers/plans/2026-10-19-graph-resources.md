# 图资源接入实施计划

> 本对话内按 `autonomous-workflow` 执行，用户已要求直接开始；计划与结果由独立审查辅助，不增加用户审批轮。实现人员先读需求与设计，按下面单位先红后绿。本地验证结果可提交，生产部署交 coordinator/外部维护。

**目标：** lane 能创建、查找、读取、持长锁修改及删除图内容，用户通过同一 Router 提供的 React Flow 只读网页查看结果。

**结构：** `src/modules/graphs` 拥有图文档、SQLite、锁和服务；复用 `LaneAccess` 和 `ToolCatalog`。HTTP 与 CLI 分别调用同一服务，网页只保存临时查看状态。

**依赖与基线：** 原型 `9966e7b`，主仓起点 `254cd0e`，按 coordinator 接缝信息在实施中对齐 `53f026e`，独立树 `graph-resources-20261019`。Node/TypeScript/Zod/better-sqlite3 沿用主仓；UI 沿用原型已验 React、React Flow、D3-Force、Vite 版本。无需新服务进程或插件框架。

## 1. 图模型和删除行为

文件：`src/modules/graphs/document.ts`、`types.ts`；`tests/graph-document.test.ts`。

- [x] 写行为测试：普通无分组图；三层以上分组；跨组关系；批内增组增点连线；禁止分组环/悬挂引用/重复ID；删除边；节点及边同批删除；漏删边整批失败且输入不变。
- [x] `npx vitest run tests/graph-document.test.ts`，观察未实现状态实际失败。
- [x] 实现严格输入 schema、不可变批量命令与最终整图验证。不隐式级联删除，不加入资源/分组删除。
- [x] 定向测试通过并运行 `npm run typecheck`。

## 2. 图库、逻辑长锁与持久重试

文件：`src/modules/graphs/{store,schema,service,index}.ts`；`tests/graph-service.test.ts`；必要 fixture 放 `tests/helpers/graph-fixture.ts`。

- [x] 用真实临时 SQLite 写失败测试：创建即持锁；另一 lane 可读但不可写；批次保存/回滚；同 lane 新有效绑定接续；旧 binding、旧锁、他人锁写入被拒；强解预期锁不匹配拒绝；释放后旧锁无效。
- [x] 运行定向红测后实现图/锁/操作记录三个业务表及独立迁移，复用 `LaneAccess`，不读 core 内部表。
- [x] 写并实际验证：关库重开保留图与锁；同键重放不重做；重放创建/获锁返回当前文档及当前锁有效性，键冲突、获锁失败不占键；存储失败不保存部分内容。
- [x] 定向测试与 typecheck 通过，提交本单位可用结果。

## 3. 工具、CLI、HTTP 与宿主装配

文件：`src/modules/graphs/{tool-schema,tools,http,cli}.ts`；修改 `src/application/builtin-tools.ts`、`src/process/{main,local-server,lane-launcher}.ts`；测试 `tests/graph-adapters.test.ts`、相关现有装配回归。

- [x] 先测试四项图工具和旧会话 JSON 文件 CLI：实际 schema、身份来源、额外身份参数拒绝、释放与 apply 的锁检查、可发现同一资源。
- [x] 先测试真实 HTTP fixture：只读资源 GET、未知路由不吞 body、无模块/模块失败响应、本机强解拒绝 Origin/错误类型/旧预期锁；不对外开放网页图写入口。
- [x] 增加纯图工具集合并显式绑定；保留五项通信及议题原行为，保留通信-only装配。正常独立产品启用图；不改外部 Host 白名单。
- [x] `lane-router-lane graph` 包含普通四操作和独立本机 `force-unlock`，使用 discovery 不固定端口；agent普通工具无强解动作。
- [x] 跑相关原有 adapter/startup/CLI 回归；用户授权未包含在用 Router 停启，不用生产实例证明新工具存在。

## 4. 可选多层分组投影与只读查看页

文件：`src/ui/graphs/`、`vite.graphs.config.ts`、`tsconfig.graphs.json`；修改 `package.json`/lock、后端 tsconfig 的 UI边界和构建资产处理；测试 `tests/graph-view.test.ts`、`tests/graph-browser.mjs`。

- [ ] 先写可见投影测试：任意层级、局部图、跨组聚合不丢边、隐藏搜索目标、返回全景避让、无分组图直接显示。
- [ ] 迁入原型只读 React Flow、详情与 D3建议加矩形避让，改成正式图模型；保留缩放、搜索、分组浏览、面包屑、节点临时拖动、取消选择。无表单、连线端口、持久浏览器草稿或讨论区。
- [ ] 独立前端 TypeScript/Vite 构建到 `dist/ui/graphs`；服务器按构建产物白名单提供静态资源，不读任意路径。默认构建同时验证前后端产物。
- [ ] Playwright 使用生产产物和隔离真实HTTP fixture：普通图/经典知识图，增改删后刷新，子图与详情、搜索/取消选择、无编辑入口、页面异常清晰；查看截图检查文本、遮挡与避让。

## 5. 总体验证、审查和交付

- [ ] 更新 `docs/manual-tests.md` 的图工具、锁、强解、只读界面使用及真实客户端待验步骤，索引需求/设计/计划。
- [ ] `npm test`、`npm run typecheck`、`npm run build` 和图浏览器流程；保存实际输出到仓外 evidence，区分 fixture、真实 CLI 和真实模型证据。
- [ ] 独立只读代码审查及收尾走查，修复属于本功能的重要问题；不为建议自动扩新行为。
- [ ] 本地提交归属明确文件，保留主树原文档/其他 lane 改动；提交准确分支和验收证据给 coordinator 进行共享整合。不得自行覆盖生产 dist 或停启 Router。

## 交付限制

本轮实现与隔离验证不冒充生产部署。若真实普通 lane 的新工具需部署后才能验收，交 coordinator 明确列出该用例及入口，不把 UI fixture或原型测试说成真实模型已通过。其余不依赖部署的实现和验证全部完成。
