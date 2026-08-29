# OpenCode fixture（T2.0 真实录制）

- **录制日期：** 2026-08-29
- **OpenCode 版本：** 1.18.25（`npm install -g opencode-ai`，Windows 11 + PowerShell）
- **性质：真实录制，非文档构造。** 本机没有可用的真实 Provider（无 API key、无 Ollama），因此在系统临时目录用 Node 起了一个**本地 mock OpenAI 兼容端点**（实现 `/v1/chat/completions` SSE 流式响应，按提示词中的标记返回固定文本或 `write`/`bash` tool_calls），并通过 `opencode.json` 的自定义 provider（`npm: "@ai-sdk/openai-compatible"`, `baseURL: http://127.0.0.1:8901/v1`）接入。**所有事件均由真实的 OpenCode 1.18.25 二进制产生**：文件真实写入磁盘、命令真实由 PowerShell 执行（exit code 真实）、权限流真实触发。仅模型回复的文本内容是脚本预设的。
- **录制环境：** 全部运行在 `%TEMP%\ffpane-oc\proj`（临时目录，非本仓库）；每类场景一次 `opencode run --format json`（stdout 原样落盘）或对 `opencode serve` 的 HTTP/SSE 抓取。
- **脱敏说明：** Windows 用户名已统一替换为 `REDACTED`（出现在绝对路径中）。API key 本来就是假值（`mock-key-not-real`）。会话 ID、消息 ID 为本地随机生成，无敏感性，原样保留。除此之外未做任何修改（包括事件顺序与字段）。

## run-json/ —— `opencode run --format json` 的 stdout（JSONL）

| 文件 | 命令要点 | 覆盖的行为 |
|---|---|---|
| `s1-text.jsonl` | `opencode run --format json "Say hello briefly."` | 纯文本回合：`step_start` → `text` → `step_finish(stop)` |
| `s2-write-allow.jsonl` | 默认权限（edit=allow） | `write` 工具完整流：`tool_use(completed)` 带 `input`/`output`/`metadata.filepath`，随后第二轮文本收尾 |
| `s3-write-ask-reject.jsonl` | `OPENCODE_PERMISSION={"edit":"ask"}`，无 `--auto` | 非交互下权限自动拒绝：`tool_use(state.status=error)`，错误文案见文件；**JSON 流中无权限事件** |
| `s3-stderr.txt` | 同上的 stderr | `! permission requested: edit (...); auto-rejecting` 警告（含 ANSI 码） |
| `s4-write-ask-auto.jsonl` | 同 s3 但加 `--auto` | 权限自动批准，流程同 s2 |
| `s5-bash.jsonl` | 默认权限 | `bash` 工具：`input.command`、`output`、`metadata.exit=0`（Windows 下由 PowerShell 执行，输出带 `\r\n`） |
| `s6-resume.jsonl` | `opencode run --format json -s <s1的sessionID> "..."` | 原生会话恢复：事件 sessionID 与 s1 一致 |
| `s7-provider-error.jsonl` | mock 端点已停止 | `error` 事件（`APIError`，`isRetryable:true`，进程退出码 1） |
| `session-list.json` | `opencode session list --format json -n 5` | 会话枚举格式 |

## server/ —— `opencode serve --port 4747`（`OPENCODE_PERMISSION={"edit":"ask"}`）的 HTTP/SSE 抓取

| 文件 | 来源 | 覆盖的行为 |
|---|---|---|
| `health.json` | `GET /global/health` | 健康检查与版本 |
| `session-create.json` | `POST /session` | 建会话响应（原生 session 对象） |
| `message-sync-response.json` | `POST /session/:id/message`（同步等待） | 返回 `{info, parts}` 完整消息 |
| `sse-events.jsonl` | `GET /event` 全程抓取（156 条，每行一事件，顺序保真） | `server.connected`、`session.created/updated`、`message.updated`、`message.part.updated`（工具 pending→running→completed 状态机）、**`message.part.delta`（流式文本增量）**、`session.status(busy/idle)`、`session.idle`、`session.diff`、`permission.asked/replied`、`file.edited`、`file.watcher.updated`、启动噪声（`plugin.added` 等） |
| `event-permission-asked.json` | 从 SSE 单独摘出 | 权限请求完整结构（`metadata.diff` 为 unified diff；回复端点 `POST /session/:id/permissions/:permissionID` body `{"response":"once"}` 实测 200） |
| `session-diff.json` | `GET /session/:id/diff` | **注意：非 git 目录下为空数组**（快照依赖内部 git），适配器不要以此为 file_change 主信号 |
| `abort-response.txt` | 慢速流式响应进行中 `POST /session/:id/abort` | 返回 `status=200 body=true`，中断成功 |
| `message-list.json` | `GET /session/:id/message` | 消息历史格式（含被 abort 截断的最后一条） |

## 待真机校验项（需要真实 Provider 后补录）

- `reasoning` 事件（`--thinking`）：mock 未返回 reasoning_content，未录到。
- `question` 工具与 `plan_enter/plan_exit` 的事件形态（run 模式下被强制 deny）。
- git 目录下 `session.diff` 是否有内容。
- 真实模型下的多轮长会话与上下文压缩（compaction）事件。

复现方式：mock 端点与编排脚本约 200 行 Node（`mock.js`、`server-probe.js`），本次运行于 `%TEMP%\ffpane-oc\`，未入库；如需复刻可按上表命令与 `docs/adapters/opencode.md` §4.2 的 provider 配置重建。
