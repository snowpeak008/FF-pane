# Qwen Code 接入调研（T8.6a）

- **调研日期：** 2026-09-05
- **CLI 版本：** @qwen-code/qwen-code **0.23.0**（调研当日 npm latest，本次全局安装）
- **调研环境：** Windows 10 + PowerShell，Node v24
- **信息来源：** ① 本机真机运行（成功流 / 权限拒绝 / API 错误 / 强杀 / resume，全部实测——模型端为本地假
  OpenAI 兼容服务端，见 fixtures README）；② 0.23.0 安装包自带官方文档（`bundled/qc-helper/docs/`，
  与安装版本严格同版）；③ 安装包 JS 源码（`chunks/*.js` 的输出适配器与权限控制器代码）。
- **认证限制声明：** 本机无任何 Qwen/ModelStudio 凭据。**Qwen OAuth 免费层已于 2026-04-15 废止**
  （0.23.0 官方文档 auth.md 明示，`/auth` 菜单已移除该入口），故「真实 Qwen 后端」路径待用户提供
  API key 后补验；**CLI 侧行为全部真机实测**（openai 兼容 auth-type + 本地假服务端，CLI 本体全真）。

---

## 0. 与 Gemini CLI 的关系（本次调研的首要问题）

Qwen Code 是 Gemini CLI 的 fork（官方 README 自述），交互层、审批模式词汇、会话目录设计
处处可见血缘。**但 headless 输出协议已完全重写，与 gemini-cli 不是同款**：

| 维度 | Gemini CLI 0.57.0 | Qwen Code 0.23.0 |
|---|---|---|
| stream-json 事件形态 | 六类**扁平**事件（`init`/`message`/`tool_use`/`tool_result`/`error`/`result`，字段在顶层） | **Claude Code 风格信封**：`system`(subtype=init) / `assistant`（`message.content` 含 text/tool_use 块）/ `user`（`message.content` 含 tool_result 块）/ `stream_event` / `result`（subtype + is_error + `permission_denials`） |
| 提示词参数 | `-p` 现役 | `-p` **已弃用**（帮助明示将移除），改 positional 或 stdin |
| 信任目录 | 必传 `--skip-trust`（否则退出 55） | **无该参数**；folderTrust 默认关闭，新目录直接可跑（真机实测） |
| 审批模式 | `default`/`auto_edit`/`yolo`/`plan` | `plan`/`default`/`auto-edit`/`auto`/`yolo`（**连字符不同**，且多一个 LLM 分类器 `auto` 档） |
| 退出码 | API 错误的 HTTP 状态码直接成为退出码（真机 400） | **API 错误不影响退出码**——升格为 assistant 文本 + result(success)，退出 0（真机实测，§8 坑 1） |
| 认证 | GEMINI_API_KEY / OAuth / Vertex | `--auth-type` 五选一（openai/anthropic/qwen-oauth/gemini/vertex-ai）；qwen-oauth 已废止；主路径 **openai 兼容**（OPENAI_API_KEY/OPENAI_BASE_URL） |
| 权限转发通道 | 无（headless）；ACP 模式才有 | `control_request(can_use_tool)` 通道**存在**但只归 `--input-format stream-json` 双向 SDK 模式与 Dual Output 侧车（§3.4，单发 headless 不可用） |

**结论：参数化派生自 gemini-cli 适配器无从谈起（协议不同款）；与 claude-code 适配器信封同构但
工具语义层不同（§9 两案对比）。**

## 1. 安装方式与当前版本

```powershell
npm install -g @qwen-code/qwen-code   # 官方包名，已核实
qwen --version                        # → 0.23.0
```

- 入口 `qwen`（Windows 下为 `%APPDATA%\npm\qwen.ps1` / `.cmd` 包装——**npm 垫片**，
  多行位置参数会被 cmd.exe 截断，codex 同款坑，§8 坑 5）。
- 自带原生依赖 `@lydell/node-pty`、`sharp`（预编译）。
- 本机安装注记：npmjs 官方源 CDN 下载两次卡死（进程 CPU 零推进，registry ping 正常），
  换 `--registry=https://registry.npmmirror.com` 7 秒完成——纯本机网络问题，包本身无异常。

## 2. headless / 非交互模式参数

触发条件：positional query、stdin 为非 TTY 管道、或已弃用的 `-p`。**stdin 内容在前、
positional/-p 文本追加在后**（帮助原文 "Appended to input on stdin"）。纯 stdin（无 positional）
也进 headless（真机实测）。

| 参数 | 说明 | 适配器相关性 |
|---|---|---|
| `[query..]`（positional） | 任务文本 | 不用——经 npm .cmd 垫片多行截断（§8 坑 5），**提示词一律走 stdin** |
| `-o, --output-format <fmt>` | `text`（默认）/ `json` / `stream-json` | **核心**，适配器用 `stream-json` |
| `--include-partial-messages` | stream-json 下追加 `stream_event` 增量（message_start / content_block_delta / …） | **核心**：token 级流式的唯一来源（不开则 assistant 文本整块到达） |
| `--approval-mode <mode>` | `plan` / `default` / `auto-edit` / `auto` / `yolo` | **核心**。headless 下 `default` 拒绝一切写与命令（§3.4），Worker 必须 `yolo`；Planner/Reviewer 用 `plan` |
| `-y, --yolo` | 等价 `--approval-mode yolo` | 不用（显式模式参数更可读） |
| `--auth-type <type>` | `openai` / `anthropic` / `qwen-oauth` / `gemini` / `vertex-ai` | **必传**。headless 下无 auth type 直接 `error_during_execution` 退出 1（真机实测）；qwen-oauth 已废止 |
| `--openai-api-key` / `--openai-base-url` | openai 兼容凭据 | **不用命令行传**（密钥进命令行违反 §4.3 红线）——同名环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 等效（真机实测） |
| `-m, --model <name>` | 模型 ID | 映射 Profile 模型；缺席时 CLI 读 `OPENAI_MODEL`/settings |
| `--resume <id>` | 恢复指定会话（UUID），可与提示词组合 | **核心**，原生恢复；ID 不存在退出 1（stderr "No saved session found"） |
| `-c, --continue` | 续接当前目录最近会话 | 不用（语义比 ID 模糊） |
| `--session-id <uuid>` | 新会话用调用方指定的 UUID | **推荐**：FF-pane 生成 UUID 自己登记；**与 `--resume`/`--continue` 互斥**（CLI 强制，真机实测报错退出 1） |
| `--max-session-turns <n>` | 轮数上限，超限退出 53 | 成本护栏 |
| `--max-wall-time` / `--max-tool-calls` | 运行预算，超限退出 55 | 成本护栏（可选） |
| `--include-directories <dirs>` | 工作区追加目录 | 可映射任务的额外可读路径 |
| `--safe-mode` | 禁一切自定义（hooks/extensions/skills/MCP/记忆） | **建议常开**：受管执行不该被用户仓库里的 hooks/extensions 注入行为（`--yolo`/`--approval-mode` 不受其影响，官方文档明示） |
| `--input-format stream-json` | stdin 双向 JSON 协议（SDK 模式） | **本单不用**：官方文档明示 "under construction, intended for SDK integration"（§3.4 权限转发依赖它，如实登记为将来路径） |
| `--acp` | ACP 模式（JSON-RPC over stdio） | M3 预留位（血缘同 gemini `--acp`） |
| `--json-fd` / `--json-file` | Dual Output 侧车（TUI + JSON 双输出） | 不用（headless 下 stream-json 已够） |
| `--sandbox` | 容器沙箱（Docker/Podman） | 不启用（依赖重；权限由 FF-pane 层负责） |
| `--mcp-config <json\|path>` | **逐轮 MCP 注入**（JSON 字符串或文件路径） | 高价值预留：形状与 claude 的 `--mcp-config` 相似，注入语义本单未实测（§10 待验） |
| 环境变量 `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` | 抑制 yolo 无沙箱的 stderr 警告行 | 不设（stderr 本就只留档不解析） |

**退出码**（0.23.0 官方 troubleshooting.md + 源码 `FatalError` 类族 + 真机复核）：

| 码 | 含义 | 来源 |
|---|---|---|
| 0 | 成功——**含「API 错误升格文本」与「全部工具被拒」两种伪装形态**（§8 坑 1/2） | 真机实测 |
| 1 | 一般错误（auth 未配置 / resume ID 不存在 / FatalError 缺省码） | 真机实测 |
| 42 | FatalInputError（非法输入，仅非交互模式） | 官方文档 + 源码 `super(message, 42)` |
| 44 | FatalSandboxError | 同上 |
| 52 | FatalConfigError（settings.json 非法） | 同上 |
| 53 | FatalTurnLimitedError（超 `--max-session-turns`） | 同上 |
| 55 | FatalBudgetExceededError（超 `--max-wall-time`/`--max-tool-calls`） | 源码 `super(message, 55)` |
| 130 | FatalCancellationError（SIGINT） | 源码 `super(message, 130)` |
| 0xC0000409 (−1073740791) | **Windows 退出期 libuv 断言崩溃**（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）——stdout 流已完整（result 已到）之后才崩，非确定性复现（本机 6 跑 3 现） | 真机实测（§8 坑 3） |

注意：官方文档退出码表列有 41（FatalAuthenticationError），但 0.23.0 源码的 FatalError 类族中
**已无该类**（grep 全部 chunks 零命中）——auth 缺失走 result(error_during_execution) + 退出 1
（真机实测）。文档滞后于实现，适配器按实测语义处理。

## 3. 事件 / 输出格式

### 3.1 `-o json`（数组，进程结束时一次性输出）

消息对象数组：`system`(session_start) + `assistant` + `result`。丢失过程时序，不适合 Worker。
本单不消费（错误路径样例：无 auth 时**只有一个 result 错误对象的数组**，真机录制
`real-json-auth-missing.json`）。

### 3.2 `-o stream-json`（JSONL，stdout 逐行）——适配器主用

每行一个带 `type` 的信封对象，全部含 `uuid` + `session_id`（Claude Code 风格）：

| type | 时机 | 关键载荷 |
|---|---|---|
| `system` (subtype=`init`) | 首行 | `session_id`、`cwd`、`model`、`permission_mode`、`tools[]`（**当前模式下实际注册的工具清单**——default 模式下 write_file/edit/run_shell_command 直接不在清单里）、`qwen_code_version` |
| `stream_event` | 过程事件 | `event.type`：`goal_state`（恒出现一条，Goal 机制的状态投影）；开 `--include-partial-messages` 后另有 `message_start` / `content_block_start` / `content_block_delta`（`delta.text` 为 **token 级真增量**，真机实测一句话切两片）/ `content_block_stop` / `message_stop` |
| `assistant` | 每条模型消息 | `message.content[]` 块数组：`{type:"text",text}` 或 `{type:"tool_use",id,name,input}`；`message.usage`（本条消息的 token）；`parent_tool_use_id`（子 Agent 归属，主流程为 null） |
| `user` | 工具结果回填 | `message.content[]` 含 `{type:"tool_result",tool_use_id,is_error,content}`——**content 是人类可读文本**（成功如 "Successfully created and wrote to new file: …"、命令输出原文；拒绝见 §3.4） |
| `result` | 末行 | `subtype`（`success` / `error_during_execution` / `error_max_turns` 语义族）、`is_error`、`result`（最终文本）、`usage`（全轮汇总）、`num_turns`、`duration_ms`、**`permission_denials[]`**（被拒工具的结构化清单：tool_name/tool_use_id/tool_input） |

**文件修改如何体现：**

- `assistant` 行 `tool_use` 块：`name` = `write_file`（input：`file_path`, `content`）或 `edit`
  （input：`file_path`, `old_string`, `new_string`）或 `notebook_edit`。**路径与参数结构化可靠**
  （工具名与参数键沿用 gemini 血缘）。
- `user` 行 `tool_result`：**纯文本**（"Successfully created and wrote to new file: …"），
  **无 diff 正文**（gemini 的 tool_result.output 是统一 diff 文本，qwen 的 headless 投影丢掉了这层）。
  diff 只能从 edit 的 old_string/new_string 参数渲染；write_file 覆盖已有文件时旧内容不可得——
  **不自造 diff**（events/types.ts 约定），fileChangeEvents 如实报 partial。

**命令执行如何体现：**

- `tool_use` 块：`name` = `run_shell_command`，input：`command`, `description`, `dir_path?`。
- `tool_result.content`：命令输出文本（真机 "v24.15.0"）。**无结构化退出码字段**（同 gemini）。

### 3.3 stderr（不解析，只留存）

比 gemini 干净得多：正常轮次只有一行 yolo 无沙箱警告（可 `QWEN_CODE_SUPPRESS_YOLO_WARNING=1`
抑制）；错误路径有 "No saved session found …" 等人类可读消息；退出期崩溃（§8 坑 3）留一行断言。
适配器只解析 stdout，stderr 尾部并入 end.message 诊断（claude 款式）。

### 3.4 审批与权限（headless 的关键行为，真机实测）

- `--approval-mode default` 下：**需审批的工具从 init.tools 清单里直接消失**（write_file/edit/
  run_shell_command 不注册），模型硬发调用则 `tool_result` `is_error:true` +
  「Qwen Code requires permission to use "write_file", but that permission was declined.
  Matching deny rule: "edit".」，**且 result 行的 `permission_denials[]` 结构化列出全部被拒调用**
  ——这一点比 gemini 的文本判据可靠（结构化字段，不怕措辞漂移）。
- **进程照样退出 0、result subtype 照样 success、is_error 照样 false**——「权限拒绝伪装成功」
  四家调研共同结论在 qwen 上的形态与 claude 完全一致（denials 非空 + 表面成功）。
- 拒绝消息的三种源码字面量（`chunk-4F7GQGXB.js`）：
  `requires permission to use "X", but that permission was declined.`（+ 可选
  ` Matching deny rule: "Y".` 后缀）/ `…declined (non-interactive mode cannot prompt for
  confirmation).` / `"X" is not listed in the active core tools allowlist…`。
  **判据以 result.permission_denials 为准**，文本仅留档。
- **权限转发通道存在但本单不可用**：`control_request`(subtype=`can_use_tool`) ↔
  `control_response` 闭环在源码中完整存在（`PermissionController.handleOutgoingPermissionRequest`），
  但源码明确分流：`inputFormat !== "stream-json"` 时**不发请求、按本地审批模式立即裁决**
  ——即它只归 `--input-format stream-json` 双向 SDK 模式（官方文档标注 under construction）
  与 Dual Output 侧车（TUI 伴随模式）。单发 headless（本适配器形态）**无权限转发**，
  permissionForwarding 如实报 no；将来路径见 §10。

## 4. 原生会话：保存与恢复

- **自动保存**：每轮落 `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`
  （cwd 变形如 `c--users-admin-appdata-local-temp-xxx`，真机核实）。默认开启
  （`--chat-recording false` 可关，关了 resume 失效——不动它）。
- **按 cwd 隔离**：resume 绑定工作目录。跨目录 resume 真机实测：
  「No saved session found with ID …」退出 1——**launch 前 cwd 校验快速失败**（gemini 款式）。
- **恢复**：`qwen --resume <uuid>` + stdin 提示词，真机实测 init 行 `session_id` 与首轮**完全一致**
  （不新开会话），`uuid` 亦复用。
- **指定 ID 开新会话**：`--session-id <uuid>`（FF-pane 预生成登记，省掉解析 init 的依赖）；
  与 `--resume`/`--continue` **互斥**（CLI 强制，真机实测退出 1）。
- **强杀后可恢复**：轮次进行中 `taskkill /T /F`，会话文件已含 init 记录，`--resume` 成功
  （真机实测）——中断场景凭据可用（**优于 grok headless 的「sessionId 只在 end 给」**：
  qwen 的 session_id 在首行 init 就有）。
- 保留策略：未见自动清理文档（gemini 有 30 天）；恢复失败时照常回退上下文重建（§10.3 既有路径）。

## 5. 取消方式

- 交互/TTY：SIGINT → FatalCancellationError 退出 130。
- **headless 子进程（FF-pane 场景）：唯一取消手段是杀进程树**（与 gemini 同款：CLI 仅在 TTY 装
  取消监听）。真机强杀实测：stdout 停在 `goal_state`，**无终止事件**，会话文件已落可 resume。
- `control_request`(interrupt) 协议级取消存在于 `--input-format stream-json` 双向模式
  （源码 SystemController.handleInterrupt），本单不用（同 §3.4 理由）。
- gracefulCancel 如实报 **partial**。

## 6. 认证方式

`--auth-type` 五选一（yargs choices），0.23.0 实况：

| 类型 | 配置方式 | headless 可用性 |
|---|---|---|
| `openai`（OpenAI 兼容协议） | `OPENAI_API_KEY` + `OPENAI_BASE_URL` (+ `OPENAI_MODEL`)，或 settings.json `modelProviders.openai` | ✅ **主路径**。覆盖 ModelStudio/Dashscope、Coding Plan（`BAILIAN_CODING_PLAN_API_KEY` + coding 专属 base_url）、OpenRouter、任意兼容端点 |
| `anthropic` | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | ✅ |
| `gemini` | `GEMINI_API_KEY` | ✅ |
| `vertex-ai` | `GOOGLE_API_KEY` / ADC | ✅ |
| `qwen-oauth` | 浏览器 OAuth | ❌ **免费层 2026-04-15 已废止**（官方文档明示；`/auth` 菜单已移除该项，仅存缓存 token 短暂可用） |

- headless 下 **auth type 必须显式**（`--auth-type` 或 settings `security.auth.selectedType`），
  否则 result(error_during_execution)「No auth type is selected…」退出 1（真机实测）。
- `qwen auth` 子命令**已整体移除**（帮助标注 removed；`qwen auth status` 打印迁移提示）——
  **无非交互登录态查询命令**。
- **FF-pane 推荐**：`--auth-type openai` 固定下发 + Provider 密钥按 Run 注入
  `OPENAI_API_KEY`/`OPENAI_BASE_URL`（openai_compatible Provider 直连 Dashscope/ModelStudio/
  OpenRouter/本地 vLLM 等）——完全落在 §4.3「密钥只经 env 下发」红线内，且是 CLI 侧行为最可
  预期的方式（`--openai-api-key` 命令行参数与之等效但密钥会进命令行，不用）。
- **不加入 CLI_LOGIN_RUNTIMES**（auth-probe）：qwen-oauth 已废止、无登录态查询命令、
  settings.json 里的 API key 属「用户自管配置」而非「CLI 登录态」——cli_login 类型 Provider
  在本 Runtime 无对应物，不硬造探测规则。

## 7. env 清洗面（对照 `process/env.ts` 收录原则逐项核实）

qwen 0.23.0 会消费的认证/路由变量与既有清洗清单的覆盖情况：

| 变量 | 作用 | 既有清单覆盖 |
|---|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | openai 兼容主路径 | ✅ `^OPENAI_` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | anthropic 协议 | ✅ `^ANTHROPIC_` |
| `GEMINI_API_KEY` | gemini 协议 | ✅ `^GEMINI_API_KEY$` |
| `GOOGLE_API_KEY` / `GOOGLE_CLOUD_PROJECT` 等 | vertex-ai | ✅ `^GOOGLE_(…)` |
| `DASHSCOPE_API_KEY` | ModelStudio 标准端点 | ✅ `^DASHSCOPE_` |
| `BAILIAN_CODING_PLAN_API_KEY` | Coding Plan 专属端点 | ✅ 兜底 `(?:^|_)API_KEYS?$` |
| `OPENROUTER_API_KEY` / `REQUESTY_API_KEY` | 第三方 Provider | ✅ `^OPENROUTER_` / 兜底 |
| **`QWEN_MODEL`** | `OPENAI_MODEL` 的别名（模型路由） | ❌ **本单补 `/^QWEN_MODEL$/`**——半套配置风险与 OPENAI_MODEL 同性质（密钥来自 FF-pane 注入、模型却来自用户 shell），而 OPENAI_MODEL 已被 `^OPENAI_` 剥掉，别名不剥等于留后门 |
| `QWEN_CODE_*` 行为开关（SUPPRESS_YOLO_WARNING / UNATTENDED_RETRY 等） | 行为调节 | 不剥（不携带凭证，同 `GOOGLE_GENAI_USE_GCA` 不剥的先例） |

## 8. 已识别的坑（按严重度排序）

1. **API 错误伪装成功（比 gemini 恶劣）。** 真机实测 401：错误被升格为 assistant 文本
   `[API Error: 401 Incorrect API key provided…]` → result `subtype:"success"`、`is_error:false`、
   **退出码 0**。gemini 至少把 HTTP 状态码透传成退出码，qwen 连这个信号都没有。
   防线：映射器识别 `[API Error:` 文本标记（源码字面量，`chunk-4F7GQGXB.js`）——命中即整轮
   记 failed 并保留原文。标记漂移的症状是漏判为 completed，故 fixture 钉住该字面量供重录核对。
2. **权限拒绝伪装成功。** denials 非空时 result 仍 success / 退出 0（§3.4）。防线：
   `result.permission_denials` 非空 → 整轮 failed（结构化字段判据，claude mapper 规则 2 同款）；
   tool_result 的 `is_error` + 拒绝文本标记作动作级 denied 改判。
3. **Windows 退出期 libuv 崩溃（0xC0000409）。** result 行已完整落出后，进程退出阶段偶发
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（本机 6 跑 3 现，非确定性）。
   **事件流完整性不受影响**（result 恒在崩溃前写完）。防线：**result 已到达时退出码不参与
   成败判定**（claude「result 到达即收束」款式——qwen 若照抄 gemini 的「非零退出码 → failed」
   会把成功轮误判失败）；result 缺席时退出码照常参与兜底判定。
4. **`--approval-mode default` 静默废掉 Worker。** 同 gemini 坑 1：进程退 0、result success。
   Worker 必须显式 `yolo`（CLI 侧放权，安全由 FF-pane 权限层承担——每 Run 权限信封 +
   事后校验；qwen 无 gemini 的 `--policy` 策略引擎，纵深防御少一层，如实登记）。
5. **npm .cmd 垫片多行截断。** positional 提示词经 cmd.exe 会在第一个换行截断（codex 同款）。
   **提示词一律走 stdin 管道**（真机实测纯 stdin 无 positional 正常进 headless）。
6. **`--session-id` 与 `--resume` 互斥**（CLI 强制，报错退出 1）——新会话给 session-id，
   恢复给 resume，装配层保证不同时传。
7. **assistant 文本双路重复**：开 `--include-partial-messages` 后 `content_block_delta` 增量与
   `assistant` 行的 text 块**内容完全重复**（claude 同款）——映射器两路选一路（开 partial 就
   只认增量，assistant 行 text 块忽略；tool_use 块仍从 assistant 行取）。
8. **`stream_event: goal_state` 恒出现**（Goal 机制状态投影，headless 每轮至少一条）——
   非六类骨架事件，raw 留档即可。
9. **首次运行副作用**：`~/.qwen/`（installation_id、projects/、tmp/）自动创建；`--safe-mode`
   不影响这层。清理用户数据时注意该目录归 CLI 所有。
10. **会话按 cwd 隔离 + 无自动清理承诺**：Native Session ID 恢复失败（目录变更/文件被删）
    要能静默降级「上下文重建」（§10.3 既有路径）。

## 9. 六项能力声明核对（设计文档 §5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `--resume <uuid>` + stdin 提示词真机实测成功（session_id 复用）；`--session-id` 可预登记；强杀后仍可恢复（init 首行就有 session_id，中断轮凭据可用）。限制：绑定 cwd |
| 2 | 流式输出 | **是** | `--include-partial-messages` 下 `content_block_delta` 是 token 级真增量（真机实测切片投递）；适配器恒开该开关 |
| 3 | 文件修改事件 | **部分** | `tool_use`(write_file/edit) 路径与参数结构化可靠；但 tool_result 无 diff 正文（gemini 有统一 diff 文本，qwen 丢掉了）——diff 仅 edit 类可从 old/new 参数渲染，write_file 覆盖场景旧内容不可得，不自造 |
| 4 | 命令执行事件 | **部分** | `tool_use`(run_shell_command) 含命令；tool_result 含输出文本与 is_error，**无结构化退出码**（同 gemini 评级） |
| 5 | 权限请求转发 | **否** | 单发 headless 下源码明确按本地审批模式立即裁决、不发 can_use_tool（§3.4）；转发通道归 `--input-format stream-json` SDK 模式（官方标注 under construction）与 Dual Output——将来路径 §10 |
| 6 | 中途取消 | **部分** | headless 无取消监听，只能树杀；无终止事件需进程终局兜底；强杀后会话可恢复。interrupt 控制请求归双向模式 |

## 9.1 实现方案两案对比（工单要求落档）

- **案 A（选定）独立目录 `src/qwen-code/` + 复用共享模块**（readJsonlStream / decodeLines /
  spawnAgentProcess / toRawEvent / createLiteralGuard）：
  - 对 gemini-cli：协议**不同款**（§0 对照表——信封形态、参数面、退出码语义三层全分叉），
    参数化派生没有共享面；
  - 对 claude-code：信封同构（system/assistant/user/result + content 块）但差异全在语义层——
    工具名不同（write_file/edit/run_shell_command vs Write/Edit/Bash）、diff 来源不同
    （claude 有 `tool_use_result.structuredPatch`，qwen 没有）、成败判据不同（qwen 多
    `[API Error:` 文本坑 + 退出期崩溃坑）、控制协议不可用（claude 双向 stdin 权限转发/interrupt
    是其核心，qwen headless 没有）、args 全不同。共享映射器需要「工具表 + diff 策略 + 终局
    判定」三轴参数化，抽象面大于手写面（qwen mapper 独立一份 ~300 行纯函数）。
- **案 B（弃）参数化派生自 gemini-cli**：fork 血缘只剩交互层与工具名，headless 协议已重写——死路。
- **案 B'（弃）参数化派生自 claude-code**：见上，参数面大于共享面，且把 claude 适配器
  （已验收的双向协议实现）改成双形态会引入回归风险，收益只是省一份 mapper。

进程模型：**一轮一 spawn**（同 codex/gemini），提示词走 stdin，多轮靠 `--resume` 反复 spawn；
stdin 写完即 end（单发模式无双向流量）。

### 9.2 启动命令模板

```powershell
# Worker（可写 + 可执行命令）；提示词经 stdin 管道写入
qwen -o stream-json --include-partial-messages --approval-mode yolo --safe-mode `
  --auth-type openai --session-id <ffpane生成的uuid> [-m <model>] [--include-directories <dirs>]

# Planner / Reviewer（只读）
qwen -o stream-json --include-partial-messages --approval-mode plan --safe-mode `
  --auth-type openai --session-id <uuid>

# 恢复（与 --session-id 互斥）
qwen -o stream-json --include-partial-messages --approval-mode <同前> --safe-mode `
  --auth-type openai --resume <uuid>
```

- 工作目录 = 项目目录（spawn cwd），会话隔离依赖它，恢复时必须一致（启动前校验）。
- 环境变量注入：`OPENAI_API_KEY`（+ Provider 有 baseUrl 时 `OPENAI_BASE_URL`）按 Run 注入；
  清洗面见 §7。

### 9.3 事件映射表

| qwen 事件 | FF-pane 统一事件 | 备注 |
|---|---|---|
| `system`(init) | `session_start` | 取 `session_id` 登记 Native Session ID（预生成时仅校验）；`model` 是启动参数回显非实际解析值，不填 SessionStartEvent.model |
| `stream_event`(content_block_delta, text_delta) | `text`（增量，final=false） | 恒开 partial：文本只走这一路 |
| `stream_event`(message_stop / content_block_stop) | （用于补 final） | 文本块关闭时补 content 为空的 final |
| `assistant` 行 text 块 | **忽略**（与增量重复，坑 7） | tool_use 块照常处理 |
| `assistant` 行 `tool_use`(write_file/edit/notebook_edit) | `file_change`(started) | path 取 input.file_path / notebook_path；edit 类可由 old/new 渲染 diff |
| `user` 行 `tool_result`（配对文件工具） | `file_change`(completed/failed/denied) | denied 判据：is_error + 拒绝文本标记；diff 在 started 侧已渲染的沿用 |
| `assistant` 行 `tool_use`(run_shell_command) | `command`(started) | command 取 input.command |
| `user` 行 `tool_result`（配对命令工具） | `command`(completed/failed/denied) | **exitCode 恒缺席**（无结构化字段）；output 取 content 文本 |
| 其余 `tool_use`/`tool_result`（read_file/glob/…） | `raw` | 只读工具噪音，留档 |
| `stream_event`(goal_state 等) | `raw` | 非骨架事件 |
| `result` | `end`（在进程退出时合成） | 判定见下 |
| 进程退出 | `end` 兜底 | 流断无 result → cancelled（主动取消/超时）或 crashed |

**end 判定规则（三坑防线，§8 坑 1/2/3）**：

1. `permission_denials` 非空 → **failed**（列出被拒工具）；
2. 最终文本/任一 assistant 文本命中 `[API Error:` → **failed**（保留原文）；
3. `is_error:true` 或 subtype ≠ success → failed（subtype 语义并入 message）；
4. 以上全过且 result 到达 → **completed，退出码不参与判定**（坑 3：退出期崩溃不误判）；
5. result 缺席 → 进程终局兜底（取消 → cancelled；否则 crashed），退出码留档。

## 10. 待真机补验（登记）

| 项 | 说明 | 前置条件 |
|---|---|---|
| 真实 Qwen/ModelStudio 后端特有字段 | `stream_event` 的 thinking 块形状、`stop_reason` 实际取值域、cache_read_input_tokens 非零形态、`result.stats` 完整结构 | 用户提供 DASHSCOPE_API_KEY / Coding Plan key |
| `--mcp-config` 逐轮注入语义 | 形状与 claude 相似（JSON/文件路径二选一），注入后工具可见性与 strict 语义未实测——知识库工具（T6.6）在本 Runtime 的可行路径 | 后续工单实测后再改（T7.3a 纪律：能力与实测一致） |
| `--input-format stream-json` 双向模式 | can_use_tool 权限转发 + interrupt 优雅取消都在这条通道上（§3.4/§5）——官方标注 under construction，稳定后是把能力 5/6 翻案的路径 | 跟踪上游版本；届时照 claude 双向款式接 |
| `--acp` 模式 | ACP over stdio（T8.5a 协议层现成）——另一条权限转发/取消的路径 | M3 预留位评估 |
