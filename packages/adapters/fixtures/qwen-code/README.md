# Qwen Code fixtures（真机录制，模型端为本地假服务）

- **CLI 版本：** @qwen-code/qwen-code 0.23.0（npm 全局安装，`%APPDATA%\npm\qwen.cmd` 垫片）
- **录制日期：** 2026-09-05
- **录制环境：** Windows 10，Node v24.15.0
- **录制目录：** `%TEMP%\ffpane-qwen-rec`（系统临时目录，非本仓库；已 `git init`）
- **调研文档：** `docs/adapters/qwen-code.md`

## 性质说明：什么是真的，什么是假的

本机无任何 Qwen/ModelStudio 凭据（**Qwen OAuth 免费层已于 2026-04-15 废止**，0.23.0 官方文档
auth.md 明示）。为录到成功路径，用一个本地 OpenAI 兼容假服务端（照
`fixtures/tools/fake-openai-server.mjs` 的款式，脚本内嵌于录制命令，形状同源）经 qwen 的
`--auth-type openai` + `OPENAI_API_KEY`/`OPENAI_BASE_URL` 环境变量接入。

于是：

- **真的**：事件行的信封形态与字段、工具调用的落地方式（hello.txt 真的被写、node -v 真的被执行）、
  权限拒绝的表现（default 模式 + `permission_denials` 结构化清单）、会话恢复（resume 后
  session_id 复用）、退出码、强杀后的截断形态。这些全部出自 qwen 本体。
- **假的**：模型说了什么。回话内容由脚本决定（write_file → run_shell_command → 文本收尾），
  同样的脚本永远录出同样的流。
- **未覆盖**：真实 Qwen/ModelStudio 后端特有的字段——thinking 块形状、`stop_reason` 的实际
  取值域、非零 `cache_read_input_tokens`、`result.stats` 完整结构。用户提供 DASHSCOPE_API_KEY /
  Coding Plan key 后可补录，命令见文末。

`real-stream-json-auth-missing.jsonl` 是全真录制（不给任何 auth 配置，CLI 自身的拒绝）。

## 文件清单

| 文件 | 内容 | 录制方式 |
|---|---|---|
| `real-stream-json-success.jsonl` | 完整成功流（24 行）：`system`(init) → `stream_event`(goal_state) → 三组 message_start/content_block_*/assistant/message_stop（write_file → run_shell_command → 文本增量两片）→ `user`(tool_result) ×2 → `result`(success)。退出码 **0**，hello.txt 真落地 | `--approval-mode yolo --include-partial-messages --safe-mode --session-id 2d2a0f7e-…` |
| `real-stream-json-resume.jsonl` | `--resume 2d2a0f7e-…` 恢复（10 行）：init 行 `session_id`/`uuid` 与 success **完全一致**（不新开会话），文本轮正常收尾 | 同上，脚本只有一句文本 |
| `real-stream-json-headless-deny.jsonl` | **`--approval-mode default`**（24 行）：write_file 与 run_shell_command 均 `tool_result` `is_error:true` +「Qwen Code requires permission to use "…", but that permission was declined. Matching deny rule: "…".」，文件未落地，**`result.permission_denials` 结构化列出两次被拒**，而 `subtype:"success"`、`is_error:false`、**退出码 0**（权限拒绝伪装成功，调研 §8 坑 2） | 同 success 的脚本 |
| `real-stream-json-api-error.jsonl` | 假服务端回 **HTTP 401**（9 行）：错误升格为 assistant 文本 `[API Error: 401 Incorrect API key provided…]` → `result` `subtype:"success"`、`is_error:false`、**退出码 0**（API 错误伪装成功，调研 §8 坑 1——gemini 至少透传状态码为退出码，qwen 连这个信号都没有） | fake-server error401 模式 |
| `real-stream-json-killed.jsonl` | 轮次进行中（模型端拖住不回）`taskkill /T /F` 强杀（2 行）：只剩 init + goal_state，**无 result 无终止事件**；会话文件已落、该 ID 可 `--resume`（调研 §4 实测） | fake-server delay 模式，10 秒后强杀 |
| `real-stream-json-auth-missing.jsonl` | 不给任何 auth 配置（1 行）：单行 `result` `subtype:"error_during_execution"`、`is_error:true`、error.message「No auth type is selected…」，退出码 **1** | **全真**（无假服务端参与） |

## 脱敏说明

- 用户名 `admin` → `USER`（含 JSON 转义路径 `C:\\Users\\USER\\…`）。
- deny 流的录制目录名 `ffpane-qwen-rec2` 归一为 `ffpane-qwen-rec`（同一次录制会话的
  平行目录，避免 cwd 串档干扰断言）。
- `session_id` 为录制时经 `--session-id` 显式指定的样例 UUID（非随机、不含账号信息），
  保留原值——success ↔ resume 两份文件的 session_id 一致性可被测试断言。
- CRLF 归一为 LF。除上述替换外未做任何增删改；每行均为 CLI 原样输出的合法 JSON。

## 复现录制

```bash
# 1) 起假模型服务端（fixtures/tools/fake-openai-server.mjs 或其 error401/delay 变体）
node packages/adapters/fixtures/tools/fake-openai-server.mjs --port 18182 --script <脚本.json>

# 2) 提示词经 stdin 管道；密钥经环境变量（cmd 重定向保证 stdout 原始字节，
#    PowerShell 的 > 会写成 UTF-16，录 fixture 不可用）
set OPENAI_API_KEY=fixture-key
set OPENAI_BASE_URL=http://127.0.0.1:18182/v1
qwen -o stream-json --include-partial-messages --approval-mode yolo --safe-mode ^
  --auth-type openai --session-id <uuid> -m fixture-model < prompt.txt 1> out.jsonl
```

补录真实 Qwen 后端的前置条件（用户介入项）：提供 `DASHSCOPE_API_KEY`（ModelStudio）或
Coding Plan key 后，`OPENAI_BASE_URL` 指向官方端点重跑上面第 2 步。届时应重点核对：
thinking 块的 stream_event 形状、`stop_reason` 取值、`result.stats` 是否出现。

## 注意

- stderr 不在 fixture 内：qwen 的 stderr 很干净（正常轮次只有一行 yolo 无沙箱警告），
  适配器只解析 stdout，stderr 尾部并入 end 诊断。
- Windows 上进程退出阶段偶发 libuv 断言崩溃（0xC0000409，调研 §8 坑 3）——发生在 result
  已完整落出之后，不影响任何 fixture 的内容；`real-stream-json-success.jsonl` 录制时该崩溃
  未发生（EXIT=0），发生时事件流字节相同、仅退出码不同。
