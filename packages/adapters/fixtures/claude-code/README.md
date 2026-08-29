# Claude Code headless 事件流 fixtures

**性质:真机录制**(非文档构造)。
**CLI 版本:** Claude Code 2.1.220(npm 安装,`claude.exe`)
**录制日期:** 2026-08-29
**录制环境:** Windows 11 + PowerShell;认证方式 OAuth 订阅登录(`claude auth status` → `authMethod: "oauth_token"`)
**模型:** `--model haiku`(实际解析为 `claude-haiku-4-5-20251001`)
**录制目录:** 系统临时目录(`%TEMP%\ffpane-cc-rec\{a,b,c}`),与本仓库完全隔离

## 脱敏说明

- 用户主目录 `C:\Users\<真实用户名>` → `C:\Users\USER`(含 JSON 转义形式 `C:\\Users\\USER`)
- 会话存储目录编码 `C--Users-<真实用户名>` → `C--Users-USER`
- 未发现账号邮箱 / 组织 ID 出现在任何事件中(`system/init` 不含账号信息)
- **未做改动的部分:** `system/init` 中的 `slash_commands` / `skills` / `agents` 列表反映录制机器的用户级配置(全局技能、插件),不含敏感信息但非纯净环境——这本身佐证了"headless 运行会继承用户全局配置"的坑(见调研文档 §8)
- `thinking` 块的 `signature` 字段为 API 返回的加密签名 blob,非用户数据,原样保留

## 文件清单与录制命令

所有命令均以 `cmd /c 'claude ... > 输出文件 2> stderr文件'` 方式录制原始 stdout。

| 文件 | 场景 | 命令要点 |
|---|---|---|
| `01-basic-write-bash.jsonl` | 完整最小任务:Write 建文件 + Bash 打印 + 文本总结 | `claude -p "Create a file hello.txt with content exactly hello. Then run a shell command to print the file contents. Finally reply with one short sentence describing what you did." --output-format stream-json --verbose --model haiku --allowedTools "Write" "Bash" --max-turns 8` |
| `02-resume-edit.jsonl` | 原生会话恢复 + Edit 工具(含 structuredPatch diff) | `claude -p --resume <01的session_id> "Use the Edit tool to change the content of hello.txt from hello to hello world. Then reply with one short sentence." --output-format stream-json --verbose --model haiku --allowedTools "Edit" --max-turns 6` |
| `03-permission-denied.jsonl` | 默认权限模式下工具被自动拒绝(`result.permission_denials`) | `claude -p "Create a file test.txt with content abc using the Write tool." --output-format stream-json --verbose --model haiku --max-turns 4`(无 allowedTools) |
| `04-permission-stdio.jsonl` | **权限请求转发**:`--permission-prompt-tool stdio` 发出 `control_request/can_use_tool`,外部程序回 allow 后继续执行 | `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --permission-prompt-tool stdio --max-turns 4`,stdin 喂 user 消息(见 `.client-input` 文件) |
| `04-permission-stdio.client-input.jsonl` | 上一场景中外部程序写入 stdin 的两行(user 消息 + allow 应答) | — |
| `05-interrupt.jsonl` | **优雅取消**:Bash `sleep 60` 执行中,stdin 发 `control_request/interrupt` → CLI 回执 → `result.terminal_reason: "aborted_tools"`,退出码 1 | `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --allowedTools Bash --max-turns 4`,工具启动 3 秒后经 stdin 发送 interrupt(见 `.client-input`) |
| `05-interrupt.client-input.jsonl` | 上一场景 stdin 输入(user 消息 + interrupt 请求) | — |
| `06-partial-messages.jsonl` | 流式增量:`stream_event` 包裹 API 原生 SSE 事件(content_block_delta 等) | `claude -p "Reply with exactly this sentence: Streaming test OK." --output-format stream-json --include-partial-messages --verbose --model haiku --max-turns 1` |
| `07-hardkill-truncated.jsonl` | 硬杀进程树:`taskkill /T /F` 后 stdout 截断,**无 result 事件**(且 msys 孙进程 sleep.exe 存活为孤儿) | 同 01 类似命令但任务为 `sleep 60`,20 秒后 taskkill |
| `08-max-turns-exceeded.jsonl` | 轮次超限:`result.subtype: "error_max_turns"`,退出码 1 | 同 01 类似命令但 `--max-turns 1` |
| `09-resume-wrong-cwd.jsonl` | **跨 cwd resume 失败**:第一行是非 JSON 纯文本报错,随后才是 error result——解析器必须容忍脏行 | 在目录 b 中 `claude -p --resume <目录a的session_id> ...` |

## 用于回放测试的关键断言点

- `01`:`system/init` → 两组 `assistant`(thinking + tool_use 各占一行,同一 `message.id`)→ `user`(tool_result + 顶层 `tool_use_result` 结构化数据)→ … → `result/success`
- `02`:init 的 `session_id` 与 01 相同;Edit 的 `tool_use_result.structuredPatch` 为标准 diff hunk
- `04`:`control_request.request.subtype === "can_use_tool"`,含 `tool_name/input/permission_suggestions/tool_use_id`
- `05`:interrupt 后有 `control_response`(`still_queued: []`)、被拒工具的 `tool_result_meta[].non_execution_kind === "user-rejected"`、`result.terminal_reason === "aborted_tools"`
- `07`:流以 `system/task_started` 戛然而止,无 result 行(适配器需处理此形态)
- `09`:首行 `JSON.parse` 必然失败(容错路径测试)
