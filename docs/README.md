# Lane Router 使用与验证文档

- [使用与手工验证（含议题工具、CLI/HTTP、双库恢复与现场验收）](manual-tests.md)
- [DSH Host 接入](dsh-host-api.md)
- [原生 Company Lead 共享接入](native-host-api.md)
- [本机统一账号切换](account-switching.md)

## 需求

- [用户议题收件箱（问题看板）](superpowers/specs/2026-10-17-user-issue-inbox-requirements.md)
- [图资源接入需求](superpowers/specs/2026-10-18-graph-resource-requirements.md)
- [知识库需求（第一版：LLM wiki + 检索工具 + 录入工具）](superpowers/specs/2026-10-20-knowledge-base-requirements.md)；依据：[知识过期的现状核对与成熟做法调研](superpowers/specs/2026-10-20-knowledge-staleness-research.md)

## 设计

- [后台 HTTP 边界整理设计](superpowers/specs/2026-10-17-dashboard-http-boundary-design.md)
- [用户议题收件箱架构草案](superpowers/specs/2026-10-17-user-issue-inbox-design.md)
- [统一账号切换设计](superpowers/specs/2026-10-18-account-switching.md)
- [图资源接入技术设计](superpowers/specs/2026-10-18-graph-resource-design.md)
- [知识库技术设计（由 kb-impl 实施）](superpowers/specs/2026-10-20-knowledge-base-design.md)
- [Claude 账号：开窗注入已回退，改为按账号查余量（需求与设计，以文末修订为准）](superpowers/specs/2026-10-19-claude-account-at-launch.md)
- [议题页：两栏在一屏内各自滚动（需求与设计）](superpowers/specs/2026-10-19-issue-inbox-scroll-layout.md)
- [议题问题状态失真修复（需求与设计）](superpowers/specs/2026-10-19-issue-question-state-fix.md)
- [产品工具 schema 根节点改为平表（需求与设计）](superpowers/specs/2026-10-19-tool-schema-flat-root.md)
- [问答页已读：有焦点且条目末尾进入视野才算读过（需求与设计）](superpowers/specs/2026-10-19-issue-read-on-sight.md)
- [问答页小修五项（需求与设计）](superpowers/specs/2026-10-19-issue-ui-touchups.md)
- [问答页改成左侧边栏布局（需求与设计）](superpowers/specs/2026-10-20-issue-page-sidebar-layout.md)
- [从问答页开启问答，lane 没开着就唤醒（需求与设计）](superpowers/specs/2026-10-20-issue-start-from-page.md)
- [lane 结束问答，lane 默认把要用户回答的问题发到问答（需求与设计）](superpowers/specs/2026-10-20-issue-lane-close-and-default-publish.md)
- [问答里的文件：点开 lane 写的本机路径，回复里贴图和发文件（需求与设计）](superpowers/specs/2026-10-20-issue-files.md)
- [问答页回复对象：空着时自动选上新来的问题（补充稿）](superpowers/specs/2026-10-20-issue-reply-target-adopt.md)
- [问答页：用户写的内容按纯文本显示（需求与设计）](superpowers/specs/2026-10-20-issue-user-text-plain.md)
- [问答页唤醒 Claude lane：说清要点一下确认（补充稿）](superpowers/specs/2026-10-20-issue-wake-claude-confirm.md)
- [lane 自主性：开新、唤醒、轮换不再先问用户，新建和恢复的 lane 按有没有已授权的活开工（需求与设计）](superpowers/specs/2026-10-20-lane-autonomy-gates.md)
- [唤醒重通知：通知帧没起回合、积压还在，就按 15 / 60 / 180 / 600 秒再送（需求与设计）](superpowers/specs/2026-10-20-wake-renotify.md)
- [问答页：用键盘发送，可选 Ctrl+Enter 或 Enter（需求与设计）](superpowers/specs/2026-10-20-issue-send-shortcut.md)
- [Codex 宿主独立进程：需求与设计](superpowers/specs/2026-10-19-codex-host-process.md)

## 界面样稿

- [议题收件箱布局比较（普通浏览器版）](superpowers/mockups/issue-inbox-layout-browser.html)

## 实施计划

- [后台 HTTP 边界整理](superpowers/plans/2026-10-17-dashboard-http-boundary.md)
- [tell 用户消息投递底座抽取](superpowers/plans/2026-10-17-tell-user-delivery.md)
- [用户议题收件箱](superpowers/plans/2026-10-18-user-issue-inbox.md)
- [统一账号切换](superpowers/plans/2026-10-18-account-switching.md)
- [图资源接入](superpowers/plans/2026-10-19-graph-resources.md)
