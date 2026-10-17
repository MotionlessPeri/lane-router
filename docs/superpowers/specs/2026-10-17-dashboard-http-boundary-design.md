# 后台 HTTP 边界整理设计

状态：用户已在对话中认可结构与范围，本文是供复核的书面稿；尚未开始实现。本文不包含部署或重启授权。

## 结论与目的

保留现有工具核心和宿主适配，只把后台网页的 HTTP 处理从 `LocalRouterServer` 中分出，并补齐工具入口支持范围的说明与契约测试。

用户正在讨论按议题组织、支持异步多轮、由用户明确结束的收件箱。用户同意先整理相关结构，但该收件箱、发布工具和旧会话获取新工具的兼容方案均不在本轮实现范围。整理的完成线是现有行为不变，不是预先建设新功能。

源码调查基线为 `087d2a79b8d3d6d841d3cd34acccc403dc05138f`。

## 当前结构

| 部分 | 现有职责 | 本轮处理 |
|---|---|---|
| `tools/tool-contract.ts`、`tool-schema.ts`、`tool-service.ts` | 共用工具名称、说明、参数与业务调用 | 保留，不新增工具或注册框架 |
| `adapters/codex/`、`mcp/` | 按宿主提供动态工具或 MCP 工具，注入调用身份 | 保留 |
| `router/` | lane、绑定、消息、存储与通知业务 | 保留 |
| `process/local-server.ts` | HTTP/WS 服务、channel 生命周期、RPC、CLI 管理接口、后台网页、Host 协议 | 仅拆出后台 HTTP 处理和共用 JSON 读写 |
| `process/native-host-service.ts` | Company Host 身份、绑定及调用规则 | 保留 |
| CLI 和 `local-client.ts` | 命令解析、调用 Router 与传输恢复 | 保留 |

Codex 动态工具和 MCP 共用 `ToolService`。DSH 的工具调用以及 Company 的发送、确认也复用它；Host 读取接口直接调用 `RouterCore.read`。CLI 和网页通过各自入口调用业务服务，并非所有操作都经过工具服务。

问题集中在 HTTP 接入：同一文件承载网页操作和多种机器调用协议，读者需要同时辨认不同的身份、来源及错误处理规则。不同宿主的工具范围本身有明确契约，不应为统一形式而抹平。

## 目标结构

| 模块 | 整理后的职责 |
|---|---|
| `process/local-server.ts` | 继续持有服务启动/关闭、discovery、RPC、CLI 管理接口、Host 接入、WS 升级和原有 channel 行为；把后台请求委托给后台处理模块 |
| `process/dashboard-http.ts` | 处理现有后台页面、状态查询、打开 lane、管理 lane set；校验网页输入并调用注入的业务回调 |
| `process/http-json.ts` | 提供现有 JSON 请求读取和响应写出，不包含身份、权限或重试策略 |
| 现有工具、业务和宿主模块 | 保持职责和外部行为 |

本轮不拆 `ClaudeChannelHub`，不引入路由框架、中间件系统、插件注册中心或可配置权限系统。

### 后台 HTTP 模块

仅移入以下现有路由：

- `GET /dashboard`
- `GET /dashboard/state`
- `POST /dashboard/lanes/open`
- `POST /dashboard/lane-sets`

一并移入页面读取、网页操作校验、对应请求形状校验和 `DashboardLaneSetsInput`。该类型从旧模块保留转导出，避免无必要地改变已有导入路径。

模块提供处理请求的方法，返回是否接管该请求；未匹配的请求不得读取请求体或调用业务回调。方法与路径的匹配规则保持现状，包括查询字符串的处理，不借搬迁扩大接受范围。已匹配但未接线的功能保持原有 404 行为。

`LocalRouterServer` 为每个服务实例创建对应处理器。处理器只接收当前 Router 信息、当前 origin、该实例的 action token 和现有后台业务回调，不反向依赖 `LocalRouterServer`，不直接访问数据库、backend 或 mailbox。原有构造选项不因拆分而改名或改变可选性。

action token 仍在服务实例创建时生成，生命周期和当前行为一致；不做全局共享或新持久化。后台模块继续区分四道校验：同源 `Origin`、操作 header、JSON content type 和 token。失败时保留校验顺序、状态码、响应内容及不得发生业务副作用的约束。

### 共用 JSON 读写

把当前 `readJson` 和 `json` 的实现提取到 `http-json.ts`，保留请求体字节限制、解析行为、响应 header 和序列化方式。异常仍由原有对应调用边界处理，不统一或改写各协议的错误响应。

普通 RPC/CLI 入口的 `refuseWebPage`、Host 的 Bearer 身份校验和后台的同源操作校验继续分别存在。共用 JSON 读写不等于共用权限规则。

### 工具能力对应关系

本文集中记录现有范围；对应协议的白名单仍在各自边界执行，不新增运行时能力配置。

| 入口 | 模型可调用的现有能力 |
|---|---|
| Codex 动态工具、Claude/ZCode MCP | `lane_directory`、`lane_attach_current`、`lane_send`、`lane_ack`、`lane_restore_project` |
| DSH Host 工具调用 | 前述工具中的 directory、attach、send、ack；不开放 restore；读取另走 Host read 接口 |
| Company native Host | `external_lane_send`、`external_lane_read`、`external_lane_ack`；不借本轮扩大能力 |
| CLI、后台网页 | 各自现有管理操作，不自动注册成 agent 工具 |

契约测试应覆盖共用工具名称、说明和参数语义的一致性，以及 Host 接口仅接受其既定范围。不同 schema 导出格式无需逐字相同。测试不能只核对工具数量，也不能用“共享了工具定义”推断所有入口已接通。

## 必须保持的行为

1. 工具名称、参数、说明和现有支持范围不变；身份仍来自现有宿主边界，不新增模型可填的身份字段。
2. HTTP 路径、方法、匹配规则、响应状态与内容、未接线行为不变；错误回调与拒绝分支不被统一成功响应掩盖。
3. 后台快照仍使用正在监听的 Router 信息；action token 的发布条件不变。
4. 页面仍自包含，构建后的资源路径正确；不改变页面内容或引入外部资源。
5. 请求校验失败不调用业务回调；普通 RPC 仍拒绝网页，Host 仍执行原有认证与绑定检查。
6. channel 生命周期、忙闲、唤醒、重连、请求标识、消息投递/读取/确认语义不变。
7. 不新增进程、端口、配置、公开接口、数据库状态或信任边界；不启动、停止、恢复任何真实 lane。

## 验证与完成条件

实现时先建立或补齐当前行为的测试，再做结构迁移。保留通过 `LocalRouterServer` 的集成测试，避免只测试新处理器而漏掉总入口接线。

重点覆盖：后台四条路由的正常输入、逐项缺少操作校验、错误输入、未接线与业务拒绝；JSON 读取限制及解析失败；共用工具与 Host 能力范围；RPC/CLI 来源保护；既有 channel 和恢复行为。

可复用的测试入口包括：

- `tests/process/dashboard-endpoints.test.ts`
- `tests/process/dashboard-render.test.ts`
- `tests/process/tell-guard.test.ts`
- `tests/process/local-transport.test.ts`
- `tests/tools/tool-service.test.ts`、`tests/mcp/`、`tests/adapters/codex/dynamic-tools.test.ts`
- `tests/process/dsh-host-api.test.ts`、`tests/process/native-host-service.test.ts`、`tests/process/native-host-boundary.test.ts`

实现完成时应通过 typecheck、受影响测试、完整测试与隔离构建。构建不得覆盖当前运行服务使用的 `dist/`，尤其后台 HTML 会被运行中的 Router 按请求读取；在隔离工作副本或隔离输出中验证构建及资源布局。无需为这轮结构验证重启生产 Router。

交付时分别报告结构迁移、自动测试、隔离构建和未验证的真实运行场景。自动测试通过不等于真实模型或共享部署已验收。

## 范围审计与后续边界

相对已认可结构，没有新增或扩大的产品接口、协议、持久状态或生命周期机制。新增文件只承接现有内部职责；能力清单和测试不授予新能力。

收件箱及发布工具、用户回复的业务身份、旧 Codex 会话取得新工具的兼容方式另行设计。本轮不提前实现这些能力，不借结构整理改写 `tell`、`ack` 或现有 Host 协议。

部署继续由外部对话执行。书面设计复核不代表允许本对话自行部署、重启或恢复 lane。

## 源码依据

- [工具服务](../../../src/tools/tool-service.ts)、[共用参数](../../../src/tools/tool-schema.ts)
- [Codex 工具适配](../../../src/adapters/codex/dynamic-tools.ts)、[MCP 参数导出](../../../src/mcp/tool-schemas.ts)
- [HTTP 总入口](../../../src/process/local-server.ts)、[启动装配](../../../src/process/main.ts)
- [DSH 接入](../../dsh-host-api.md)、[Company native Host 接入](../../native-host-api.md)
