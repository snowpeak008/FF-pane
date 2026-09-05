# iFlow CLI 接入调研（T8.6b 前置调研单）

- **调研日期：** 2026-09-05
- **CLI 版本：** @iflow-ai/iflow-cli **0.5.19**（调研当日 npm latest；`npm view` 显示包最后更新 2026-05-12）
- **调研环境：** Windows 10 + PowerShell/cmd，Node v24.15.0
- **信息来源：** ① 本机真机运行（headless 全路径 + ACP 全路径，模型端为本仓库
  `fixtures/tools/fake-openai-server.mjs` 假服务端，口径同 grok-build 调研）；② 安装包 JS 源码
  （`bundle/iflow.js` 14MB 单包，esbuild 压缩，关键逻辑逐段提取核对）；③ npm README。
  官方 GitHub / platform.iflow.cn 文档在调研时段网络不可达，**未参考在线文档**——好在真机 +
  源码两条腿足以覆盖本单问题面。
- **认证限制声明：** 本机无 iFlow 账号（未 OAuth 登录、无 IFLOW_API_KEY）。真实 iFlow 后端
  行为（OAuth 流、真实模型、配额错误）未实测，逐项标注「待真机/待凭据」。CLI 侧行为
  （参数面、事件形态、审批、会话、ACP 协议往返、退出码）**全部真机实测**。
- **fixture：** `packages/adapters/fixtures/iflow/`（18 份，全部真机录制，性质说明见该目录 README）。

---

## 0. 一句话定位

iFlow CLI 是 **Gemini CLI 的早期 fork**（源码里 `GeminiClient`、`gemini.errors.*`、
`.geminiignore`、`GOOGLE_GENAI_USE_VERTEXAI` 等命名原样残留；settings 三层
System/User/Workspace 同款；工具名 `write_file`/`replace`/`run_shell_command` 同款），
但 fork 点早于 gemini-cli 0.5x 的 headless 大改造：**没有 `-o stream-json`、没有 `-o json`、
没有策略引擎、没有 Fatal 退出码族**。它自己的增量是：多模型市场（GLM/Qwen/Kimi/DeepSeek/
MiniMax）、OpenAI 兼容协议直连、以及一个**成熟度意外地高的 ACP 模式**（`--experimental-acp`，
权限转发/优雅取消/会话加载真机全通）。

**对适配器的决定性事实：headless 的 stdout 没有任何结构化事件**（纯模型文本 + 噪音行），
事件源只能走 ACP。这与 gemini-cli（stream-json 主路）和 qwen-code（stream-json + Claude 信封）
都不同，反而与 grok-build 的 ACP 路径（T8.5b）最像。

## 1. 安装方式与当前版本

```powershell
npm install -g @iflow-ai/iflow-cli   # 官方包名，已核实；本机安装耗时 17 分钟（227 包，网络慢）
iflow --version                      # → 0.5.19
```

- 入口 `iflow`（Windows 下 `%APPDATA%\npm\iflow.ps1` / `.cmd` 垫片 → `bundle/entry.js`，
  **npm 垫片形态**，杀进程须按进程树杀，同 gemini/qwen）。
- 附带 vendors/ripgrep 与 VS Code 扩展 vsix；无需本地编译链。
- 真机注意：`iflow --version` 输出版本号后曾观测到 libuv 断言崩溃
  （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 -1073740791 即 0xC0000409）。
  版本号本身已写完 stdout，探测逻辑应「读到版本号即成功」，不依赖退出码。

## 2. headless / 非交互模式参数

触发条件：`-p/--prompt` 或 stdin 为非 TTY。`iflow [query]` 位置参数等价 `-p`。

| 参数 | 说明 | 适配器相关性 |
|---|---|---|
| `-p, --prompt <text>` | 非交互模式 + 任务文本，可与 stdin 叠加 | 若走 headless 则核心；ACP 路径不用 |
| `-i, --prompt-interactive` | 执行后进交互模式 | 不用 |
| `-c, --continue` | 续接当前目录最近会话 | 不用（语义模糊，用 `-r`） |
| `-r, --resume <id>` | 恢复指定会话；**不带 ID 时弹交互式选择器**（headless 下勿裸传） | **核心**，真机实测可用 |
| `-m, --model <name>` | 模型 ID | Profile 模型映射 |
| `--yolo` / `--default` / `--plan` / `--autoEdit` | 审批模式四选一（**布尔旗形态**，非 gemini 的 `--approval-mode <枚举>`）；内部枚举 `default/smart/yolo/plan`，`--autoEdit` 映射 `smart` | **核心**，见 §3.3 |
| `--max-turns <n>` / `--max-tokens <n>` / `--timeout <秒>` | 轮数/token/时长三道预算护栏（gemini 没有后两个） | 成本护栏，建议接 |
| `-o, --output-file <path>` | **是输出文件不是输出格式**——把 Execution Info（会话 ID/轮数/token）写进文件 | 可用作会话 ID 的可靠取回通道（stdout 混噪音、stderr 是人读文本） |
| `--experimental-acp [--port <n>]` | ACP 模式（缺省 stdio，给 `--port` 走网络） | **适配器主路径**，见 §8 |
| `--include-directories <dirs>` | 工作区追加目录 | 可映射额外只读路径 |
| `--allowed-mcp-server-names <names>` | MCP 服务器白名单 | 配合 settings 注入 MCP 时用 |
| `--checkpointing` | 文件编辑检查点 | 暂不用 |
| `-s, --sandbox` / `--sandbox-image` | 容器沙箱（Docker/Podman） | 不用（依赖重，权限由 FF-pane 层负责） |
| `--stream` | 控制对模型后端的请求是否走 SSE 流式（**不是** stdout 输出格式开关） | 不用（保持默认） |
| `--telemetry*` 系列 | OpenTelemetry 遥测 | 不动（默认关） |
| `-d, --debug` | 调试日志 | 排障用 |

**没有的东西（与 gemini-cli 0.57 对照，逐项在 `--help` 与源码里核实为缺席）：**
`-o/--output-format`（stream-json/json）、`--approval-mode`、`--skip-trust`（信任机制存在但走
`~/.iflow/trustedWorkspaces.json`，headless 下实测未拦截）、`--session-id`（**无法预指定会话 ID**）、
`--policy`/`--admin-policy`、`--list-sessions`/`--delete-session`、`--raw-output`。

**退出码**（真机实测 + 源码核对，无 Fatal 错误码族）：

| 码 | 含义 | 实测 |
|---|---|---|
| 0 | 正常走完（**含审批拒绝空转轮**，见 §3.3） | ✔ |
| 1 | 认证未配置 / stdin 无输入 / 未知参数（yargs）/ 运行期致命错误（统一 `process.exit(1)`） | ✔ 前三种 |
| -1073740791 | libuv 断言崩溃（0xC0000409，退出期偶发） | ✔ `--version` 路径见过一次 |

适配器不得依赖细分退出码——**iFlow 的退出码只有 0/1 两档信息量**，成败判定必须靠事件
（ACP 的 stopReason）与产物核验。

## 3. headless 输出形态（为什么它当不了事件源）

### 3.1 stdout：纯文本混噪音

成功流实录（`real-headless-success.stdout.txt`）全文只有 4 行：

```text
Model ffpane-fixture-model does not support thinking mode   ← 每次模型调用一行（3 次调用 3 行）
Model ffpane-fixture-model does not support thinking mode
Model ffpane-fixture-model does not support thinking mode
I created hello.txt containing 'hello' and verified node -v prints v24.15.0.
```

模型文本、警告噪音混排，无 JSON、无事件边界、无工具调用痕迹。源码确认非交互路径的
`addItem` 只对少数类型加 `✗ Error:`/`ℹ`/`> ` 前缀，其余直接裸写 stdout。

### 3.2 stderr：Execution Info + 工具错误 + resume 提示

```text
Error executing tool write_file: Tool "write_file" not found in registry.   ← 工具错误（见 3.3）
ℹ️  Resuming session session-xxxx (6 messages loaded)                        ← resume 提示

<Execution Info>
{ "session-id": "session-e06bbd16-…", "conversation-id": "…",
  "assistantRounds": 3, "executionTimeMs": 3803,
  "tokenUsage": { "input": 812, "output": 45, "total": 857 } }
</Execution Info>
```

- **会话 ID 只在 stderr 的 Execution Info 里出现**（或 `--output-file` 的同构 JSON）。
  headless 若要拿 resume 凭据，唯一结构化通道是 `--output-file`。
- `terminationReason` 字段只在预算护栏触发时出现（`max_turns_exceeded` 等，源码确认）。

### 3.3 审批模式的真实行为（真机实测 + 源码）

- **非交互 `-p` 的缺省模式是 YOLO**（源码解析链：
  `n.prompt && !n.promptInteractive … ? dn.YOLO : dn.SMART`）。实测无 `--yolo` 时写文件、
  跑命令照样落地。**但这是隐式行为，适配器必须显式传 `--yolo`**，防上游改默认值。
- `--default` 与 `--plan` 在非交互下同形：CLI 把 `run_shell_command`/`replace`/`write_file`
  加进 `excludeTools` **从工具注册表里物理摘除**（plan 摘得更多，连 `multi_edit`/`web_fetch`
  的写侧也没了——dump 实测 plan 模式模型只见 10 个只读工具）。模型硬要调用时：
  - stderr：`Error executing tool write_file: Tool "write_file" not found in registry.`
  - 文件不落地；模型收到错误后口头收尾；**进程退出码 0**。
  「拒绝伪装成功」在 iFlow 上的形态 = **拒绝伪装成"工具不存在"且退 0**，比 gemini 的
  `permission_denied` 语义更含混（无法与真实的工具缺失区分）。
- headless 下没有任何审批事件与补批通道（同 gemini headless）。

### 3.4 结论

headless 模式六项能力里流式/文件事件/命令事件/权限转发/优雅取消**五项全无**，只配当
「降级兜底 + resume 载体」。适配器的事件源必须走 ACP（§8）。

## 4. 原生会话：保存与恢复

- **自动保存**：每轮（含 headless、含强杀中断轮）落盘
  `$IFLOW_HOME/projects/<编码后的cwd>/session-<uuid>.jsonl`（cwd 编码形如
  `-C-Users-USER-AppData-Local-Temp-…`，**按 cwd 分桶**）。
- 会话文件是 **Claude Code 风格 JSONL**（`uuid`/`parentUuid`/`sessionId`/`type`/`message`，
  含 tool_use/tool_result 块），与 gemini 的会话格式不同源。样例 `real-session-storage.jsonl`。
- **恢复**：`iflow -r <sessionId> -p "…"`。真机实测：stderr 报
  `Resuming session <id> (6 messages loaded)`，Execution Info 的 session-id 与首轮**完全一致**；
  假服务端 dump 证实模型收到的请求带首轮全部上下文（2 次工具调用与结果俱在）——恢复是真恢复。
- **无 `--session-id`**：会话 ID 由 CLI 生成（`session-<uuid>` 格式），FF-pane 只能事后取
  （ACP：session/new 响应即得；headless：`--output-file`）。**中断轮拿不到 ID 的风险仅存在于
  headless**（ACP 开轮即得，同 grok ACP 的优势）。
- **强杀后可恢复**：轮次进行中 taskkill /T /F，会话文件已含用户输入行，`-r` 可续（真机实测）。
- **ACP 与 headless 读写同一份会话存储**：headless 建的会话，ACP `session/load` 加载成功
  （真机实测，`real-acp-load.wire.jsonl`）——两模式会话互通，降级不损失续接。
- 未见保留天数/自动清理逻辑（gemini 的 30 天 sessionRetention 未随 fork 带入 0.5.19）。

## 5. 认证方式

### 5.1 认证类型（源码枚举 `Kt`）

| selectedType 值 | 含义 | headless 可用性 |
|---|---|---|
| `oauth-iflow` | iFlow 账号 OAuth（浏览器登录，凭证 CLI 自管） | 已有登录态可用；无法非交互发起。**待真机**（本机无账号） |
| `iflow` | iFlow API key（`apiKey` 直连 `https://apis.iflow.cn/v1`） | ✔（环境变量或 settings） |
| `openai-compatible` | 任意 OpenAI 兼容端点（`apiKey`+`baseUrl`+`modelName` 三件套） | ✔ **fixture 录制走的就是它** |
| `oauth-aone` / `aone` / `idealab` | 阿里内部（ducky.code.alibaba-inc.com / idealab） | 不适用本产品 |
| `cloud-shell` | 云环境 | 不适用 |

### 5.2 ⚠️ 日期开关：2026-04-16 起旧认证类型被硬性废止

源码原文（变量名反混淆后）：

```js
const cutoff = new Date("2026-04-16T16:00:00.000Z");
const validateAuthMethod = (t) =>
  Date.now() >= cutoff.getTime()
    ? (t === OPENAI_COMPATIBLE || t === CLOUD_SHELL ? null
       : "Auth method has been deprecated. Please reconfigure with OpenAI Compatible API.")
    : /* 旧逻辑：LOGIN_WITH_IFLOW / IFLOW / AONE / OPENAI_COMPATIBLE 均合法 */;
```

**今天（2026-09-05）已过开关日**：0.5.19 下 `iflow`（API key）与 `oauth-iflow` 类型在启动
校验即被拒（真机实测：设了 `IFLOW_API_KEY` 环境变量反而报 deprecated 退 1）。
**唯一可用的 headless 认证类型是 `openai-compatible`**。矛盾点：ACP initialize 的
authMethods 仍列出三种（含 oauth-iflow），且此校验只在 headless 启动路径调用——
oauth 登录态是否真的不可用**待真机**（需有账号的机器验证）。适配器按「只支持
openai-compatible」设计即可覆盖 iFlow 官方后端（它本来就是 OpenAI 兼容协议，
`baseUrl=https://apis.iflow.cn/v1`）。

### 5.3 ⚠️ 环境变量名的坑：错误提示撒谎

未认证时错误提示说可以设 `apiKey, APIKEY, API_KEY, api_key / baseUrl…`，**照做无效**。
源码 `CT()` 实际查找顺序：`IFLOW_<驼峰>` → `IFLOW_<大写下划线>` → `iflow_<驼峰>` →
`iflow_<大写下划线>`，即必须是 **`IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME`**
（或 `IFLOW_MODEL`/`IFLOW_URL` 别名）。且环境变量存在时 authType 被推成 `iflow` 类型——
撞上 §5.2 的日期开关直接 deprecated。**结论：环境变量认证这条路在 0.5.19 已死**，
可靠路径只有 settings.json 写 `selectedAuthType: "openai-compatible"` + 三件套。

### 5.4 settings 的层级与注入路径（实测踩通）

- settings 三层：System（`C:\ProgramData\iflow-cli\settings.json` /
  `IFLOW_CLI_SYSTEM_SETTINGS_PATH`）→ User（**恒为 `os.homedir()/.iflow/settings.json`**，
  ⚠️ **不受 `IFLOW_HOME` 影响**——`IFLOW_HOME` 只重定向数据目录 projects/log/cache）
  → Workspace（`<cwd>/.iflow/settings.json`）。
- **适配器推荐注入路径**：受管临时 HOME 不可行（settings 不跟 IFLOW_HOME 走），
  写用户全局 settings 违反红线；**Workspace 层 settings 也违反「不在用户仓库留残留」**。
  两难的干净解法：**Node `os.homedir()` 尊重 `USERPROFILE`（Windows）/ `HOME`（POSIX）**，
  spawn 时替换该变量指向 FF-pane 受管目录，即可同时重定向 settings 与数据目录，
  用户真实 HOME 分毫不动。代价与 grok 调研 §7.4 的 GROK_HOME 同性质（登录态隔离、
  会话不与用户终端互通），但 iFlow 的 cli_login 路线本就近乎不可用（§5.2），代价可接受。
  **此方案在本单未实测，列为实现单第一个待验证项**（fixture 录制时用的是
  「录制目录 = 临时目录，workspace settings 落在临时目录」的等效路径，不落用户仓库）。
- settings 值支持 `$VAR`/`${VAR}` 环境变量展开（源码 `rnu()`），
  可写 `"apiKey": "$FFPANE_IFLOW_KEY"` 让密钥仍走 env 下发，不明文落盘——符合 §4.3 红线。
- `.env` 自动加载：cwd 向上找 `.iflow/.env` → `.env`，最后回退 `~/.iflow/.env` → `~/.env`。
  **env 清洗时注意**：用户仓库里的 `.env` 会被 CLI 静默吃进来（同 aider 的 dotenv 劫持问题）。

### 5.5 需要清洗的环境变量面

| 变量 | 理由 |
|---|---|
| `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_URL`（含 `iflow_` 小写形态） | 用户 shell 残留会推翻 Run 的认证配置（§5.3 的 CT() 四形态都认） |
| `IFLOW_HOME` / `IFLOW_CONFIG_DIR` | 数据目录劫持 |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_GCA` / `GOOGLE_CLOUD_PROJECT` | fork 残留代码仍会读（cloud-shell/vertex 分支） |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 源码有引用点（兼容分支），防歧义一并剥 |
| `CLI_TITLE`、`IFLOW_CLI_NO_RELAUNCH` | 行为开关，防用户环境干扰 |

## 6. 取消方式

- headless：非 TTY 下无取消监听，**唯一手段杀进程树**（npm 垫片，务必 `/T`）。
  强杀实测：stdout 停在噪音行，无终止事件，stderr 空；会话文件已落可 `-r` 续
  （`real-killed.stdout.txt`）。
- **ACP：协议级优雅取消实测成立**——`session/cancel` 通知后 prompt 响应
  `stopReason: "cancelled"`（`real-acp-cancel.wire.jsonl`）。树杀降为兜底。

## 7. 六项能力声明核对（设计文档 §5.1）

按传输模式条件式给出（同 grok T8.5b 款式）。**ACP 为主路径**：

| # | 能力 | ACP 模式 | headless 模式 | 依据 |
|---|---|---|---|---|
| 1 | 原生会话恢复 | **是** | **是** | ACP session/load 真机实测；headless `-r` 真机实测；两模式互通（§4）。限制：绑定 cwd；无法预指定 ID |
| 2 | 流式输出 | **部分（待真机）** | **否** | ACP 有 `agent_message_chunk` 事件形态；但假模型下单 chunk 整块到达，**真增量未证实**（真实后端 SSE 下的片段化待录）。headless stdout 是文本直写无事件边界 |
| 3 | 文件修改事件 | **是** | **否** | ACP `tool_call_update` 的 `content[].type:"diff"` 同时给 oldText/newText **和** `fileDiff` 统一 diff 文本（比 grok 还多一份现成 diff，§8.3）。headless 无事件 |
| 4 | 命令执行事件 | **部分** | **否** | ACP tool_call_update 给命令原文（rawInput 语义在 `args`）与输出文本，**无结构化退出码字段**（与 gemini/qwen 同评级，比 grok 的 rawOutput.exit_code 差） |
| 5 | 权限请求转发 | **是** | **否** | ACP `session/request_permission` 请求/回执闭环真机实测（allow 落地 / reject 吞掉工具，§8.4）。headless 是"从注册表摘工具"，无事件无补批 |
| 6 | 中途取消 | **是** | **部分** | ACP session/cancel → stopReason=cancelled 真机实测。headless 只能树杀（会话可续） |

**MCP 注入 = 待裁定**：ACP `session/new` 接受 `mcpServers` 参数（本单传空数组通过），
注入形状与语义未实测；headless 只有 settings/`--allowed-mcp-server-names` 路径（写盘，违红线）。
比 grok（完全没有逐轮注入参数）乐观，留给实现单验证。

## 8. ACP 模式实测记录（`--experimental-acp`）

### 8.1 通道与握手

- 启动：`iflow --experimental-acp`（stdio；给 `--port` 转 WebSocket/网络模式，本单未测网络形态）。
- stdout 首行有非 JSON banner（`[iFlow ACP Agent] ACP adapter factory initialized`），
  **JSON-RPC 解析必须容忍非 JSON 行**（T8.5a 协议层已有此纪律）。
- initialize 响应：`protocolVersion: 1`、`isAuthenticated`（布尔，**开箱即知有无登录态**，
  比 grok 的"等 session/new 报 -32000"友好）、`authMethods` 三项、
  `agentCapabilities.loadSession: true`、`promptCapabilities`（image/embeddedContext true）。
- 未认证时 `session/new` → `-32000 Authentication required`（`real-acp-noauth.wire.jsonl`）。

### 8.2 session/new 的高信息量响应

响应携带（`real-acp-success.wire.jsonl` 第 5 行）：
- `sessionId`（开轮即得，headless 的"中断轮丢 ID"问题在 ACP 不存在）；
- `modes`：`currentModeId` + availableModes（smart/yolo/default/plan）。
  **⚠️ 默认 currentModeId 是 `yolo`**——要走权限转发必须先 `session/set_mode` 切 `default`
  （实测切换成功，响应 `{success:true, currentModeId:"default"}`）；
- `_meta.models`：当前模型 + 可用模型清单（含 thinking 能力位）——**模型枚举的现成来源**；
- `_meta.availableCommands` / `availableAgents` / `availableSkills` / `availableMcpServers`。

### 8.3 事件形态（session/update 通知）

| sessionUpdate | 载荷要点 |
|---|---|
| `available_commands_update` | 每次 prompt 前发一遍（同 grok 的 available_commands 噪音，映射为 raw） |
| `agent_message_chunk` | `content: {type:"text", text}`（片段化程度待真机） |
| `tool_call` | `toolCallId`、`toolName`、`status:"pending"`、`title`、`kind`（edit/execute/…）。**顶层直接带 toolName/kind**（grok ACP 藏在 `_meta["x.ai/tool"]`，iFlow 更干净） |
| `tool_call_update` | `status: in_progress → completed`；写文件完成帧 `content[].type:"diff"` 带 `path`/`oldText`/`newText`/`args`（完整入参）/`fileDiff`（**现成统一 diff 文本**）；命令完成帧 `content[].content.text` 是输出文本 |
| （权限） | `session/request_permission` 是**带 id 的请求**而非通知：`options`（optionId: proceed_always/proceed_once/cancel；kind: allow_always/allow_once/reject_once）+ `toolCall`（含 diff 预览）。客户端回 `{outcome:{outcome:"selected", optionId}}` |

- prompt 响应：`{stopReason: "end_turn" | "cancelled"}`。**拒绝审批后 stopReason 仍是
  end_turn**（工具被静默吞掉、无 failed 事件）——「其实没执行」要靠"request_permission
  出现过但没有对应 tool_call 落地"来判定，或对照产物核验。这与 grok 的
  「failed + User rejected 文本」不同，**是 iFlow 特有的坑**（§9 坑 2）。
- 命令工具的 `title` 含 cwd 描述文本（`node -v [current working directory C:\…]`），
  是给人看的，解析以 `args.command` 为准。

### 8.4 权限往返实测（default 模式）

- allow（proceed_once）：工具照常执行，文件落地（`real-acp-permission-allow.wire.jsonl`）。
- reject（cancel/reject_once）：文件不落地，**无任何 tool_call/tool_call_update 事件**，
  模型直接收尾，end_turn（`real-acp-permission-reject.wire.jsonl`）。
- `proceed_always`（allow_always）**勿选**——会话级豁免，纪律同 grok（恒选 `*_once` 类）。

## 9. 适配器实现建议

### 9.1 实现路径：ACP 首选 + headless 降级（与 grok T8.5b 同构）

- **不复用 gemini-cli 适配器的 stream-json 映射器**——iFlow 没有 stream-json，两者除了
  工具名几乎无共享面。共享的应是：**T8.5a 的 `packages/adapters/src/acp/` 协议层**
  （JSON-RPC 客户端、非 JSON 行容忍、请求/通知分发）+ 进程模块 + `findExecutableOnWindowsPath`。
- 结构建议照抄 `grok-build/`：`adapter.ts`（双模式门面 + 条件能力声明）+ `acp-turn.ts` +
  headless 降级 turn + mapper。差异点：
  - iFlow ACP 的 toolName/kind 在顶层（无 `_meta["x.ai/tool"]` 逆投影需求）；
  - diff 直接有 `fileDiff` 统一 diff 文本，`FileChangeEvent.diff` 不用自己渲染
    （oldText/newText 仍在，可作校验）;
  - 权限拒绝无 failed 事件（坑 2 的判定逻辑是新写的）。
- **检测/降级**：与 grok 同款——auto 模式首轮 initialize 握手失败即降级 headless 重跑；
  但注意 iFlow 的 `--experimental-acp` 带 experimental 前缀，**版本漂移风险更高**，
  降级链必须真实可用（headless 虽无事件，跑完后靠 git 快照补 file_change、
  `--output-file` 取会话 ID，能力声明如实降级）。

### 9.2 启动命令模板

```powershell
# ACP 主路径（Worker：进 session 后不切模式=yolo，或切 default 走逐次审批）
iflow --experimental-acp     # spawn cwd = 项目目录；session/new 传 cwd + mcpServers
# Planner/Reviewer：session/set_mode → plan

# headless 降级（Worker）
iflow -p "<任务文本>" --yolo --max-turns <n> --output-file <临时路径> [-m <model>]
# 恢复
iflow -r <sessionId> -p "<后续>" --yolo --output-file <临时路径>
```

- 认证注入：受管 HOME（替换 `USERPROFILE`/`HOME`）下写 `settings.json`
  （`selectedAuthType: "openai-compatible"` + `"apiKey": "$FFPANE_IFLOW_KEY"` 环境变量展开），
  密钥经 env 下发不落盘。**此方案待实现单验证**（§5.4）。
- env 清洗清单见 §5.5；`stripApiKeyEnv` 机制沿用。

### 9.3 已识别的坑（按严重度排序）

1. **headless 拒绝伪装成"工具不存在"且退 0**（§3.3）。降级模式下不能以退出码判成败，
   必须产物核验（git 快照对照）；stderr 的 `not found in registry` 文本可作 denial 标记，
   但它与真实的工具缺失同形，只能记 warning 级证据。
2. **ACP 审批拒绝无 failed 事件**（§8.4）。判定"这轮其实没干活"须由权限桥自己记账：
   request_permission 被拒 N 次 + 零 tool_call 完成帧 → 该轮记 denied/blocked，
   不能等 CLI 给信号（它只会 end_turn）。
3. **认证日期开关**（§5.2）：2026-04-16 后仅 openai-compatible 可用，且错误提示的
   环境变量写法是错的（§5.3）。适配器的认证探测直接按 settings 三件套设计；
   `iflow`/`oauth-iflow` 类型的行为如上游修复再跟进。
4. **无 `--session-id`**：会话 ID 取回依赖 ACP session/new 响应（主路径没问题）或
   headless `--output-file`（降级路径）。`NativeSessionBinding` 登记时机在轮初（ACP）/
   轮末（headless），装配层要兼容两种时序。
5. **settings 不跟 `IFLOW_HOME` 走**（§5.4）：数据目录与配置目录是两套解析。
   受管隔离必须换 `USERPROFILE`/`HOME`，只设 IFLOW_HOME 会漏 settings 与信任配置。
6. **stdout 有非 JSON banner + 噪音行**：ACP 解析容忍非 JSON 行；headless 的
   "does not support thinking mode" 每次模型调用刷一行，聚合文本时照单全收即可（是 stdout 不是 stderr）。
7. **`-r` 不带 ID 弹交互选择器**：headless 装配时恒带 ID，缺 ID 就不传 `-r`。
8. **`--version` 退出期偶发 libuv 崩溃**（§1）：探测逻辑读到版本号即成功。
9. **用户仓库 `.env` 会被静默加载**（§5.4）：受管 HOME + env 清洗后影响面收窄，
   但 `IFLOW_*` 值仍可能从项目 `.env` 进来，实现单应实测一次劫持路径（同 aider 的教训）。
10. **每轮多次模型调用**：假服务端计数显示一轮 3 次 assistant 调用（工具循环各一次），
    未见 grok 那种标题/仪表盘旁路调用；`assistantRounds` 计的是模型调用数不是"轮"。

---

## 10. 给实现单（T8.6b 实现）的交接清单

### 10.1 建议的实现路径

- **ACP 首选 + headless 降级**，复用 `src/acp/` 协议层与 grok-build 的双模式门面结构（§9.1）。
  与 gemini-cli 适配器**无共享映射器**（协议形态完全不同），不要试图抽 gemini 系共享模块——
  iFlow 与 qwen-code（Claude 信封 stream-json）、gemini-cli（扁平 stream-json）三家三种协议，
  「同为 Gemini fork」只剩工具名与 settings 结构两处相似。
- 能力声明按 §7 的双模式表条件式给出，streaming 在真机验证前如实报 "partial"。

### 10.2 能力六项预判（依据见 §7）

ACP：resume 是 / streaming 部分（待真机）/ file_change 是 / command 部分 / 权限转发 是 / 取消 是。
headless：是 / 否 / 否 / 否 / 否 / 部分。

### 10.3 装配注意点

- 认证：Provider 类型只做 `api_key`（openai-compatible 三件套，密钥 env 展开）；
  `cli_login` 暂不做（§5.2 待真机裁定后再议）。
- 受管 HOME 方案（替换 USERPROFILE/HOME）先写一个隔离核查测试再接线（§5.4、坑 5/9）。
- 权限桥：request_permission 恒选 `*_once`；拒绝记账逻辑独立实现（坑 2）。
- env 清洗白名单照 §5.5；`--max-turns`/`--max-tokens`/`--timeout` 三护栏建议从任务合同透传。
- 版本探测：`iflow --version` 读 stdout 不信退出码（坑 8）。

### 10.4 待真机 / 待凭据项（逐项登记）

| 项 | 需要什么 | 验证点 |
|---|---|---|
| ACP streaming 片段化 | iFlow 账号或真实 OpenAI 兼容后端（流式） | agent_message_chunk 是否真增量；thought/plan 类事件是否存在 |
| oauth-iflow 登录态在 0.5.19 的实际可用性 | iFlow 账号 | §5.2 日期开关是否拦 OAuth；ACP authenticate 方法的行为 |
| ACP session/new 的 mcpServers 注入 | 无需凭据（本地假 MCP server 即可） | 形状、工具可见性、availableMcpServers 回显 |
| 受管 HOME（USERPROFILE 替换）方案 | 无需凭据 | settings/数据目录/信任配置是否全部跟走；用户 ~/.iflow 零触碰 |
| 真实后端错误形态 | iFlow 账号 | 配额/限流/无效 key 的 stdout/stderr/退出码；Execution Info 是否仍在 |
| `--experimental-acp --port` 网络模式 | 无需凭据 | 是否 WebSocket；stdio 不可用时的备选 |
| 项目 `.env` 劫持路径 | 无需凭据 | 仓库内 `.env` 写 IFLOW_* 时受管 Run 是否被改写 |

### 10.5 fixture 清单（`packages/adapters/fixtures/iflow/`，18 份）

headless 8 组：success（stdout/stderr/execinfo）、plan-deny（stdout/stderr）、noauth、
resume（stdout/stderr）、killed、version、help、session-storage。
ACP wire 6 份：success / permission-allow / permission-reject / cancel / load / noauth。
全部真机录制；模型端为假服务端（口径同 grok fixtures，README 有逐份说明与复现命令）。

---

## 11. 实现状态（T8.6b 实现单回填，2026-09-05）

调研的**预判几乎全部被实测证实**，仅两处措辞收紧、无一处推翻。实现落点：
`src/iflow/{command,mapper,acp-turn,adapter,index}.ts`（5 文件）、装配四处、
`scripts/live-iflow.mjs`、`tests/iflow.test.ts`。

### 11.1 待验证项逐条结论（对照 §10.4）

| 项 | 调研态度 | 实现单实测结论 |
|---|---|---|
| **受管 HOME（USERPROFILE 替换）方案** | §5.4 列为「第一个待验证项」，未实测 | ✅ **成立**。spawn 时 `USERPROFILE`+`HOME` 双替换（Windows os.homedir() 读前者，双设跨平台稳），实测 settings / `projects` 会话存储 / `cache` / `log` / `config` **全部跟走**受管目录，用户真实 `~/.iflow` 零触碰（headless 与 ACP 双路各测一次）。**受管 settings 收窄为一行静态常量**：只写 `{"selectedAuthType":"openai-compatible"}`，三件套（apiKey/baseUrl/modelName）全走 env——实测「最小 settings + 纯 IFLOW_ 前缀 env 三件套」headless 与 ACP 双路都能起来并成功调模型，密钥零落盘（§4.3）。比调研设想的「settings 写 `$VAR` 展开」更干净：连 `$VAR` 占位都不需要，settings 是无敏感值的静态文件、无按轮写盘竞态。 |
| **项目 `.env` 劫持路径** | §5.4 坑 9，「实现单应实测一次」 | ✅ **实测复现且已防住**。仓库根放 `.env`（`IFLOW_API_KEY`/`IFLOW_MODEL_NAME`/`IFLOW_BASE_URL`）后受管 Run 被静默改写（headless 模型端收到劫持值；**连 `-m` 命令行参数都被 `.env` 压过**——命令行优先级低于 dotenv，这是「弃用 `-m`、模型走 env 预占」决策的直接依据）。防线：CLI 的 dotenv **不覆盖已存在的 env**（实测），三件套经 ctx.env + 模型经 `IFLOW_MODEL_NAME` 预占即全部免疫；叠加 `process/env.ts` 的 `/^IFLOW_/i` 全前缀清洗，双层兜住。 |
| **oauth-iflow 登录态可用性** | §5.2 待真机 | 未验（本机无账号，与调研同）。适配器按「只 openai-compatible」设计，覆盖 iFlow 官方后端；日期开关后 oauth 本就近乎不可用，受管 HOME 无登录态的代价为零。 |
| ACP streaming 片段化 / mcpServers 注入 / 网络模式 / 真实后端错误 | §10.4 待真机/待凭据 | 维持待验：streaming 如实报 **partial**（假模型端单 chunk 整块到达，真增量未证实）；mcpServers 本单传空数组（未接注入）；`--port` 网络模式未用（stdio 唯一验证通道）。 |

### 11.2 通道决策：ACP 单通道（两案对比）

**选 ACP 单通道 + 起不来 end(failed) 如实收尾**（opencode 款式），弃「ACP 首选 +
headless 降级」（grok 款式）。理由：grok 的降级成立是因其 headless streaming-json
与 ACP 是同一份事件词汇的两个投影（仅权限/取消降档）；iFlow 的 headless 六项能力
里流式/文件事件/命令事件/权限转发/优雅取消**五项全无**（§3.4），降级轮产不出 Run
要的任何证据——「跑完靠 git 快照补 file_change、`--output-file` 取会话 ID」凑出的
是证据质量断崖的黑箱轮次，且能力声明须切到几乎全 no，那不是兜底而是把失败伪装成
低质量成功。失败就如实失败。`--experimental-acp` 的 experimental 前缀漂移风险登记
§4.5——对策是跟版本，不是预建假降级链。决策落 `adapter.ts` 头注。

### 11.3 特有坑的防线落点

- **审批拒绝无 failed 事件**（§8.4 / §9.3 坑 2，本适配器最要紧）：实测复现——拒绝
  后 iFlow 静默吞工具，wire 上零 tool_call、prompt 照样 `end_turn`。防线：权限桥
  在**回执 deny 的当场**由 `mapper.registerDenied()` 从权限请求的 toolCall 明细
  合成 `status="denied"` 的动作事件 + 记阻断清单；`end_turn` 到达时阻断非空即改判
  `failed`（`acp-turn.ts` onPermissionRequest / `mapper.ts` registerPromptEnd）。
  单测（reject fixture 回放）与 live R2 各自钉住：denied 事件出现 + 整轮 failed +
  文件真的没落地。
- **默认 currentModeId=yolo**（§8.2）：session/new 默认全放行——开轮后**恒
  `session/set_mode` 切 default**（或 plan），切失败即本轮 fail-closed 失败、prompt
  不发（绝不带 yolo 跑）。为此给 T8.5a 协议层补了 `session/set_mode` 出口
  （`AcpConnection.setMode`，schema SetSessionModeRequest）。
- **权限请求 toolCall 不带 args**：命令类的命令原文只在 `title`
  （`node -v [current working directory …] (desc)`），`commandFromIFlowTitle()`
  剥 cwd 描述后缀得到原文。
- **initialize 参数校验更严**：iFlow 的 zod 校验要求 `clientCapabilities` 字段
  **必须存在**（缺席回 -32602），规范里它本可缺省——initialize 恒带
  `IFLOW_ACP_CLIENT_CAPABILITIES`（全 false）。
- **未认证两道闸**：initialize 的 `isAuthenticated:false` 当场收（开箱即知）；
  万一撒谎，session/new 的 -32000 兜底。**不做 authenticate 重试**（三种 authMethods
  没有一条 headless 走得通，§5.1/§5.2）。
- 非 JSON banner 行（`[iFlow ACP Agent] …`）经 T8.5a 协议层诊断通道留档，不断流。

### 11.4 能力六项最终声明

ACP 单通道：nativeResume **yes** / streaming **partial**（真增量待真机）/
fileChangeEvents **yes**（fileDiff 现成统一 diff）/ commandEvents **partial**
（无结构化退出码）/ permissionForwarding **yes** / gracefulCancel **yes**。
与 §7 的 ACP 列一致，streaming 按 T7.3a 纪律（与实测一致）如实报 partial。

### 11.5 一处措辞收紧

§8.3 表格「chunk 的片段化程度待真机」——实现单实测假模型端下 `agent_message_chunk`
**单块整条到达**（未切片），mapper 仍按追加语义处理 + finalize 补 final 收尾，
真增量的验证归待真机项（与能力声明 partial 一致）。此外无预判被推翻。
