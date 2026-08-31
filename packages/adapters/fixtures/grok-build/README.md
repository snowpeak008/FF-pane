# Grok Build fixtures（真机录制，模型端为本地假服务）

- **CLI 版本：** grok 1.0.13（`5e9a58528b76`），`~/.grok/bin/grok.exe`（原生 PE，非 npm 垫片）
- **录制日期：** 2026-08-31
- **录制环境：** Windows 11，Node v24.15.0
- **录制目录：** `%TEMP%\grokprobe`（系统临时目录，非本仓库；已 `git init`）
- **调研文档：** `docs/adapters/grok-build.md`

## 性质说明：什么是真的，什么是假的

本机 grok **未登录**，无法向 xAI 后端发出真实请求。为录到成功路径，用
`packages/adapters/fixtures/tools/fake-openai-server.mjs`（本仓库内，随录制一起提交）
起了一个本地 OpenAI 兼容服务端，经 grok 的自定义模型配置接入：

```toml
# 临时 GROK_HOME 下的 config.toml（用户的 ~/.grok 未被改动）
[model.ffpane-fixture]
model = "ffpane-fixture-model"
base_url = "http://127.0.0.1:8181/v1"
api_key = "fixture-key"
api_backend = "chat_completions"
context_window = 128000
```

于是：

- **真的**：事件行的类型与字段、工具调用的落地方式（文件真的被写、命令真的被执行）、
  权限拒绝的表现、会话恢复、退出码、强杀后的截断形态。这些全部出自 grok 本体。
- **假的**：模型说了什么。回话内容由脚本决定，故同样的脚本永远录出同样的流。
- **未覆盖**：真实 xAI 后端特有的字段——`usage` 行的 `messageId`/`signature`、
  非零的 `cache_read_input_tokens`、`stopReason` 的 `refusal`/`max_tokens`/`max_turn_requests` 取值、
  `thought` 事件（假模型不产思考块）、`plan` 事件。用户登录后可补录，命令见文末。

`real-streaming-json-auth-error.jsonl` 是真正意义上的全真录制（连模型端都是真的 xAI 拒绝）。

## 文件清单

| 文件 | 内容 | 录制方式 |
|---|---|---|
| `real-streaming-json-success.jsonl` | 完整成功流：`available_commands` → `usage` → `tool_call`(write) → `tool_call_update`×2（含 diff 正文）→ `tool_call`(run_terminal_command) → `tool_call_update`×3（含 exit_code / 输出字节数组）→ `text`×2（真增量）→ `end`(end_turn)。退出码 **0** | 假模型脚本：write → run_terminal_command → 文本收尾 |
| `real-streaming-json-resume.jsonl` | `-r <sessionId>` 恢复：`end.sessionId` 与 success 一致，证明未新开会话 | 同上，脚本只有一句文本 |
| `real-streaming-json-headless-noapprove.jsonl` | **不加 `--always-approve`**：写文件 `status: "failed"` +「User cancelled the execution for tool `write`」，文件未落地，`end.stopReason: "cancelled"`，**退出码 0** | 同 success 的脚本 |
| `real-streaming-json-deny-rule.jsonl` | `--deny "Write(**)"`：写被拒（「Denied by permission policy: deny rule on edit matching "**"」），后续命令工具亦以 cancelled 落地，`end.stopReason: "cancelled"`，**退出码 0** | 同上 |
| `real-streaming-json-killed.jsonl` | 轮次进行中 `taskkill /T /F` 强杀：只剩两行 `available_commands`，**无 end 无 error**，stderr 为空 | 假模型 120 秒不应答，8 秒后强杀 |
| `real-streaming-json-auth-error.jsonl` | 未登录：整流只有一行 `{"type":"error"}`，**无 end**，退出码 1 | **全真**（真 xAI 拒绝） |
| `real-streaming-json-api-error.jsonl` | 伪造 `XAI_API_KEY`：`available_commands`×2 → `error`（HTTP 400 invalid API key），**无 end**，退出码 1 | **全真**（真 xAI 后端返回 400） |
| `real-json-success.json` | `--output-format json` 的单对象输出（`text`/`stopReason`/`sessionId`/`usage`/`num_turns`/`modelUsage`） | 同 success 的脚本 |

## 脱敏说明

- `C:/Users/admin` → `C:/Users/USER`（含 URL 编码形态 `C%3A%5CUsers%5Cadmin`）。
- 临时数据目录名 `ffpane-grok-home` → `GROK_HOME`。
- `sessionId`（UUIDv7）与 `requestId` 为随机生成、不含账号信息，**保留原值**——
  success ↔ resume 两份文件的 sessionId 一致性可被测试断言。
- 除上述替换外未做任何增删改；每行均为 CLI 原样输出的合法 JSON。

## 复现录制

```bash
# 1) 起假模型服务端（脚本见 fixtures/tools/，--dump 可留存请求体用于核对工具 schema）
node packages/adapters/fixtures/tools/fake-openai-server.mjs --port 8181 --script <脚本.json>

# 2) 用临时 GROK_HOME 跑一轮（用户的 ~/.grok 不受影响）
GROK_HOME=<临时目录> GROK_DISABLE_AUTOUPDATER=1 \
  grok -p "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did." \
       -m ffpane-fixture --output-format streaming-json --cwd <录制目录> \
       --always-approve --no-auto-update
```

补录真实 xAI 后端成功流的前置条件（用户介入项）：`grok login` 或提供 `XAI_API_KEY` 后，
去掉 `-m ffpane-fixture` 与 `GROK_HOME` 重跑上面第 2 步即可。届时应重点核对：
`usage` 行是否出现 `messageId`/`signature`、`thought` 事件的字段形状、
以及 `end.stopReason` 在长回答被截断时的取值。

## 注意

- stderr 不在 fixture 内：grok 的日志与更新提示走 stderr，stdout 只有 NDJSON。
- 每份 fixture 里 `available_commands` 会重复多次（每次模型响应前一遍），这是真实行为，未做去重。
