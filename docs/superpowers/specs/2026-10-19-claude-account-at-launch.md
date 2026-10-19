# Claude 切号：下次打开的 lane 用选中的账号 —— 需求与设计

**状态：** 需求与设计合一稿，2026-10-19 由 `lane-router/design` 起草。用户在议题看板上决定「做」（议题 `f0118f0b`，2026-10-19）。实施归 `lane-router/impl`，第五节是验收标准。

## 术语表

| 词 | 含义 |
|---|---|
| 账号后台 | `lane-router-accounts`（`src/accounts/`），本机账号页与切换服务，数据目录默认 `%USERPROFILE%\.lane-router-accounts` |
| Codex 账号 | 账号后台今天管理的 ChatGPT 账号（`profiles`），经 app-server 在线切换 |
| Claude 账号 | 本稿新增：一个邮箱标签加一个 `claude setup-token` 生成的长期 OAuth token |
| 启动文件 | 账号后台写在自己数据目录里的 `claude-launch.json`，内容是当前选中的 Claude 账号的 token；开 Claude 窗口的进程读它 |
| terminal child | `src/process/terminal-child.ts`，四条开窗路径最终都经它 `spawn` 出 `claude` 或 `codex` |

## 一、问题与结论

lane-router 的账号切换只覆盖 Codex。Claude 的切换今天靠在任一窗口 `/login`，所有会话在各自下次刷新 token 时跟过去。

2026-10-19 的探测（议题「Claude 切号探测」，`bf7b26ef`）证明：Claude 的 refresh token 一次性轮换；旧 token 再用被拒且 Claude 会清空凭据文件；重放不连坐。所以**不能**靠改写共享凭据文件切号。Claude Code 唯一不轮换的凭据是 `claude setup-token` 生成的一年期 OAuth token，经 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量传入，**只在会话启动时读取**（官方文档 authentication 页）。

结论：切号点是「开窗口那一刻」。用户在账号页选中一个 Claude 账号后，之后新开的 Claude lane 用它；已开着的 lane 不动，关了重开才换；要全体立刻换仍用 `/login`。

## 二、选型

| 选择 | 采用 | 理由 |
|---|---|---|
| token 由用户自己跑 `claude setup-token` 得到、粘进账号页 | 是 | 官方流程要在浏览器里授权，后台代跑不了；一年跑一次 |
| token 存在账号后台的受限数据目录（owner + SYSTEM 的 ACL，`atomicPrivateJson`） | 是 | 和 Claude 自己的 `~\.claude\.credentials.json` 同等保护；本机没有可用的 Claude keyring。模块注释里「模型凭据不进 JSON」说的是 Codex 的 keyring 凭据，Claude 没有那个选项，这里要把注释改准 |
| 开窗进程读**启动文件**，不经 HTTP 问后台 | 是 | 开 lane 不能依赖后台活着（后台窗口关了 lane 还得能开）；token 一年有效，文件过期不是问题；文件在受限目录里，读者是同一 Windows 用户 |
| 注入点放在 terminal child，不动四条开窗路径 | 是 | 四条路径（`lane-router-lane new` / `open`、看板打开与 `lane_restore_project`、`lane-router-rotate`）都经 terminal child 启动 CLI；在那里按 backend 加环境变量，一处改、四处生效 |
| Claude 账号与 Codex 账号**各选各的** | 默认 | 两边账号集合不一定相同；Codex 在线切、Claude 下次打开才换，语义不同。已在议题里问用户，答「一起切」再改成联动 |
| 不校验 token 有效性 | 是 | 校验要真发一次模型请求；坏 token 在第一次开 lane 时由 Claude 自己报错，页面上提示用户重做 setup-token 即可 |

## 三、设计

### 3.1 账号后台

数据（都在受限数据目录）：

| 文件 | 内容 |
|---|---|
| `claude-profiles.json` | `{ version: 1, profiles: [{ id, email, token, createdAt }], selectedId: string \| null }`。`id` 随机；`email` 是用户填的标签，不做身份核实 |
| `claude-launch.json` | `{ version: 1, email, token }`。选中变化时原子重写；取消选中时删除。`terminal child` 读的就是它 |

HTTP（与现有端点同守卫：`Host` 核对、`Origin` 同源、`X-Account-Action: 1`、JSON、8 KB 上限）：

| 请求 | 作用 |
|---|---|
| `GET /api/state` | 现有响应加 `claude: { profiles: [{ id, email, createdAt }], selectedId }`。**不含 token** |
| `POST /api/claude/profiles` `{ email, token }` | 添加。`token` 必须以 `sk-ant-oat` 开头、长度合理；重复 email 允许（用户自己分辨） |
| `POST /api/claude/profiles/delete` `{ profileId }` | 删除；若是选中的，一并取消选中并删启动文件 |
| `POST /api/claude/select` `{ profileId }` 或 `{}` | 选中或取消选中；写或删启动文件 |

现有 `http-server.ts` 的 POST 只允许 `profileId` 一个字段，要按路径放宽；token 只在请求体里出现一次，不进日志、不进错误消息、不回显。

### 3.2 terminal child

`childCommand` 之后、`spawn` 之前：

1. 只对 `request.backend === "claude"`。
2. 启动文件路径：`dirname(连接文件) + "claude-launch.json"`，连接文件按今天核心的取法：`LANE_ROUTER_ACCOUNTS_CONNECTION` 环境变量，否则 `dataRoot/config.json` 的 `accounts.connectionFile`（`dataRoot` 取 `LANE_ROUTER_DATA_ROOT`，否则 `~/.lane-router`）。两处都没有 → 不注入，照旧。
3. 文件存在且能解析 → 子进程环境加 `CLAUDE_CODE_OAUTH_TOKEN`，并在终端里打印一行 `lane 账号：<email>（来自账号页的选择）`；文件不存在 → 照旧，不打印；文件存在但读不了或格式不对 → 照旧，打印一行说明原因。
4. token 只进 `spawn` 的 `env`，不写状态文件、不写日志、不进 `LANE_ROUTER_CHILD_REQUEST`。

今天 Claude 会话里 `/login` 会改共享文件、别的会话跟着换；选中 Claude 账号之后，新开的 lane 不再跟共享文件，只跟选中项。这是行为变化，写进 `docs/account-switching.md`。

### 3.3 账号页

现有页面下方加一节「Claude lane（下次打开时生效）」：

- 列表：每个 Claude 账号一行，邮箱、添加时间、「选用」单选、「删除」。顶部一句「当前选用：<email>。之后新开的 Claude lane 用它；已开着的不受影响。」没选中时写「未选用：新开的 Claude lane 用本机 `/login` 的账号。」
- 「添加 Claude 账号」展开表单：邮箱、token 粘贴框（`type=password`）、一句怎么拿 token：`claude setup-token`。提交后清空表单。
- 页面 JS 不持有、不显示 token；`/api/state` 里也没有。

### 3.4 代码落点

| 位置 | 改动 |
|---|---|
| `src/accounts/claude-profiles.ts`（新） | 读写 `claude-profiles.json`、写删 `claude-launch.json`，用 `atomicPrivateJson` / `readPrivateJson` |
| `src/accounts/http-server.ts` | 三个新 POST 路径；`/api/state` 加 `claude`；放宽字段校验到按路径 |
| `src/accounts/main.ts` | 装配 |
| `src/accounts/accounts.html` / `accounts.js` / `accounts.css` | 新节与表单 |
| `src/process/terminal-child.ts` | 3.2 |
| `src/process/router-config.ts` | 不改（`accounts.connectionFile` 已有） |
| `docs/account-switching.md`、`docs/manual-tests.md`、`docs/README.md` | 文档 |

不改：Codex 切换服务（`switch-service.ts`、`consumer.ts`、gate）、Router 核心、四条开窗路径的调用方、`childEnvironment`。

## 四、范围审计

| 候选面 | 使用者与频率 | 依据 | 删掉的后果 | 现有替代 | 处置 |
|---|---|---|---|---|---|
| `claude-profiles.json` 与三个 POST | 用户，一年几次 | 用户决定「做」 | 无处存账号 | 无 | 保留 |
| `claude-launch.json` | 每次开 Claude 窗口 | 开窗不能依赖后台在线 | 开窗要问后台，后台停了就开不了 lane | HTTP 查询 | 保留 |
| terminal child 注入 | 每次开 Claude 窗口 | 四条路径一处改 | 四条路径各改一遍 | 无 | 内部化 |
| 页面新节 | 用户 | 需求 | 只能手改 JSON | 无 | 保留 |
| token 有效性校验 | 无 | 无 | 坏 token 在第一次开 lane 时才发现 | Claude 自己的报错 | 删除 |
| 与 Codex 选中联动 | 无（待用户答复） | 无 | 无 | 各选各的 | 推迟 |
| VM 上的 lane 也注入（经 `open-vm-lane.ps1` 传环境变量） | 无 | 无 | VM lane 仍用 VM 上的 `/login` | — | 推迟 |
| 运行中会话在线换号 | 无 | 另一条议题在探 `apiKeyHelper` | — | `/login` | 推迟 |

## 五、验收标准

每条要有自动测试；第 7 条是真机。

1. 添加、选中、取消选中、删除 Claude 账号经 HTTP 往返；`/api/state` 的 `claude` 节出现账号与 `selectedId`，响应全文**不含** token；重启后台后账号与选中项仍在。
2. 选中时 `claude-launch.json` 以受限 ACL 原子写出，内容是该账号的 token；取消选中或删除选中项时文件被删除。
3. terminal child：有启动文件且 backend 为 claude → 子进程 `env.CLAUDE_CODE_OAUTH_TOKEN` 等于 token，codex 请求不加；没有文件 → 环境与今天逐字相同；文件损坏 → 环境与今天相同且 stderr 有一行说明。token 不出现在状态文件、`LANE_ROUTER_CHILD_REQUEST` 或任何日志断言里。
4. 连接文件两种取法（环境变量、`config.json`）都能定位启动文件；两者都没有时不读任何文件。
5. 页面：Claude 节渲染账号与选中状态；添加表单发出的请求体含 token，页面 DOM 与后续渲染里不含 token（用 happy-dom 断言）。
6. 现有 Codex 切换测试不改不删；`npm test`、`typecheck`、`build` 全过。
7. 真机（本机，账号后台重启到新构建后）：添加账号 A 并选用 → `lane-router-lane open` 一条 Claude lane → 会话里 `/status` 显示 A；取消选用 → 再开一条 → 显示 `~\.claude` 当前登录的账号。记入 `docs/manual-tests.md`。

## 六、验证方法与变异检验

- 跑法：`npm test`、`npm run typecheck`、`npm run build`。
- 不碰在跑的共享 Router（`~/.lane-router/discovery.json` 的 pid）和在跑的账号后台（`%USERPROFILE%\.lane-router-accounts`，监督进程窗口）；测试一律临时目录。主检出不 build。
- 变异（改坏一处看对应测试红不红，看完改回）：`/api/state` 把 token 带出来 → 1 红；取消选中不删启动文件 → 2 红；terminal child 对 codex 也注入 → 3 红；启动文件缺失时仍改环境 → 3 红；页面把 token 回显到 DOM → 5 红。

## 七、边界

- 已开着的 lane 不换号；全体立刻换仍用 `/login`。
- token 一年到期要用户重跑 `setup-token` 再粘一次；页面不提醒到期（文档写明）。
- VM 上的 lane 不在本稿内。
- 账号后台要重启到新构建才有新接口；重启时机归用户，部署由 design 安排。
