# FF-pane

一个本地优先、厂商无关、可插拔的多 Agent 项目工作台。

A local-first, vendor-agnostic, pluggable multi-agent project workbench.

## 它解决什么问题

用户今天用 Codex 规划、Claude Code 执行，明天全部换成 Grok 或 Gemini——项目的计划、进度、决定、记忆一条都不丢。FF-pane 不拥有模型能力，它拥有项目状态：

- **角色与 AI 解耦**：Planner / Worker / Reviewer 三个角色，自由绑定任意 Agent（Codex、Claude Code、Gemini CLI、Grok、OpenCode、Aider…）
- **项目状态本地化**：计划版本、任务合同、执行证据全部存在本地，Markdown 为真实数据源
- **三层记忆体系**：
  - 项目记忆——决定 / 规则 / 教训 / 状态，Agent 提候选、用户审核
  - 共享记忆（用户习惯）——高权限，直接参与 Prompt 组装，实现"习惯先行"，越用越顺手
  - 知识库——大规模文档 RAG 检索（FTS5 + sqlite-vec 混合检索），用户主动提取
- **权限清晰**：读路径、写路径、命令、网络、危险操作五项权限，跟随角色和任务，不跟随 AI 品牌
- **多语言**：界面语言（zh-CN / en-US）与 AI 输出语言独立设置

## 项目状态

**设计阶段。** 开发启动时将发布 0.1.0。

## 文档

| 文档 | 内容 |
|---|---|
| [项目设计计划 v1.0](docs/项目设计计划-v1.0.md) | 产品与系统设计（细化版，含评审决议） |
| [技术选型](docs/技术选型.md) | Electron + TypeScript 技术栈与工程结构 |
| [项目设计计划 v0.1](docs/项目设计计划-v0.1.md) | 早期理论提案（存档） |

## 路线图

- **M1** 可用的单项目工作流：Provider 配置、四个 L1 Runtime 适配器（Codex / Claude Code / Gemini CLI / OpenCode）、计划版本化、任务合同、执行证据、项目记忆、中英双语界面
- **M2** 跨项目能力：用户习惯档案、知识库 RAG、跨 Agent Handoff 迁移、Reviewer 角色、更多 Runtime
- **M3** 按需增强：ACP 标准接入、任务并行、自定义角色

## 明确不做

宠物 / 成就系统 / 引导动画、内嵌终端分屏、PTY 模拟接入、云端同步、多用户协作、Agent 自由互聊、知识图谱。

## License

[MIT](LICENSE)
