# 整合 project-lane-restore 与 lane open/new CLI

**背景：** `feat/lane-router-v1` 上有两套并行实现——远端 2026-08-13 的 `lane_restore_project`（批量恢复 project 离线 lane，claude+codex，工具 + 兼容 CLI），与本地 2026-08-18 的 `lane-router-lane new/open`（单条打开/新建，claude）。用户裁决：**两个功能都保留，底层统一**。功能互补：restore 管"重启后批量拉起"，lane CLI 管"单条打开 + 新建"。

**统一原则：** restore 保留它独有的 Router 侧判断（项目选择、逐 lane 状态码、codex TUI 在线判定、30 秒防重复预约）；"怎么开窗、怎么拼 resume 命令"统一走 `terminal-spawn` / `terminal-child`。

## 逐项裁决

| 冲突点 | 裁决 | 理由 |
|---|---|---|
| terminal 机械件（`visible-terminal`+`restore-terminal-child` vs `terminal-spawn`+`terminal-child`） | 保留 `terminal-spawn` 系，删除另一套 | 后者带 `--terminal` 三档、wt 支持（对方重构把 rotation 的 wt 退化掉了）、cmd/wt 引号实测修复、vendor 环境剥离（Router 进程继承首个 ensure 它的会话的 `CLAUDE_*`，restore 不剥离会复现 2026-08-12 双进程抢 lane 一族的身份混淆）、status 文件验证 |
| `terminal-child` 缺 codex resume | 扩：resume 模式支持 `backend: "codex"` → `codex-launcher.js resume <threadId>`（吸收 `restoreClientCommand` 的 codex 分支；claude 分支与现有一字不差，直接删） |
| cwd 存储（`startup_json.cwd` vs `binding.cwd` 列） | 收敛到 **`cwd` 列**；`startup.cwd` 只作读取兜底（对方机器的库可能已有值），`startup` 回归 attach 时 `{}` | 列有类型、可查询、命名诚实；schema v3 迁移已在生产库副本预演 |
| cwd 写入者（三个） | 全保留，统一写列：attach 播种（context.cwd）、工具调用刷新（`refreshStartup`→`refreshCwd`）、lifecycle hook（每 turn，无工具调用也覆盖）、claude locator 兜底回填 | 各覆盖不同时机，互为备份；写的是同一列不会打架 |
| `ClaudeSessionLocator`（vendor 档案反查） | 保留，降级为"列与 startup 都无值时的兜底 + 回填"；`resume-info` 端点也走同一 Router 侧解析 | 让功能上线前的存量 lane（本机 17 条）不必手传 `--cwd`；vendor 格式脆，所以只兜底不作首选 |
| restore 的启动契约 | 保持 `launch_requested` 弱语义（不等 status 文件），但经共享机械件获得剥离/引号/标题；statusPath 照发不等待 | 批量场景逐条等 30 秒不合理；对方 spec 明文弱语义 |
| `updateBindingStartup` | 删除（唯一调用方改写列后无人使用），其测试改验列 | 面最小化 |
| `lane_restore_project` 工具 + `lane-router-restore-project` CLI | 原样保留 | 对方已批准的公开面；用户裁决保留 |
| `rotation-launcher` | 本地版整体胜出（已含对方重构意图 + `--terminal`） | |

## 提交序列

1. `merge origin/feat/lane-router-v1`：解决文本冲突，两套机械件暂时共存，双方全部测试先绿。
2. `refactor: run lane restore through the shared terminal machinery`：restorer 的 launch 改走 `spawnTerminal`/`childEnvironment`/`terminal-child`（codex resume 模式落地），删 `visible-terminal.ts`、`restore-terminal-child.ts` 及其测试（行为断言迁移）。
3. `refactor: converge conversation cwd on the binding column`：attach 播种/调用刷新/locator 回填全部写列；restore 与 `resume-info` 共用一份 Router 侧 cwd 解析（列 → startup 兜底 → claude locator）；删 `updateBindingStartup`。
4. `docs`：manual-tests 与两份 spec 的整合注记；guidelines 仓库手册补第五工具。
5. push `feat/lane-router-v1`。

每步全量测试 + typecheck；merge 按 merge-review 纪律逐个双方共改文件核对（重点：搬走的代码不留旧路径、`restoreClientCommand` 的 claude 分支必须删干净不留双路径）。
