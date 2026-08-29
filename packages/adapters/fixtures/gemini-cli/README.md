# Gemini CLI fixtures（真实录制 + 文档构造混合）

- **CLI 版本：** @google/gemini-cli 0.57.0（npm 全局安装）
- **录制/构造日期：** 2026-08-29
- **录制环境：** Windows 11 + PowerShell，Node v24
- **录制目录：** `%TEMP%\ffpane-gemini-probe`（系统临时目录，非本仓库）
- **认证状态：** 本机无 GEMINI_API_KEY、无 OAuth 登录态 → **无法录制完整成功任务流**。
  真实录制仅覆盖错误路径与会话存储；成功路径为文档构造（依据 0.57.0 安装包内源码
  `bundle/gemini-*.js` 的事件发射代码与 `bundle/docs/cli/headless.md`），**待真机校验**。

## 文件清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `real-json-auth-error.json` | **真实录制** | 无认证时 `gemini -p "Say hello" -o json` 的 stdout；进程退出码 **41**（FatalAuthenticationError）。注意：有 `session_id` 与 `error`，无 `response` |
| `real-stream-json-api-error.jsonl` | **真实录制** | 假 API key + `-o stream-json --skip-trust`：`init` → `message`(user) → `result`(status=error)；进程退出码 **400**（API 错误的 HTTP 状态码直接成为退出码）。`stats.models` 中出现 `gemini-3.1-flash-lite`（模型路由分类器）与 `gemini-3.1-pro-preview`（`-m auto` 解析目标） |
| `real-session-storage.jsonl` | **真实录制** | 原生会话文件 `~/.gemini/tmp/<项目目录名>/chats/session-2026-08-29T09-08-d0eae9f7.jsonl` 原文。首行为会话元数据（sessionId/projectHash/kind），后续行为消息追加与 `$set` 增量更新 |
| `constructed-stream-json-success.jsonl` | **文档构造，待真机校验** | 一次完整成功任务（`--approval-mode yolo`）：`init` → `message`(user) → `message`(assistant, delta) → `tool_use`(write_file) → `tool_result`(统一 diff) → `tool_use`(run_shell_command) → `tool_result` → `message`(assistant, delta) → `result`(success) |
| `constructed-stream-json-headless-deny.jsonl` | **文档构造，待真机校验** | 默认审批模式（`--approval-mode default`）headless 下 `write_file` 被内置 Headless Denial Rule 拒绝：`tool_result` status=error、error.type=`permission_denied`。依据 `bundle/policies/write.toml` 的显式规则与 `bundle/docs/reference/policy-engine.md`（非交互模式 ask_user 视同 deny） |
| `constructed-json-success.json` | **文档构造，待真机校验** | `-o json` 成功输出：`session_id` + `response`（最终文本）+ `stats`（完整 SessionMetrics：models/tools/files 三段，结构取自源码 `createInitialMetrics()`） |

## 构造依据（逐字段可溯源）

- 事件类型与字段名：`bundle/gemini-*.js` 中 `streamFormatter.emitEvent({...})` 的调用点
  （`init`/`message`/`tool_use`/`tool_result`/`error`/`result` 六类）。
- `stats` 简化结构（stream-json 的 result 事件）：`StreamJsonFormatter.convertToStreamStats()`。
- `stats` 完整结构（json 模式）：`UiTelemetryService` 的 `createInitialMetrics()`。
- 工具参数键名：`bundle/docs/reference/tools.md` 的 "Tool argument keys" 表
  （`write_file`: file_path/content；`run_shell_command`: command/description/dir_path/is_background）。
- edit 类工具成功时 `tool_result.output` 为 jsdiff `createPatch` 统一 diff 文本
  （表头 `Original`/`Modified`，context 3，来自源码 `renderDisplayDiff()`）；
  hunk 头与换行细节可能与真机输出有出入，**以真机校验为准**。
- 拒绝消息文本：源码字面量 `` Tool execution for "${toolDisplayName}" denied by policy. ``；
  `write_file` 的 displayName 是否为 "WriteFile" 待校验。
- `tool_id`：来自模型返回的 functionCall.id（无则回退时间戳/UUID），**格式不保证，按不透明字符串处理**。

## 脱敏说明

- 用户目录 `C:\Users\<真实用户名>` → `C:\Users\USER`（JSON 转义形式 `C:\\Users\\USER`）。
- 真实录制中的 `session_id`、`projectHash`、消息 id 为随机生成、不含账号信息，保留原值
  （`real-stream-json-api-error.jsonl` 与 `real-session-storage.jsonl` 的 sessionId 一致性可被测试断言）。
- 除路径脱敏外，真实录制文件未做任何增删改。

## 注意

- **stderr 不在 fixture 内**：Gemini CLI 的 stderr 非常吵（终端能力警告、ripgrep 缺失提示、
  API 错误完整堆栈、`[WARNING]`/`[ERROR]` 用户反馈），适配器只解析 stdout 的 JSONL，stderr 仅作原始日志留存。
- 真实录制时**必须加 `--skip-trust`**：未信任目录下 headless 直接以退出码 55 失败（FatalUntrustedWorkspaceError），
  stdout 无任何 JSON 输出。
- 补录真实成功流的前置条件（用户介入项）：提供 `GEMINI_API_KEY`（AI Studio 免费申请）后执行：
  ```powershell
  cd $env:TEMP\ffpane-gemini-probe
  $env:GEMINI_API_KEY="<key>"
  gemini -p "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did." -o stream-json --skip-trust --approval-mode yolo
  ```
