# Codex CLI fixtures（真机录制）

- **CLI 版本：** codex-cli 0.147.0
- **录制日期：** 2026-08-29
- **录制环境：** Windows 11 + PowerShell，登录方式为 ChatGPT 订阅（`auth_mode` = ChatGPT）
- **录制目录：** `%TEMP%\ffpane-codex-probe`（系统临时目录，非本仓库）
- **性质：** 全部为真实录制的 stdout JSONL 事件流（`codex exec --json`），非文档构造

## 文件清单

| 文件 | 内容 | 录制命令（在临时目录内执行） |
|---|---|---|
| `exec-basic.jsonl` | 成功的完整流：`thread.started` → `agent_message` → `file_change`(add, completed) → `command_execution`(失败一次后重试成功) → `agent_message` → `turn.completed` | `codex exec --json --skip-git-repo-check -C . --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="low" "Create a file named hello.txt containing exactly 'hello'. Then briefly say what you did."` |
| `exec-resume.jsonl` | 原生会话恢复：`thread.started` 返回与首次运行**相同的 thread_id**；模型未执行任何命令即答出文件内容，证明上下文已恢复 | `codex exec resume 01a04cc1-c42a-7f40-b237-6f384b9e6f17 --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="low" "What is in hello.txt? Answer in one short sentence."` |
| `exec-sandbox-error-win.jsonl` | **Windows 沙箱失败样例**：`-s workspace-write` 在 %TEMP% 目录下报 `windows sandbox: helper_unknown_error: apply deny-read ACLs`，`file_change` status=failed、`command_execution` exit_code=-1 status=failed，但 turn 仍以 `turn.completed` 正常收尾（任务失败由 agent_message 口头报告） | `codex exec --json --skip-git-repo-check -C . -s workspace-write -c model_reasoning_effort="low" "Create a file named hello.txt containing exactly 'hello'. Then briefly say what you did."` |
| `exec-killed.jsonl` | 中途 `taskkill /PID <pid> /T /F` 强杀进程树后的截断流：**没有任何终止事件**，流停在 `turn.started` | 同 basic，6 秒后强杀 |
| `exec-resume-after-kill.jsonl` | 被强杀的会话仍可 resume：同一 thread_id 恢复成功并正常完成 | `codex exec resume 01a04cc3-df38-73c0-a180-31b55eecd76d --json ... "Stop counting. Just say 'resumed ok'."` |
| `exec-error-auth.jsonl` | 未登录（空 CODEX_HOME）时的错误流：非致命 `error` 事件重试多次 → `item.completed`(type=error) → `turn.failed`；进程退出码 1 | `codex exec --json --skip-git-repo-check -C . "hi"`（CODEX_HOME 指向无 auth.json 的空目录） |

## 脱敏说明

- 用户目录 `C:\Users\<真实用户名>` → `C:\Users\USER`（JSON 转义形式 `C:\\Users\\USER`）。
- `exec-error-auth.jsonl` 中 Cloudflare `cf-ray` 值与 OpenAI `request id` 值 → `REDACTED` / `req_REDACTED`。
- `thread_id`（UUIDv7，随机生成、不含账号信息）**保留原值**，以保证 basic ↔ resume、killed ↔ resume-after-kill 两组文件间 thread_id 一致性可被测试断言。
- `exec-basic.jsonl` 中 `aggregated_output` 含中文 PowerShell 错误文本，为真实输出、有意保留（体现 Windows 中文环境下命令输出含本地化文本的现实）。
- 除上述替换外未做任何增删改；每行均为 CLI 原样输出的合法 JSON。

## 注意

- stderr 不在 fixture 内：Codex 的日志（`ERROR codex_core::...` 等）走 stderr，stdout 仅有 JSONL 事件，两者天然分离。
- 录制时为绕过 Windows 沙箱缺陷使用了 `--dangerously-bypass-approvals-and-sandbox`，事件结构与带沙箱运行完全一致（对照 `exec-sandbox-error-win.jsonl`）。
