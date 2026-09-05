# iFlow CLI fixtures（真机录制，模型端为本地假服务）

- **CLI 版本：** @iflow-ai/iflow-cli **0.5.19**（npm 全局安装，`%APPDATA%\npm\iflow.ps1` / `.cmd` 垫片 → `bundle/entry.js`）
- **录制日期：** 2026-09-05
- **录制环境：** Windows 10 + PowerShell/cmd，Node v24.15.0
- **录制目录：** `%TEMP%\ffpane-iflow-probe\work`（系统临时目录，非本仓库）
- **调研文档：** `docs/adapters/iflow.md`

## 性质说明：什么是真的，什么是假的

本机无 iFlow 账号（未 OAuth 登录、无 IFLOW_API_KEY）。为录到成功/审批/取消路径，用
`packages/adapters/fixtures/tools/fake-openai-server.mjs`（T7.3 已入仓的录音棚脚本）起了
本地 OpenAI 兼容服务端，经 iFlow 的 **openai-compatible** 认证类型接入——iFlow 原生后端
`https://apis.iflow.cn/v1` 本身就说 OpenAI 兼容协议（chat/completions），换端点即换模型，
协议这一环没有被替换。接入方式是在**录制目录**放一份 workspace 级 `.iflow/settings.json`
（用户的 `~/.iflow` 分毫未动）：

```json
{
  "selectedAuthType": "openai-compatible",
  "apiKey": "fixture-key",
  "baseUrl": "http://127.0.0.1:8182/v1",
  "modelName": "ffpane-fixture-model"
}
```

于是：

- **真的**：CLI 的 stdout/stderr 形态、Execution Info 块、工具落地（文件真的被写、命令真的被执行）、
  会话落盘与 `-r` 恢复、ACP wire 的每一行（事件名、字段、权限往返、取消语义）、退出码。
- **假的**：模型说了什么。回话由脚本决定，同样的脚本永远录出同样的流。
- **未覆盖**：iFlow 真实后端特有行为——OAuth 登录流、真实模型的 thinking 块、
  API 配额/限流错误形态、`glm-*`/`qwen3-*` 等真实模型名下的 Execution Info。均标注「待真机/待凭据」。

`real-headless-noauth.stderr.txt`、`real-acp-noauth.wire.jsonl`、`real-version.txt`、
`real-help.txt` 是全真录制（不依赖假服务端）。

## 文件清单

### headless（`iflow -p`，非交互）

| 文件 | 内容 | 录制方式 |
|---|---|---|
| `real-headless-success.stdout.txt` | 成功流 stdout：3 行 "does not support thinking mode" 噪音 + 最终文本。**没有任何 JSON 事件流**（0.5.19 无 stream-json，这是与 gemini-cli 0.5x 最大的差异） | 假模型脚本：write_file → run_shell_command → 文本收尾；`--yolo`；退出码 **0** |
| `real-headless-success.stderr.txt` | 同轮 stderr：`<Execution Info>` JSON 块（session-id / conversation-id / assistantRounds / tokenUsage）。**Execution Info 在 stderr 不在 stdout** | 同上 |
| `real-headless-success.execinfo.json` | `--output-file` 写出的执行信息（与 stderr 的 Execution Info 同构） | 同上 |
| `real-headless-plan-deny.stdout.txt` | `--plan` 模式下模型试图 write_file：stdout 只有噪音行 + 模型收尾文本，文件未落地 | 假模型脚本：write_file → 文本；退出码 **0** |
| `real-headless-plan-deny.stderr.txt` | 同轮 stderr：`Error executing tool write_file: Tool "write_file" not found in registry.` + Execution Info。**拒绝形态是"工具不在注册表"而非"权限拒绝"**（plan/default 从注册表移除写工具） | 同上 |
| `real-headless-resume.stdout.txt` | `-r <sessionId> -p` 恢复轮 stdout | 假模型脚本一句话 |
| `real-headless-resume.stderr.txt` | 同轮 stderr：`Resuming session <id> (6 messages loaded)` + Execution Info（session-id 与首轮一致）。恢复请求向模型回填了首轮全部上下文（含 2 次工具调用与结果，dump 实证） | 同上 |
| `real-headless-noauth.stderr.txt` | 未认证 `iflow -p "Say hello"`：stderr 单行提示（stdout 空），退出码 **1**。注意文案中的 `apiKey/baseUrl/modelName` 环境变量提示**有误导**——实际必须带 `IFLOW_` 前缀（源码 `CT()` 函数，见调研 §5.3） | **全真** |
| `real-killed.stdout.txt` | 轮次进行中（等模型响应）`taskkill /T /F` 强杀：stdout 只有噪音行，无任何终止事件，stderr 空。会话文件已含用户输入行，可 `-r` 续 | 假模型 120s 不应答，8s 后强杀 |
| `real-version.txt` | `iflow --version` → `0.5.19`。注意退出时曾观测到 libuv assertion 崩溃（退出码 -1073740791），版本号本身已正常输出 | **全真** |
| `real-help.txt` | `iflow --help` 完整参数面。核对要点：**没有 `-o/--output-format`**（`-o` 是 `--output-file`）；审批模式是 4 个布尔旗（`--yolo/--default/--plan/--autoEdit`）；有 `--experimental-acp` | **全真** |
| `real-session-storage.jsonl` | 原生会话文件原文：`$IFLOW_HOME/projects/<编码后cwd>/session-<uuid>.jsonl`，Claude Code 风格的 JSONL（uuid/parentUuid/sessionId/type/message），工具调用与结果全在 | 成功流那一轮的落盘 |

### ACP（`iflow --experimental-acp`，JSON-RPC over stdio）

wire 文件格式：`>>> ` 前缀 = 客户端（FF-pane 侧）发出，`<<< ` 前缀 = iflow 发回，其余为 CLI 的非 JSON banner 行。

| 文件 | 内容 | 录制方式 |
|---|---|---|
| `real-acp-success.wire.jsonl` | initialize → session/new（回 sessionId + modes：**默认 currentModeId 是 yolo**）→ prompt → `tool_call`/`tool_call_update`（write_file 带 `content[].type:"diff"` 的 oldText/newText **和** `fileDiff` 统一 diff 文本；run_shell_command 带命令输出文本）→ `agent_message_chunk` → 响应 `stopReason:"end_turn"` | 假模型：write → shell → 文本 |
| `real-acp-permission-allow.wire.jsonl` | session/set_mode 切 `default` 后 prompt：iflow 发 **`session/request_permission`**（options：proceed_always/proceed_once/cancel，toolCall 带 diff 预览），客户端回 proceed_once → 工具执行 → end_turn。**权限请求转发在 ACP 模式真实成立** | 假模型：write → 文本 |
| `real-acp-permission-reject.wire.jsonl` | 同上但客户端回 cancel（reject_once）：文件未落地，**没有后续 tool_call 事件**（拒绝即静默吞掉该工具），prompt 正常 `end_turn` 收尾 | 同上 |
| `real-acp-cancel.wire.jsonl` | prompt 进行中（模型 120s 不应答）客户端发 `session/cancel` 通知：prompt 响应 `stopReason:"cancelled"`，协议级优雅取消成立 | 假模型拖住不回 |
| `real-acp-load.wire.jsonl` | `session/load` 加载 **headless 轮建的会话 ID**：成功返回同 sessionId——ACP 与 headless 读写同一份会话存储，两模式互通 | 复用 headless 成功流会话 |
| `real-acp-noauth.wire.jsonl` | 无认证（干净 IFLOW_HOME + 无 workspace settings）：initialize 正常（`isAuthenticated:false`，authMethods 三项：oauth-iflow / iflow(API key) / openai-compatible），session/new 回 **`-32000 Authentication required`** | **全真** |

## 脱敏说明

- `C:\Users\admin` → `C:\Users\USER`（含 JSON 转义与正斜杠形态）。
- 临时数据目录名 `ffpane-iflow-home` → `IFLOW_HOME`。
- CRLF → LF；`real-help.txt` 去除了 PowerShell 重定向引入的 BOM。
- `session-id` / `conversation-id` / ACP `sessionId` 为随机 UUID、不含账号信息，**保留原值**——
  `real-headless-success` ↔ `real-headless-resume` ↔ `real-acp-load` 三份的 sessionId 一致性可被测试断言
  （`session-e06bbd16-...`）。
- 除上述替换外未做任何增删改。

## 复现录制

```powershell
# 1) 起假模型服务端（脚本条目：write_file → run_shell_command → 文本）
node packages/adapters/fixtures/tools/fake-openai-server.mjs --port 8182 --script <脚本.json>

# 2) 录制目录放 workspace 级认证（不动用户 ~/.iflow）
#    <录制目录>\.iflow\settings.json ← 本 README 上文的 openai-compatible 配置

# 3) headless 一轮（IFLOW_HOME 重定向会话/日志落盘，用户目录不受影响）
cmd /c "set IFLOW_HOME=<临时目录>&& iflow -p ""Create hello.txt with content hello, run node -v, then summarize."" --yolo --output-file execinfo.json 1>stdout.txt 2>stderr.txt"

# 4) ACP 路径：node <探针脚本> 驱动 initialize → session/new → session/set_mode → prompt，
#    权限请求按 optionId 回选（探针脚本形态见调研文档 §8.5，实现单建议做成 scripts/live-iflow.mjs）
```

补录真实 iFlow 后端的前置条件（用户介入项）：`iflow` 交互式登录（OAuth）或设置
`IFLOW_API_KEY`（注意必须是 `IFLOW_` 前缀），去掉 workspace settings 与假服务端重跑上述步骤。
届时应重点核对：真实模型的 thinking 输出走不走 stdout、Execution Info 的 tokenUsage 是否分字段、
ACP `agent_thought_chunk` 是否出现。

## 注意

- **headless 的 stdout 没有结构化事件**：模型文本与「thinking mode 不支持」噪音混排；
  工具错误、Resuming 提示、Execution Info 全走 stderr。0.5.19 不存在 gemini-cli 的
  `-o stream-json`，**结构化事件只能走 ACP 路径**（这是适配器选路的决定性事实）。
- headless 的 `--default`（乃至缺省）在非交互下与 `--plan` 同形：写工具被**从注册表移除**，
  模型看不到工具（`Tool "..." not found in registry`），但退出码仍是 0——「拒绝伪装成功」
  在 iFlow 上的形态。非交互缺省审批模式实测为 yolo（`-p` 触发，源码 `n.prompt&&...?dn.YOLO`），
  但这是**隐式行为**，适配器必须显式传 `--yolo`。
