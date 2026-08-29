# OpenCode 适配器调研（T2.0）

**调研日期:** 2026-08-29
**CLI 版本:** OpenCode 1.18.25（npm 安装：`npm install -g opencode-ai`；`opencode --version` 实测）
**调研方式:** 真机验证（Windows 11 + PowerShell）。本机无任何可用 API key、未装 Ollama，因此用**本地 mock OpenAI 兼容端点**（Node 起的 `/v1/chat/completions` 假服务）作为 Provider，让真实的 OpenCode 1.18.25 二进制跑真实任务。**事件流结构 100% 真实**（写文件真实落盘、命令真实执行、权限流真实触发），只有模型回复内容是脚本化的。fixture 存于 `packages/adapters/fixtures/opencode/`。关键结论另与 GitHub `sst/opencode` v1.18.25 源码（`packages/opencode/src/cli/cmd/run.ts` 等）交叉核对。
**结论先行:** 六项能力可全部满足，但**必须走 Server（`opencode serve` + HTTP/SSE）接入路径**——纯 CLI `run --format json` 路径没有流式文本增量、也无法转发权限请求（默认自动拒绝）。OpenCode 的 Provider 层通过 `opencode.json` 配 openai-compatible 自定义端点极其顺畅（本次 mock 录制本身就是证明），一个适配器即可覆盖 DeepSeek / Qwen / Kimi / GLM / Ollama 等全部主流开放模型，战略定位成立。

---

## 1. 安装方式与当前版本

| 途径 | 命令 | 说明 |
|---|---|---|
| npm（本次采用） | `npm install -g opencode-ai` | 包名是 `opencode-ai` 不是 `opencode`；安装器按平台拉取原生二进制 |
| 官方脚本 | `curl -fsSL https://opencode.ai/install \| bash` | Windows 上不适用 |
| 其他 | bun / pnpm / brew / paru | 官方均支持 |

- 实测版本 **1.18.25**，发版节奏极快（几乎每日）。
- **自动更新默认开启**：启动时会自己升级。FF-pane 必须在配置里 `"autoupdate": false` 或注入环境变量 `OPENCODE_DISABLE_AUTOUPDATE=1`，否则事件格式可能在用户无感知的情况下漂移（对应开发计划风险 R3）。
- Windows 落盘位置（全部实测确认，注意都是类 Unix 路径习惯，不在 `%APPDATA%`）：
  - 二进制缓存与模型目录缓存：`%USERPROFILE%\.cache\opencode\`（`bin\`、`models.json`）
  - 全局配置：`%USERPROFILE%\.config\opencode\opencode.json(c)`
  - 会话数据库与凭证：`%USERPROFILE%\.local\share\opencode\`（`opencode.db`、`auth.json`）
- npm 全局装的 `opencode` 命令是 **wrapper**（shim → 实际 opencode.exe 子进程）。实测 `Stop-Process` 杀 wrapper 报告的 PID 后监听进程仍活着——**进程树终止必须用 `taskkill /PID <pid> /T /F` 或 Job Object**（见 §8 坑 3）。

---

## 2. headless / 非交互模式

### 2.1 `opencode run`（CLI 路径）

```text
opencode run [message..] --format json [其他参数]
```

1.18.25 实测 `--help` 的全部相关参数：

| 参数 | 作用 | 备注 |
|---|---|---|
| `--format json` | 逐行 JSONL 原始事件输出 | 不加则是给人看的格式化文本 |
| `-m, --model <provider/model>` | 指定 Provider 与模型 | 如 `mockai/mock-model`、`deepseek/deepseek-chat` |
| `--agent <名>` | 指定 agent（内置 `build`/`plan` 或自定义） | `plan` 默认禁改文件，天然适合 Planner 角色 |
| `-s, --session <id>` | 继续指定会话 | 原生恢复 |
| `-c, --continue` | 继续最近一个会话 | |
| `--fork` | 恢复前先派生新会话 | 需配 `--session` 或 `--continue` |
| `--auto` | 自动批准未显式 deny 的权限请求 | 危险；不加则权限请求**自动拒绝**（见 §3.3） |
| `--dir <目录>` | 运行目录 | 等价于在该目录 spawn |
| `--attach <url>` | 挂到已运行的 `opencode serve` | 避免每次冷启动；配 `--port/-p/-u` |
| `--variant <档位>` | 推理力度（high/max/minimal 等，随 Provider） | |
| `--thinking` | 输出 reasoning 块 | JSON 模式对应 `reasoning` 事件 |
| `-f, --file <路径>` | 附加文件到消息 | |
| `--title <标题>` | 会话标题 | |
| `--command <名>` | 执行自定义 slash command，message 作为其参数 | |
| `--print-logs` / `--log-level` | 日志到 stderr | 调试用，不污染 stdout JSON |
| `--pure` | 禁外部插件 | 适配器建议加，减少不可控事件 |

行为要点（源码 + 实测）：

- stdout 只有 JSONL 事件；人类可读的警告（如权限自动拒绝提示）走 **stderr**。
- 退出码：正常 0；出错（`error` 事件后）为 1（实测 Provider 不可达场景 EXIT=1）。
- 会话结束的判定是内部事件 `session.status == idle`，然后进程退出——**适配器以进程退出为 `end` 信号即可**。
- `run` 每次内部都要起一个 in-process server（冷启动实测 3–5 秒）；`--attach` 可以复用常驻 server 省掉这段。
- run 模式创建的会话会自动写入三条 deny 规则：`question` / `plan_enter` / `plan_exit`（源码确认，`opencode export` 输出中可见）。即 headless 下 Agent 不能反问用户——FF-pane 的"澄清请求"机制不能依赖 OpenCode 原生 question 工具，需靠提示词约定。

### 2.2 `opencode serve`（Server 路径）

```text
opencode serve --port 4747 --hostname 127.0.0.1
```

起一个常驻 HTTP 服务，OpenAPI 3.1 规范可从 `http://127.0.0.1:4747/doc` 拿到。可设 `OPENCODE_SERVER_PASSWORD` 开启 basic auth。与适配器直接相关的端点（全部实测通过，见 fixture `server/`）：

| 端点 | 用途 | 实测 |
|---|---|---|
| `GET /global/health` | 健康检查 + 版本 | `{"healthy":true,"version":"1.18.25"}` |
| `GET /event` | **SSE 全局事件流**（第一条为 `server.connected`） | 156 事件已录制 |
| `POST /session` | 建会话（body 可带 `title`） | 返回完整 Session 对象 |
| `POST /session/:id/message` | 发消息并**等待完成**，返回 `{info, parts}` | 同步收尾，事件同时走 SSE |
| `POST /session/:id/prompt_async` | 发消息**立即返回 204** | 配 SSE 用，推荐 |
| `POST /session/:id/permissions/:permissionID` | 回复权限请求 `{"response":"once"\|"always"\|"reject"}` | 200 |
| `POST /session/:id/abort` | 中断执行 | 返回 `true` |
| `GET /session/:id/diff` | 会话文件 diff | 见 §3.4 保留意见 |
| `GET /session/:id/message` | 消息历史 | |
| `GET /session` / `GET /session/:id` / `POST /session/:id/fork` / `DELETE /session/:id` | 会话管理 | |
| `GET /config/providers` | 已配置 Provider 与模型列表 | 可做"测试连接"的数据源 |

消息体格式（实测）：

```json
{
  "model": { "providerID": "mockai", "modelID": "mock-model" },
  "parts": [{ "type": "text", "text": "任务文本" }]
}
```

**一个 serve 实例可服务多个项目目录**：SDK/请求可带 directory 参数（`run --attach` 的 `--dir` 即此义），FF-pane 可以全局只养一个 opencode server 进程。

### 2.3 CLI vs Server 接入路径对比与建议

| 维度 | CLI（`run --format json`） | Server（`serve` + SSE） |
|---|---|---|
| 流式文本 | ❌ 只有整块完成的 `text` 事件（源码确认只在 `part.time.end` 时 emit） | ✅ `message.part.delta` 逐 token 增量 |
| 权限转发 | ❌ 无事件输出；默认自动拒绝，`--auto` 自动批准 | ✅ `permission.asked` 事件 + 回复端点 |
| 取消 | 杀进程树（数据不丢，可 resume） | ✅ `POST /abort`，优雅 |
| 生命周期 | 进程即会话，简单 | 需管理常驻进程 + 端口 + 崩溃重启 |
| 冷启动 | 每次 3–5s | 一次性 |
| 文件事件 | tool part（够用） | tool part + `file.edited` + 权限 diff |
| 多项目 | 每 Run 一进程 | 一实例多目录 |

**建议：主路径用 Server。** FF-pane 适配器 spawn 并托管一个 `opencode serve --port <随机> --hostname 127.0.0.1` 子进程（`OPENCODE_SERVER_PASSWORD` 随机生成），所有会话经 HTTP/SSE。这是唯一能同时拿到六项能力的路径；CLI 路径可作为降级兜底（放弃权限转发与流式增量，权限改为预配置 `OPENCODE_PERMISSION` + 任务范围 allow 规则）。

---

## 3. 事件 / 输出格式

### 3.1 `run --format json` 的 JSONL 事件（真实录制）

每行一个对象，统一外壳：`{"type", "timestamp", "sessionID", ...}`。**没有独立的会话开始事件**——sessionID 出现在每一行里。1.18.25 全部可能的 type（源码枚举）：`step_start`、`text`、`reasoning`（需 `--thinking`）、`tool_use`、`step_finish`、`error`。

`text`（fixture `run-json/s1-text.jsonl`）：

```json
{"type":"text","timestamp":1787994490427,"sessionID":"ses_fb3393f6affei4NEAUsj17fuPT",
 "part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_...","type":"text",
   "text":"Hello! This is a deterministic mock response recorded for the FF-pane fixture.",
   "time":{"start":1787994490406,"end":1787994490411}}}
```

`step_finish`（一个模型轮次结束，带 token 用量与费用）：

```json
{"type":"step_finish","...","part":{"type":"step-finish","reason":"stop",
  "tokens":{"total":132,"input":120,"output":12,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
```

`reason` 取值实测有 `stop` 与 `tool-calls`。`error`（fixture s7，Provider 不可达，进程退出码 1）：

```json
{"type":"error","timestamp":1787994949241,"sessionID":"ses_...",
 "error":{"name":"APIError","data":{"message":"Cannot connect to API: ...","isRetryable":true,
   "metadata":{"url":"http://127.0.0.1:8901/v1/chat/completions"}}}}
```

### 3.2 文件修改与命令执行的体现：`tool_use` 事件

工具调用只在**终态**（completed / error）时输出一条 `tool_use`，`part.state` 结构随状态不同：

写文件（fixture s2，`write` 工具，`edit` 工具同理）：

```json
{"type":"tool_use","part":{"type":"tool","tool":"write","callID":"call_...",
  "state":{"status":"completed",
    "input":{"filePath":"hello.txt","content":"hello from FF-pane opencode probe\n"},
    "output":"Wrote file successfully.",
    "metadata":{"diagnostics":{},"filepath":"C:\\Users\\REDACTED\\...\\proj\\hello.txt","exists":false},
    "title":"Users\\REDACTED\\...\\proj\\hello.txt",
    "time":{"start":...,"end":...}}}}
```

- `metadata.filepath` 是绝对路径，`metadata.exists` 表示是否为新建文件。
- **completed 状态里没有 diff**。diff 出现在两处：① 权限事件的 `metadata.diff`（标准 unified diff，见 §3.3）；② 适配器可用 `input.content` + 磁盘旧内容自算。

命令执行（fixture s5，`bash` 工具；Windows 下实际由 PowerShell 执行）：

```json
{"type":"tool_use","part":{"type":"tool","tool":"bash",
  "state":{"status":"completed","input":{"command":"echo hello-ffpane"},
    "output":"hello-ffpane\r\n",
    "metadata":{"output":"hello-ffpane\r\n","exit":0,"truncated":false},
    "title":"echo hello-ffpane"}}}
```

`metadata.exit` 即退出码，完美对应 FF-pane 的 `command` 事件（命令 + 退出码）。超长输出会被截断并给出 `outputPath`（落盘全文）。

权限被拒时的工具错误（fixture s3）：

```json
{"type":"tool_use","part":{"type":"tool","tool":"write",
  "state":{"status":"error","input":{...},
    "error":"The user rejected permission to use this specific tool call."}}}
```

### 3.3 权限在 run 模式下的行为（重要）

- 权限请求**不会**作为 JSON 事件输出（源码确认：`permission.asked` 分支不走 emit）。
- 默认**自动拒绝**，stderr 打警告：`! permission requested: edit (Users\...\hello.txt); auto-rejecting`（fixture `run-json/s3-stderr.txt`）。
- 实测被拒后该轮直接结束（模型没有机会拿到拒绝结果继续）。
- `--auto` 则自动批准（显式 deny 的仍拦）。
- 权限规则来源：配置 `permission` 段或环境变量 `OPENCODE_PERMISSION`（内联 JSON，实测 `{"edit":"ask"}` 生效）。支持按 glob/命令前缀的细粒度规则与 `external_directory` 越界保护（工作目录外的路径默认 ask）。

### 3.4 Server SSE 事件流（真实录制，fixture `server/sse-events.jsonl`，156 事件）

SSE 每条 `data:` 是 `{"id":"evt_...","type":...,"properties":{...}}`。与适配器相关的事件逐类：

| type | properties 关键字段 | 用途 |
|---|---|---|
| `server.connected` | — | SSE 握手成功 |
| `session.created` / `session.updated` | `info`（含 `id`、`parentID`、`title`、`directory`） | 会话开始；**子 Agent 会话**也走这里（有 `parentID`） |
| `message.updated` | `info`（role、agent、modelID、tokens、`time.completed`、`finish`） | 消息级状态 |
| `message.part.updated` | `part`（结构同 §3.2 的 part） | 工具部件状态机 **pending → running → completed/error** 每步一条 |
| `message.part.delta` | `{sessionID, messageID, partID, field:"text", delta:" is"}` | **流式文本增量**（CLI 模式没有的能力） |
| `permission.asked` | 见下 | 权限转发 |
| `permission.replied` | `{sessionID, requestID, reply}` | 权限回复回执 |
| `file.edited` | `{file}`（绝对路径） | 文件修改辅助信号 |
| `file.watcher.updated` | `{file, event}` | 文件系统监听 |
| `session.status` | `{sessionID, status:{type:"busy"\|"idle"\|...}}` | **`idle` 即回合结束**（run 命令内部就以此为结束条件） |
| `session.idle` | `{sessionID}` | 旧版结束信号（仍在发，双保险） |
| `session.diff` | `{sessionID, diff:[FileDiff]}` | 会话累计文件改动。**实测在非 git 目录恒为空数组**（快照机制依赖内部 git），不要依赖它做 file_change 主信号 |
| `plugin.added` / `catalog.updated` / `reference.updated` 等 | — | 启动噪声，忽略即可 |

`permission.asked` 完整结构（真实录制，fixture `server/event-permission-asked.json`）——**注意 `metadata.diff` 自带标准 unified diff**，正好喂给 FF-pane 的权限审批界面：

```json
{"type":"permission.asked","properties":{
  "id":"per_04ccad3020013jbMcwNJsjxC9Q",
  "sessionID":"ses_...",
  "permission":"edit",
  "patterns":["Users\\REDACTED\\AppData\\Local\\Temp\\ffpane-oc\\proj\\hello.txt"],
  "metadata":{"filepath":"C:\\Users\\REDACTED\\...\\hello.txt","diff":"Index: ...\n--- ...\n+++ ...\n@@ -0,0 +1,1 @@\n+hello from FF-pane opencode probe\n"},
  "always":["*"],
  "tool":{"messageID":"msg_...","callID":"call_..."}}}
```

回复：`POST /session/:id/permissions/per_xxx`，body `{"response":"once"}`（或 `always` / `reject`），实测 200 并收到 `permission.replied`，随后工具继续执行、`file.edited` 送达。

---

## 4. Provider 配置方式（FF-pane 覆盖主流模型的关键）

### 4.1 配置文件与优先级

JSON/JSONC 格式，多处合并（后者覆盖前者的冲突键）：

```text
远端组织配置(.well-known/opencode)
  → 全局 ~/.config/opencode/opencode.json
  → OPENCODE_CONFIG 指定的文件
  → 项目根 opencode.json（向上找到最近 git 目录）
  → OPENCODE_CONFIG_CONTENT 环境变量（内联 JSON，运行时覆盖）
```

**对 FF-pane 最有用的是最后两个**：适配器可以完全不碰用户的全局配置，为每个 Run 生成临时配置文件（`OPENCODE_CONFIG`）或直接内联注入（`OPENCODE_CONFIG_CONTENT`），实现按 Profile 隔离。

### 4.2 openai-compatible 自定义端点（本次真机验证的核心）

任意兼容 OpenAI `/v1/chat/completions` 的服务都这样接（**本次录制就是用这个格式接的本地 mock 端点，逐字段可信**）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "显示名",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:FFPANE_RUN_API_KEY}"
      },
      "models": {
        "some-model-id": {
          "name": "显示名",
          "limit": { "context": 128000, "output": 8192 }
        }
      }
    }
  },
  "model": "myprovider/some-model-id",
  "small_model": "myprovider/some-model-id"
}
```

要点：

- Provider ID（上面的 `myprovider`）任取；模型用 `-m <providerID>/<modelID>` 引用。
- `npm` 字段选驱动包：`@ai-sdk/openai-compatible`（/chat/completions）；若目标是 `/v1/responses` 型接口用 `@ai-sdk/openai`；Anthropic 格式用 `@ai-sdk/anthropic`。**首次使用某驱动包时 OpenCode 会联网拉取该包**（缓存后离线可用）——离线环境首跑会失败，见 §8 坑。
- `apiKey` 支持 `{env:VAR}` 与 `{file:path}` 替换——**与 FF-pane"密钥经环境变量按 Run 注入"的 4.3 规则天然契合**：配置文件里永远只有 `{env:...}` 引用，真实密钥由适配器 spawn 时注入。
- `options.headers` 可加自定义头；`limit` 让 OpenCode 正确管理上下文窗口（自定义端点拿不到 models.dev 元数据，**建议必填**）。
- `small_model` 用于标题生成等杂活——**注意它会额外产生一次 API 调用**（实测每个新会话一次），建议指到便宜模型。
- 本地 Ollama / vLLM / LM Studio 就是同一格式，`baseURL` 指到 `http://localhost:11434/v1` 等即可。

### 4.3 内置 Provider 目录（models.dev）

OpenCode 内置 75+ Provider 目录（DeepSeek、Moonshot/Kimi、Z.AI/GLM、阿里、OpenRouter、Groq……），这些**不需要写 provider 段**，只要有凭证：

- 交互式：`opencode auth login`（存 `~/.local/share/opencode/auth.json`）——不适合 FF-pane 自动化。
- **环境变量**：`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY`/`OPENAI_BASE_URL` 等会被自动吸收成可用 Provider。FF-pane 按 Run 注入对应变量即可，模型 ID 用 `deepseek/deepseek-chat` 这样的目录 ID。
- 反向风险：**用户 shell 里既有的这些环境变量也会被吸收**（本机实测有全局 `OPENAI_BASE_URL` 存在）。适配器 spawn 时应清洗环境，只保留白名单 + 本 Run 注入的变量，配 `disabled_providers`/`enabled_providers` 双保险。
- 首次启动会联网拉 models.dev 目录（缓存于 `~/.cache/opencode/models.json`）；`OPENCODE_DISABLE_MODELS_FETCH=1` 可禁。

### 4.4 与 FF-pane Provider 层的映射

| FF-pane Provider 类型 | OpenCode 接法 |
|---|---|
| openai_compatible | §4.2 自定义 provider（`@ai-sdk/openai-compatible`） |
| anthropic | 内置 `anthropic` + `ANTHROPIC_API_KEY`，或自定义 provider 换 `npm:"@ai-sdk/anthropic"` + baseURL |
| cli_login | 用户自己跑过 `opencode auth login`，适配器只需探测 `auth.json` 是否含该 provider（或 `GET /config/providers`） |
| custom | `options.headers` + `npm` 组合大多可覆盖 |

---

## 5. 原生会话：存储与恢复

- **存储**：SQLite 单库 `~/.local/share/opencode/opencode.db`（实测确认，1.10+ 从散文件迁到 SQLite）。表含 `session` / `message` / `part` / `permission` / `project` 等。会话记录 `directory`（工作目录）与 `projectID`（git 项目指纹；非 git 目录为 `"global"`）。
- **枚举**：`opencode session list --format json -n 5`（fixture `run-json/session-list.json`），字段 `{id, title, updated, created, projectId, directory}`；Server 端 `GET /session`。
- **恢复**：CLI `-s ses_xxx`（实测续会话成功、事件 sessionID 一致）、`-c` 续最近、`--fork` 派生副本（原会话不动）；Server 端直接对既有 sessionID 发消息即可，另有 `POST /session/:id/fork`。
- **登记何值**：FF-pane 登记 `sessionID`（`ses_` 前缀字符串）即可实现设计文档 10.3 的"原生恢复"。**注意会话绑定 directory**，跨目录恢复行为未验证，建议 Run 工作目录稳定。
- **导出/导入**：`opencode export <id>`（完整 JSON：info + 消息 + parts，含权限规则）、`opencode import <file>`——可作为 Handoff 的原始材料来源或调试取证。
- **删除**：`opencode session delete <id>` / `DELETE /session/:id`。

---

## 6. 取消方式

| 路径 | 方法 | 实测结果 |
|---|---|---|
| Server | `POST /session/:id/abort` | 返回 `true`；流式中断，会话转 idle，可继续复用（推荐） |
| CLI | 终止进程树 | 会话数据在 SQLite 里持久化，`-s` 可恢复；**必须 `taskkill /T`**（wrapper PID ≠ 实际进程，实测杀 wrapper 无效） |

- abort 后无 `session.error` 事件，正在跑的 `bash` 子进程由 OpenCode 内部 kill（源码：`forceKillAfter: 3 seconds`），消息保持未完成状态即结束。适配器以 abort 的 HTTP 200 + `session.status idle` 为 `end(cancelled)` 依据。
- 超时兜底：`bash` 工具默认 2 分钟超时（`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` 可调）；Provider 请求超时走 provider `options.timeout`。

---

## 7. 六项能力声明核对（设计文档 5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `-s/-c/--fork` 实测续会话成功；SQLite 持久化；Server 会话 API 齐全（§5） |
| 2 | 流式输出 | **是（仅 Server 路径）** | SSE `message.part.delta` 逐 token 实测录得 28 条；CLI JSON 模式只有整块 `text`（源码确认），CLI 路径下降级为"部分" |
| 3 | 文件修改事件 | **是** | `tool_use`(write/edit) 带 `input.content` + `metadata.filepath`；权限事件带 unified diff；`file.edited` 辅助。保留意见：结构化 diff 在 completed 态缺失、`session.diff` 非 git 目录为空，diff 需适配器自算或取权限元数据（§3.2/§3.4） |
| 4 | 命令执行事件 | **是** | `tool_use`(bash) 带 `input.command`、`output`、`metadata.exit`，实测退出码 0 正确（§3.2） |
| 5 | 权限请求转发 | **是（仅 Server 路径）** | `permission.asked`（含 diff）→ `POST .../permissions/:id` 回复 → `permission.replied`，全链路实测；CLI 路径为"否"（自动拒/自动批，无事件）（§3.3/§3.4） |
| 6 | 中途取消 | **是** | `POST /session/:id/abort` 实测返回 true 且会话可复用；CLI 杀进程树后可 `-s` 恢复（§6） |

> 综合：**Server 路径六项全"是"**；CLI 路径为 4 是 + 1 部分（流式）+ 1 否（权限）。适配器能力声明按 Server 路径填写。

---

## 8. 适配器实现建议与坑

### 8.1 统一事件映射

| FF-pane 事件 | OpenCode 来源（Server 路径） |
|---|---|
| `session_start` | `POST /session` 响应（拿到原生 `ses_` ID 即发） |
| `text` | `message.part.delta`（field=text）作增量；`message.part.updated` 且 `part.time.end` 存在作定稿 |
| `file_change` | `message.part.updated`：`part.type=="tool"` 且 `tool ∈ {write, edit, patch, apply_patch}` 且 `state.status=="completed"`；diff 优先取此前 `permission.asked` 的 `metadata.diff`（按 `tool.callID` 关联），否则自算 |
| `command` | 同上且 `tool=="bash"`：命令 `state.input.command`，退出码 `state.metadata.exit` |
| `permission_request` | `permission.asked`（`properties.id` 为回复凭据；`metadata.diff` 直接展示）；FF-pane 危险操作固定清单在适配器层先行拦截，不必等 OpenCode |
| `end` | `session.status` 变 `idle`（成功）；`session.error` / run `error` 事件（失败）；abort 后 idle（取消） |

其他映射细节：

- **必须按 sessionID 过滤 SSE**（全局事件流），并模仿 run.ts 维护"子会话集合"：`session.created` 带 `parentID` 属于当前会话的要并入（task 子 Agent 的事件才不会丢）。
- 工具状态机 `pending → running → completed/error` 每步都有 `message.part.updated`，可用 running 态做"执行中"UI。
- `step_finish` 的 `tokens`/`cost` 可直接入 Run 统计。
- 启动噪声（`plugin.added`×45、`catalog.updated` 等）直接丢弃。

### 8.2 最关键的三个坑

1. **CLI JSON 模式是残血版**：没有文本增量、没有权限事件（默认静默自动拒绝，只在 stderr 提示）。如果先按 CLI 路径实现再想补权限转发，等于重写。一开始就按 Server 路径设计，CLI 只作兜底。
2. **版本漂移风险极高**：日更节奏 + autoupdate 默认开启 + 事件 schema 无版本化承诺（还有 `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` 在酝酿新事件系统）。对策：`autoupdate:false` + 记录 `GET /global/health` 的 version 到 Run 日志 + fixture 回放测试锁行为 + 版本白名单告警。
3. **Windows 特有行为**：① npm wrapper PID ≠ 实际进程，进程树终止必须 `taskkill /T`/Job Object；② `bash` 工具实际走 PowerShell，输出带 `\r\n`、路径正反斜杠混用（权限 `patterns` 是无盘符反斜杠相对路径如 `Users\xxx\...`，与 `metadata.filepath` 的 `C:\` 绝对路径不一致——路径匹配逻辑要归一化）；③ 数据在 `%USERPROFILE%\.config`、`.local\share`、`.cache`（类 Unix 布局）。

### 8.3 其他注意点

- **环境清洗**：spawn 时剔除用户 shell 的 `OPENAI_*`、`ANTHROPIC_*` 等变量（会被 OpenCode 自动吸收成 Provider），只注入本 Run 的白名单；配 `enabled_providers` 锁定可用 Provider。
- **权限预配置**：即使走 Server 转发，也应通过 `OPENCODE_PERMISSION` / 配置把 FF-pane 权限信封翻译成 OpenCode 规则（`edit`/`bash` 细粒度 glob、`external_directory` deny 越界），转发只兜"ask"层。
- **角色映射**：Planner → `--agent plan`（OpenCode 内置 plan agent 默认禁改文件，与 FF-pane Planner 只读预设契合）；Worker → `build`。更细的定制走配置 `agent` 段。
- **`question`/`plan_enter`/`plan_exit` 在 run 模式被 deny**：Server 路径下自建会话时可以不加这三条 deny（run.ts 才加），若希望 Agent 能反问，可以放开 `question` 并把它映射成 FF-pane 澄清请求——待真机验证 question 工具的事件形态后再决定。
- **首跑联网依赖**：models.dev 目录 + `@ai-sdk/*` 驱动包按需下载。适配器安装引导里应有"预热"步骤（跑一次最小任务），否则离线用户首任务莫名失败。
- **小模型副请求**：每个新会话有一次 `small_model` 标题生成调用，成本核算和 mock 测试都要计入。
- **timestamp 均为本机毫秒时钟**，事件内无单调序号（SSE `id` 是排序友好的 ULID 风格，可用作去重键）。

---

## 附：fixture 清单

真实录制（OpenCode 1.18.25 + 本地 mock OpenAI 端点，Windows 11），详见 `packages/adapters/fixtures/opencode/README.md`：

```text
run-json/  s1-text / s2-write-allow / s3-write-ask-reject(+stderr) / s4-write-ask-auto
           s5-bash / s6-resume / s7-provider-error / session-list
server/    health / session-create / message-sync-response / sse-events(156条)
           event-permission-asked / session-diff / abort-response / message-list
```
