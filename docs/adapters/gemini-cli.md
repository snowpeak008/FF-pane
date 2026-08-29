# Gemini CLI 接入调研（T2.0）

- **调研日期：** 2026-08-29
- **CLI 版本：** @google/gemini-cli **0.57.0**（调研当日 npm latest）
- **调研环境：** Windows 11 + PowerShell，Node v24
- **信息来源：** ① 本机真机运行（错误路径与会话存储，见 fixtures）；② 0.57.0 安装包自带官方文档
  （`bundle/docs/`，与安装版本严格同版）；③ 安装包 JS 源码（`bundle/gemini-*.js`、`bundle/chunk-*.js`、
  `bundle/policies/*.toml`）中的事件发射与策略代码。
- **认证限制声明：** 本机无 API key、无 OAuth 登录态，成功任务流未能真机录制；
  相关结构从源码逐字段提取，fixture 标注"文档构造，待真机校验"。

---

## 1. 安装方式与当前版本

```powershell
npm install -g @google/gemini-cli   # 官方包名，已核实
gemini --version                    # → 0.57.0
```

- 单可执行入口 `gemini`（Windows 下为 `%APPDATA%\npm\gemini.ps1` / `.cmd` 包装）。
- 自带原生依赖 `@lydell/node-pty`、`keytar`（预编译，无需本地编译链）。
- 官方也支持 `npx @google/gemini-cli`、Homebrew；FF-pane 场景推荐全局 npm 安装 + 版本锁定检测
  （`gemini --version` 探测，版本漂移风险见 §8）。

## 2. headless / 非交互模式参数

触发条件：`-p/--prompt` 或 stdin 为非 TTY（管道）。二者可叠加：**stdin 内容在前，`-p` 文本追加在后**。

| 参数 | 说明 | 适配器相关性 |
|---|---|---|
| `-p, --prompt <text>` | 非交互模式 + 任务文本 | **核心**。长文本建议走 stdin 管道，避免 Windows 命令行长度限制（约 32k 字符） |
| `-o, --output-format <fmt>` | `text`（默认）/ `json` / `stream-json` | **核心**，适配器用 `stream-json` |
| `--approval-mode <mode>` | `default` / `auto_edit` / `yolo` / `plan` | **核心**。headless 下 `default` 会拒绝一切写操作（见 §3.4），Worker 必须用 `yolo`（或 `auto_edit`，但 shell 仍被拒）；Planner/Reviewer 用 `plan`（只读模式） |
| `-y, --yolo` | 已弃用，等价 `--approval-mode yolo` | 不用 |
| `--skip-trust` | 跳过目录信任检查 | **必传**。未信任目录下 headless 直接退出码 55，stdout 无输出（真机验证） |
| `-m, --model <name>` | 模型别名 `auto`(默认)/`pro`/`flash`/`flash-lite` 或具体模型名 | 映射 Profile 的模型选择 |
| `--resume <id\|latest\|index>` | 恢复会话（UUID / "latest" / 序号），可与 `-p` 组合 | **核心**，原生恢复 |
| `--session-id <uuid>` | 新会话使用调用方指定的 UUID | **推荐**：FF-pane 生成 UUID 自己登记，不必解析 init 事件 |
| `--session-file <path>` | 从 JSON 文件加载会话 | 备用（跨目录迁移会话时可用） |
| `--list-sessions` / `--delete-session <n>` | 列出/删除当前目录的会话 | 注意：**这两个命令也要求认证**（真机验证：无认证退出码 41） |
| `--include-directories <dirs>` | 工作区追加目录（逗号分隔/多次传） | 可映射任务的额外可读路径 |
| `-s, --sandbox` | 沙箱执行。容器沙箱需 Docker/Podman；另有 Windows 原生沙箱（icacls 低完整性级别，`GEMINI_SANDBOX` 配置） | M1 不建议启用（依赖重、Windows 支持新），权限由 FF-pane 权限层负责 |
| `--policy <files>` / `--admin-policy <files>` | 追加策略引擎 TOML 文件 | **高价值**：可下发每 Run 生成的细粒度权限策略（见 §8.3） |
| `--allowed-tools <names>` | 已弃用（改用策略引擎） | 不用 |
| `--acp` | ACP 模式（JSON-RPC over stdio） | M3 预留位（设计文档 5.4），支持协议级审批/取消（见 §7 能力 5/6 备注） |
| `--raw-output` / `--accept-raw-output-risk` | 关闭模型输出的 ANSI 清洗 | 不用（保持默认清洗更安全） |
| `-d, --debug` | 调试日志（stderr） | 排障用 |

**退出码**（源码逐一确认）：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 一般错误 |
| 41 | 认证失败（FatalAuthenticationError） |
| 42 | 输入错误（FatalInputError） |
| 44 | 沙箱错误 |
| 52 | 配置错误 |
| 53 | 超过会话轮数上限（settings `model.maxSessionTurns`） |
| 54 | 工具执行致命错误 |
| 55 | 未信任目录（缺 `--skip-trust`） |
| 130 | 取消（FatalCancellationError） |
| 其他 | **API 错误的 HTTP 状态码会直接成为退出码**（真机验证：无效 key → 退出码 400）。适配器不得假设退出码是小整数枚举 |

## 3. 事件 / 输出格式

### 3.1 `-o json`（单对象，进程结束时一次性输出）

```json
{
  "session_id": "uuid",
  "response": "模型最终文本（ANSI 已清洗）",
  "stats": { "models": {...}, "tools": {...}, "files": {...} },
  "error":   { "type": "...", "message": "...", "code": 41 },
  "warnings": ["..."]
}
```

- 字段全部可选，按有无输出：成功时有 `response`+`stats`，失败时有 `error`（`response` 可能缺失）。
- `stats` 为完整 SessionMetrics：`models`（各模型 api/tokens 明细）、`tools`
  （totalCalls/totalSuccess/totalFail/totalDecisions/byName）、`files`（totalLinesAdded/totalLinesRemoved）。
- 样例：`fixtures/gemini-cli/real-json-auth-error.json`（真实）、`constructed-json-success.json`（构造）。

### 3.2 `-o stream-json`（JSONL 事件流，stdout 逐行输出）——适配器主用

六类事件，全部含 `type` + `timestamp`（ISO 8601）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `init` | `session_id`, `model` | 首个事件。`model` 是配置值（如 `"auto"`），非实际解析的模型名 |
| `message` | `role`("user"\|"assistant"), `content`, `delta?` | 用户输入回显一次（无 delta）；**assistant 文本为增量块，`delta: true`，需拼接聚合**。无"最终完整文本"事件 |
| `tool_use` | `tool_name`, `tool_id`, `parameters` | 工具调用请求（此时已通过策略检查进入执行；headless 无中途审批） |
| `tool_result` | `tool_id`, `status`("success"\|"error"), `output?`, `error?{type,message}` | 工具结果。`output` 是人类可读文本（diff/命令输出）；`error.type` 如 `permission_denied` |
| `error` | `severity`("warning"\|"error"), `message` | 非致命告警（配额重试、流校验失败等）。致命错误不走此事件而是直接抛出 → 非零退出 |
| `result` | `status`("success"\|"error"), `stats`, `error?` | 末事件。`stats` 为简化结构：total/input/output_tokens、cached、duration_ms、tool_calls、按模型分解 |

**文件修改如何体现：**

- `tool_use`：`tool_name` = `write_file`（参数 `file_path`, `content`）或 `replace`
  （参数 `file_path`, `old_string`, `new_string`, `instruction?`, `allow_multiple?`）。**路径与完整新内容在参数里，结构化可靠**。
- `tool_result.output`：jsdiff `createPatch` 统一 diff 文本（表头 `Original`/`Modified`，context 3）。
  是文本不是结构化字段，需按统一 diff 解析或直接存档展示。

**命令执行如何体现：**

- `tool_use`：`tool_name` = `run_shell_command`，参数 `command`, `description`, `dir_path?`, `is_background?`。
- `tool_result.output`：命令 stdout/stderr 文本。**没有结构化退出码字段**——非零退出时 `status` 为
  `"error"` 且信息嵌在文本里。Windows 下命令经 cmd/PowerShell 执行。

**样例：** `real-stream-json-api-error.jsonl`（真实）、`constructed-stream-json-success.jsonl`、
`constructed-stream-json-headless-deny.jsonl`（构造，待校验）。

### 3.3 stderr（不解析，只留存）

真机确认 stderr 非常吵：终端能力警告（TERM=dumb、色彩支持）、"Ripgrep is not available" 提示、
API 错误完整堆栈、`[WARNING]`/`[ERROR]` 前缀的用户反馈、错误报告文件路径
（`%TEMP%\gemini-client-error-*.json`）。**适配器只解析 stdout，stderr 原样写入 Run 的 raw.log**。

### 3.4 审批与策略（headless 的关键行为）

- 策略引擎决策三值：`allow` / `deny` / `ask_user`；**非交互模式下 `ask_user` 一律按 `deny` 处理**（官方文档明示）。
- 内置 `write.toml` 还有一条显式的 **Headless Denial Rule**：非交互模式下
  `replace`、`write_file`、`run_shell_command`、`activate_skill`、`web_fetch` 直接 `deny`。
- 因此各审批模式在 headless 下的实际效果：
  - `default`：只读工具可用；**一切写文件/命令/网络工具被拒**（模型会收到拒绝并口头汇报，进程正常结束、退出码 0）；
  - `auto_edit`：`write_file`/`replace`/`web_fetch` 放行，**`run_shell_command` 仍被拒**；
  - `yolo`：全部放行（`ask_user` 工具在非交互下仍拒，plan 模式切换工具被禁）;
  - `plan`：只读研究模式，适合 Planner/Reviewer。
- 被拒表现为 `tool_result` status=error（`Tool execution for "..." denied by policy.`，
  error.type=`permission_denied`），**不产生任何"权限请求"事件，也无法中途补批**。

## 4. 原生会话：保存与恢复

- **自动保存**：每次运行（含 headless、含失败运行，真机验证）都在
  `~/.gemini/tmp/<项目目录标识>/chats/session-<时间戳>-<sessionId前8位>.jsonl` 落盘。
  内容含完整对话、工具调用出入参、token 统计、思考摘要。格式见 `real-session-storage.jsonl`。
- **按工作目录隔离**：`~/.gemini/projects.json` 维护 cwd → 目录标识映射；
  **恢复必须在同一工作目录执行**，跨目录看不到对方的会话。
- **恢复**：`gemini --resume <uuid|latest|序号> -p "继续的指令" ...`。
- **指定 ID 开新会话**：`--session-id <uuid>`，FF-pane 可自行生成 UUID 并登记（设计文档 10.2 的
  Native Session ID 登记），省去解析 init 事件的依赖。
- **保留策略**：默认保留 30 天（settings `general.sessionRetention`）。**FF-pane 需提示用户：
  原生会话可能被 CLI 自动清理，恢复失败时回退"上下文重建"**（设计文档 10.3 已有此路径）。
- 坑：`--list-sessions` / `--delete-session` 也要求认证可用（真机验证退出码 41）。

## 5. 取消方式

- **交互/TTY**：Ctrl+C 或 ESC 触发内部 AbortController，退出码 130。
- **headless 子进程（FF-pane 场景）**：CLI 仅在 stdin 为 TTY 时安装取消监听；
  子进程环境下**唯一取消手段是终止进程树**（Windows：`taskkill /PID <pid> /T /F`；
  Node：`child.kill()` 需注意 npm 包装脚本产生的子进程层级，务必按进程树杀）。
- 会话文件持续增量落盘，**强杀后仍可 `--resume` 继续**（同 Codex 行为，待真机校验）。
- 协议级优雅取消仅存在于 **ACP 模式**（JSON-RPC `cancel` 方法）。

## 6. 认证方式

四种认证类型（settings.json `security.auth.selectedType` 的枚举，源码确认）：

| 类型 | selectedType 值 | 配置方式 | headless 可用性 |
|---|---|---|---|
| Google 登录（OAuth，个人/订阅额度） | `oauth-personal` | 交互式浏览器登录一次，凭证缓存于 `~/.gemini/oauth_creds.json` | 已有缓存则可用；**无法非交互发起登录** |
| Gemini API key（AI Studio） | `gemini-api-key` | 环境变量 `GEMINI_API_KEY` | ✅ 官方推荐的 headless 方式 |
| Vertex AI | `vertex-ai` | `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`，凭证走 ADC / 服务账号 JSON（`GOOGLE_APPLICATION_CREDENTIALS`）/ `GOOGLE_API_KEY` | ✅ 企业场景 |
| Cloud Shell | `cloud-shell` | GCP 环境自动 | 不适用本产品 |

- 无认证时 headless 报错（真机验证）：`-o json` 输出 error 对象并退出 41，提示三选一：
  `GEMINI_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_GCA`（第三个即复用 OAuth 登录态的开关）。
- 环境变量也可放 `.gemini/.env`（项目或用户目录），CLI 自动加载**首个**找到的文件（不合并）。
- 组织账号（Workspace）走 OAuth 时还需 `GOOGLE_CLOUD_PROJECT`。

**FF-pane 推荐**：主推 **`GEMINI_API_KEY` + Provider 密钥库按 Run 注入环境变量**——完全符合设计文档
4.3（密钥不落盘、注入范围仅限该 Run），且是官方 headless 推荐方式、行为最可预期。
同时支持 `cli_login` 类型（探测 `~/.gemini/oauth_creds.json` 存在 + settings selectedType 为
oauth-personal 即视为已登录），供已有 Google AI Pro/Ultra 订阅的用户复用额度；
登录动作本身引导用户在终端跑一次交互式 `gemini` 完成，FF-pane 不代办。

## 7. 六项能力声明核对（设计文档 5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `--resume <uuid>` + `-p` 组合可用；`--session-id` 可预登记；会话自动落盘（真机验证）。限制:必须同工作目录、默认 30 天清理 |
| 2 | 流式输出 | **是** | `-o stream-json` JSONL 逐行；assistant 文本为 delta 增量块（源码确认） |
| 3 | 文件修改事件 | **是** | `tool_use`(write_file/replace) 含路径与完整参数；`tool_result` 含统一 diff 文本。diff 为文本需解析，但路径+内容结构化可靠 |
| 4 | 命令执行事件 | **部分** | `tool_use`(run_shell_command) 含命令与工作目录；`tool_result` 含输出与成败状态，**但无结构化退出码字段**（设计要求"命令 + 退出码"） |
| 5 | 权限请求转发 | **否**（headless） | 非交互模式 `ask_user` 一律视同 deny（官方文档 + 内置 write.toml Headless Denial Rule）；无审批事件、无补批通道。替代：`--approval-mode` 预授权 + FF-pane 自建权限层；ACP 模式支持协议级审批（M3 预留位） |
| 6 | 中途取消 | **部分** | 无协议级取消（非 TTY 下 CLI 不装任何取消监听），只能杀进程树；强杀后会话可恢复。ACP 模式有 `cancel` 方法 |

## 8. 适配器实现建议（映射到统一事件）

### 8.1 事件映射表

| Gemini 事件 | FF-pane 统一事件 | 备注 |
|---|---|---|
| `init` | `session_start` | 取 `session_id` 登记为 Native Session ID（若启动时已传 `--session-id` 则仅作校验） |
| `message` role=assistant | `text` | **按 delta 聚合**；role=user 的回显直接丢弃 |
| `tool_use`(write_file/replace) + 对应 `tool_result` | `file_change` | 路径取 `parameters.file_path`；diff 优先解析 `tool_result.output` 的统一 diff，解析失败则以 `parameters`（write_file 的 content / replace 的 old+new）自行构造 diff；`tool_result.status=error` 标记失败 |
| `tool_use`(run_shell_command) + 对应 `tool_result` | `command` | 命令取 `parameters.command`；**退出码不可得**——以 `status` 映射 成功=0/失败=非0(未知)，原始输出全文入 Run 记录 |
| `tool_use`(其余只读工具) | `text`（或忽略，进 raw.log） | glob/read_file/grep 等噪音大，建议折叠为进度提示 |
| （不存在） | `permission_request` | **headless 无此事件**。FF-pane 权限层在 CLI 外实现（见 8.3） |
| `result` / 进程退出 | `end` | `status=success` → completed；`status=error` 或非零退出码 → failed；被 FF-pane 杀进程 → cancelled；**注意流可能无 result 事件就断（强杀/崩溃），必须以"进程退出"为最终 end 信号兜底** |
| `error` | `text`（warning 级） | severity=error 且随后无恢复 → 并入 end 原因 |

### 8.2 启动命令模板

```powershell
# Worker（可写 + 可执行命令）
gemini -p "<任务合同文本>" -o stream-json --skip-trust --approval-mode yolo `
  --session-id <ffpane生成的uuid> [-m <model>] [--include-directories <额外只读目录>]

# Planner / Reviewer（只读）
gemini -p "<讨论/审查文本>" -o stream-json --skip-trust --approval-mode plan --session-id <uuid>

# 恢复
gemini --resume <uuid> -p "<后续指令>" -o stream-json --skip-trust --approval-mode <同前>
```

- 工作目录 = 项目目录（spawn cwd），会话隔离依赖它，恢复时必须一致。
- 环境变量注入：`GEMINI_API_KEY`（按 Run 注入）；建议同时清掉 `GOOGLE_API_KEY` 等避免歧义。
- 长任务文本走 stdin 管道 + `-p` 传简短指令（stdin 在前 `-p` 在后拼接）。

### 8.3 权限层实现（弥补能力 5 的"否"）

Worker 必须 `yolo` 才能干活，等于 CLI 侧完全放权，FF-pane 的 5 项权限全靠外层：

1. **策略引擎兜底（推荐、成本低）**：每 Run 生成一份 TOML，经 `--policy` 下发，把危险清单直接在
   CLI 内拒掉。策略引擎支持 `argsPattern` 对工具 JSON 参数做正则匹配，可实现 write_scope 粗粒度限制与
   危险命令拦截，`denyMessage` 可自定义拒绝文案。例：

   ```toml
   [[rule]]                                    # 拦 git push
   toolName = "run_shell_command"
   argsPattern = '"command":"[^"]*git\s+push'
   decision = "deny"
   priority = 900
   denyMessage = "git push 需要用户在 FF-pane 中确认"

   [[rule]]                                    # 禁写 .git 目录
   toolName = ["write_file", "replace"]
   argsPattern = '"file_path":"[^"]*\\.git\\\\'
   decision = "deny"
   priority = 900
   ```

   注意这是"拒绝"不是"转审批"——被拒后模型会绕路或口头汇报，FF-pane 在 Run 报告中呈现。
2. **事后校验**：Run 结束后对照 `file_change` 事件核查 write_scope 越界，越界文件走 git 恢复并把任务转 failed。
3. **真正的中途审批**只能等 ACP 接入（M3）：ACP 模式有会话级审批模式切换与工具审批请求，
   Gemini CLI 已内置 `--acp`（JSON-RPC over stdio，方法含 `newSession`/`loadSession`/`prompt`/`cancel`/`setSessionMode`）。

### 8.4 已识别的坑（按严重度排序）

1. **`--approval-mode default` 在 headless 下静默废掉 Worker**：所有写操作被策略拒绝，但进程退出码是 0、
   result 是 success，只有 tool_result 里有 error——不读事件流会误判任务成功。适配器必须显式传审批模式，
   并把 `permission_denied` 的 tool_result 上浮为任务失败信号。
2. **退出码不可枚举**：API 错误的 HTTP 状态码直接变成进程退出码（真机见 400）。按"0=成功、
   41/42/44/52/53/54/55/130=已知语义、其他=失败"处理。
3. **缺 `--skip-trust` 直接 55**：新项目目录必现。启动参数固定带上。
4. **assistant 文本是 delta 流**，且 `result` 事件不含最终文本——文本聚合逻辑必须在适配器内完成；
   `-o json` 模式虽有完整 `response` 但丢失过程事件，不适合 Worker。
5. **stderr 噪音大且含堆栈**，勿混入事件解析；勿依赖 stderr 判断成败。
6. **会话按 cwd 隔离 + 30 天自动清理**：Native Session ID 恢复失败要能静默降级到"上下文重建"。
7. **模型名漂移**：`init.model` 是别名（"auto"），实际模型只在 stats 的 models 键里出现
   （如 gemini-3.1-pro-preview），且路由分类器模型（flash-lite）会一并出现在统计中，勿当作执行模型。
8. **`tool_id` 格式不保证**（模型返回的 functionCall.id，缺失时回退时间戳/UUID），当不透明字符串用，
   仅用于 tool_use ↔ tool_result 配对。
9. **中文/本地化**：会话上下文注入含本地化日期（真机见"2026年8月29日星期六"）；Windows 中文环境下
   命令输出可能含 GBK 转码问题，管道读取按 UTF-8 处理并容错。
10. **首次运行副作用**：`~/.gemini/`（installation_id、projects.json、tmp/）自动创建；
    无需预初始化，但清理用户数据时注意该目录归 CLI 所有。
