# FF-pane

一个本地优先、厂商无关、可插拔的多 Agent 项目工作台。

A local-first, vendor-agnostic, pluggable multi-agent project workbench.

## 它解决什么问题

FF-pane 是本地优先的多窗口终端工作台。在一个项目里并排打开多个 Agent 或普通终端（分屏、标签页），窗口之间经 MCP 通信，对话落在项目目录里。模型能力仍由你选定的 CLI 提供，本软件管理的是项目现场：

- **多窗口工作台**：内嵌 PTY + xterm.js。每个窗口有角色（管理者 / 规划者 / 执行者 / 审查者 / 普通终端），经 `ffpane-workbench` MCP 互相投递
- **项目记忆**：决定 / 规则 / 教训 / 状态。Agent 可检索、可提交候选；用户在记忆页审核
- **知识库**：大规模文档 RAG（FTS5 + sqlite-vec）。用户主动收录，Agent 经知识库 MCP 检索
- **Provider 与启动配置**：API 或 CLI 登录、Profile、权限信封、密钥放在系统密钥库
- **多语言**：界面语言（zh-CN / en-US）与 AI 输出语言独立设置

旧的后台会话（计划 → 任务 → 执行记录那套页面）已下线。磁盘上的旧计划、任务、会话文件保留，不删除、不迁移。界面、启动和主进程都不再读取这些文件。

## 项目状态

**v0.10.17（M3 完成；Phase 10 多窗口终端工作台进行中，T10.15 加固已验收，丙类待定）。** 进度事实源见 [docs/开发进度.md](docs/开发进度.md)。

## 启动方式

| 方式 | 命令 / 操作 | 说明 |
|---|---|---|
| 开发模式 | 仓库根运行 `pnpm dev` | electron-vite 热更新，日常开发用 |
| 打包 | 仓库根运行 `pnpm package` | 产出 NSIS 安装包与免安装目录，落在 `apps\desktop\release\` |
| 双击启动（免安装） | 双击根目录 `FF-pane.cmd` | 定位并启动打包产物；未打包时会提示先运行 `pnpm package` |
| 直接运行 exe | `apps\desktop\release\win-unpacked\FF-pane.exe` | `FF-pane.cmd` 启动的就是它；打包产物不进 git，需先本机打包 |
| 安装版 | 运行 `apps\desktop\release\FF-pane-Setup-<版本>.exe` | 向导式用户级安装（默认 `%LOCALAPPDATA%\Programs\FF-pane`），免管理员权限 |

> 打包产物体积大（win-unpacked 约数百 MB），不进 git——所以根目录放的是轻量启动器 `FF-pane.cmd` 而非真 exe。

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

宠物 / 成就系统 / 引导动画、云端同步、多用户协作、知识图谱；MCP 只用 stdio、不引入 HTTP。

> **Phase 10 起调整：** 旧版红线中的「内嵌终端分屏 / PTY 模拟接入 / Agent 自由互聊」已撤销——本阶段做软件内嵌 PTY + xterm.js 分屏/标签页，以及窗口间经 MCP 投递并落盘 `.md` 的通信。详见 [docs/Phase10-多窗口终端工作台计划.md](docs/Phase10-多窗口终端工作台计划.md)。

## License

[MIT](LICENSE)
