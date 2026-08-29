# Codex CLI 适配器调研（T2.0）

- **调研版本：** codex-cli 0.147.0（Windows 11）
- **调研日期：** 2026-08-29
- **调研方式：** 真机运行 + 官方源码（openai/codex `codex-rs/exec/src/exec_events.rs`）核对
- **fixture：** `packages/adapters/fixtures/codex/`（全部真机录制，见该目录 README）

---

## 1. Headless / 非交互模式

### 1.1 启动命令

```text
codex exec [OPTIONS] [PROMPT]
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
```

- PROMPT 可作参数传入；不传或传 `-` 时从 stdin 读取。若 stdin 被管道占用且又给了参数 PROMPT，stdin 内容会以 `<stdin>` 块追加（适配器 spawn 时应显式关闭/重定向 stdin，避免挂起或意外追加）。
- 一次 `codex exec` 进程 = 一个 turn（一问一答到底）。**没有常驻进程 + 多轮输入的模式**；多轮会话靠反复 spawn `codex exec resume <thread_id> <新提示词>` 实现。

### 1.2 关键参数（0.147.0 实测存在）

| 参数 | 作用 | 适配器用法 |
|---|---|---|
| `--json` | stdout 变为 JSONL 事件流 | 必开 |
| `-C, --cd <DIR>` | 指定 Agent 工作根目录 | 必开，指向项目目录 |
| `--skip-git-repo-check` | 允许在非 git 目录运行 | 建议常开（否则非 git 目录直接拒绝启动） |
| `-s, --sandbox <MODE>` | 沙箱策略：`read-only` / `workspace-write` / `danger-full-access` | 见 §7 风险 1 |
| `--dangerously-bypass-approvals-and-sandbox` | 跳过全部审批与沙箱 | Windows 沙箱不可用时的现实选项，须配合 FF-pane 自己的权限层 |
| `-a, --ask-for-approval <POLICY>` | 审批策略 `untrusted/on-request/never` | **只在交互模式存在，`codex exec` 无此参数**（headless 无人可问） |
| `--approve-for-me` | 审批请求交给自动审查（workspace-write 沙箱） | 可选 |
| `-m, --model <MODEL>` | 指定模型 | 成本控制 |
| `-c key=value` | 覆盖任意 config.toml 配置，如 `-c model_reasoning_effort="low"` | 成本控制、行为微调 |
| `-p, --profile <NAME>` | 叠加 `$CODEX_HOME/<name>.config.toml` | 可用于隔离 FF-pane 专属配置 |
| `--add-dir <DIR>` | 主工作目录之外的额外可写目录 | 对应任务合同 write_scope 多路径 |
| `-o, --output-last-message <FILE>` | 最终消息另存文件 | 可作 Worker 报告的兜底采集 |
| `--output-schema <FILE>` | 用 JSON Schema 约束最终回复结构 | 可让 Worker 报告/澄清请求输出结构化 JSON，值得利用 |
| `--ephemeral` | 不落盘会话文件 | **勿用**：用了就无法 resume |
| `--ignore-user-config` | 不加载用户 config.toml（auth 仍用 CODEX_HOME） | 可选，隔离用户个人配置对 Run 的干扰 |
| `-i, --image <FILE>` | 附图 | 暂不需要 |
| 环境变量 `CODEX_HOME` | 重定向整个数据目录（配置、auth、会话） | 注意：指向 %TEMP% 下会告警拒建 helper 二进制 |

### 1.3 退出码（实测）

- 正常完成（即使任务内容失败）：0
- turn.failed（如认证失败）：1
- 被强杀：由 kill 方式决定，无固定值

---

## 2. 事件流格式（`--json` JSONL）

每行一个 JSON 对象，顶层 `type` 字段。stdout 只有事件流，日志走 stderr，天然分离。

顶层事件 8 种（源码 `ThreadEvent` 枚举）：

| type | 时机 | 载荷 |
|---|---|---|
| `thread.started` | 首个事件 | `thread_id`（即会话 ID，resume 用） |
| `turn.started` | 提示词开始处理 | 空 |
| `turn.completed` | turn 正常结束 | `usage`：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens` |
| `turn.failed` | turn 失败 | `error.message` |
| `item.started` | 新条目进入 in_progress | `item` |
| `item.updated` | 条目更新（主要是 todo_list） | `item` |
| `item.completed` | 条目到达终态（成功或失败都走这个） | `item` |
| `error` | 流级非致命/致命错误（重试提示等） | `message` |

`item` 结构：`{ id, type, ...类型专有字段 }`。item 的 `type` 共 9 种（源码 `ThreadItemDetails`）：

### 2.1 `agent_message`（只出现在 item.completed）

```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Created hello.txt containing exactly `hello`."}}
```

**整条消息一次性到达，流中没有 token 级增量**（实测多次运行均无 delta 事件，`exec --help` 也无相关开关）。

### 2.2 `reasoning`（只出现在 item.completed，开启推理摘要时才有）

```json
{"type":"item.completed","item":{"id":"item_x","type":"reasoning","text":"..."}}
```

### 2.3 `file_change`（item.started → item.completed）

```json
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"C:\\Users\\USER\\...\\hello.txt","kind":"add"}],"status":"completed"}}
```

- `changes[].kind`：`add` / `update` / `delete`；`status`：`in_progress` / `completed` / `failed`
- **只有路径和变更类型，没有 diff 正文**（见 §7 风险 2）

### 2.4 `command_execution`（item.started → item.completed）

```json
{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"\"C:\\\\...\\powershell.exe\" -Command ...","aggregated_output":"68656c6c6f\r\n","exit_code":0,"status":"completed"}}
```

- `status`：`in_progress` / `completed` / `failed` / **`declined`**（命令被沙箱/审批拒绝）
- 沙箱层报错时 `exit_code` 可为 `-1`，错误文本塞进 `aggregated_output`
- Windows 下命令是完整 powershell.exe 调用串；`aggregated_output` 可能含本地化（中文）文本

### 2.5 `mcp_tool_call` / `web_search` / `todo_list` / `collab_tool_call` / `error`

- `mcp_tool_call`：`{server, tool, arguments, result, error, status}`
- `web_search`：`{id, query, action}`，只出 item.completed
- `todo_list`：`{items:[{text, completed}]}`，是 `item.updated` 的主要来源
- `error`（item 级）：`{message}`，非致命错误，如传输层降级：

```json
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 ..."}}
```

### 2.6 真实样例对照

| 场景 | fixture |
|---|---|
| 成功全流程 | `exec-basic.jsonl` |
| 原生恢复 | `exec-resume.jsonl` |
| Windows 沙箱失败 | `exec-sandbox-error-win.jsonl` |
| 强杀截断 | `exec-killed.jsonl` |
| 杀后恢复 | `exec-resume-after-kill.jsonl` |
| 未登录 401 → turn.failed | `exec-error-auth.jsonl` |

---

## 3. 原生会话与恢复

- **会话 ID 获取**：首个事件 `thread.started` 的 `thread_id`（UUIDv7）。这是唯一需要登记的 Native Session ID。
- **恢复命令**：`codex exec resume <thread_id> --json "<新提示词>"`；也有 `--last`（取最近会话，默认按 cwd 过滤，`--all` 取消过滤）。适配器应只用显式 UUID，不依赖 `--last`。
- **实测行为**：resume 后 `thread.started` 返回**同一个 thread_id**；上下文完整（模型不重新探查即知道之前建的文件内容）；**被强杀的会话也能正常 resume**（rollout 文件逐事件落盘，杀进程不丢已完成部分）。
- **存储位置**：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时间戳>-<thread_id>.jsonl`（默认 `~/.codex/`），另有 `session_index.jsonl` 索引与 `archived_sessions/`。
- **限制**：
  - `--ephemeral` 运行的会话无法恢复；
  - 会话文件在本机 CODEX_HOME 内，跨机器不可迁移（正好符合设计文档"会话归 Agent 自己，工作台只登记 ID"的原则）；
  - `exec resume` 没有 `-s/--sandbox` 参数，沙箱策略需用 `-c sandbox_mode=...` 或 bypass 参数重新指定，**不自动继承首次运行的命令行参数**；
  - 交互版另有 `codex resume` / `codex fork`（分叉会话），exec 侧只有 resume。

---

## 4. 取消方式

- **无协议级优雅取消**：headless 进程没有接受取消指令的 stdin 协议；Windows 下向无窗口子进程发 Ctrl+C 不可靠。
- **现实做法：杀进程树**。实测 codex.exe 会派生多级子进程（launcher → 实际 codex → PowerShell 命令子进程），必须整树终止（`taskkill /T /F` 或 Node 侧按 pid 树杀），否则残留模型请求进程。
- **杀后行为（实测）**：stdout 事件流直接截断（停在最后一个已 flush 的事件），**不会出现 turn.completed / turn.failed**；退出后 rollout 文件保留全部已完成事件，会话可 resume。
- 适配器判定：进程退出且未收到 `turn.completed`/`turn.failed` → 主动取消则标记 `cancelled`，否则 `crashed`。

---

## 5. 认证方式

- **登录态位置**：`$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），顶层字段实测为 `auth_mode`、`OPENAI_API_KEY`、`tokens`、`last_refresh`。ChatGPT 订阅登录时 `tokens` 存 OAuth token（CLI 自动刷新）。
- **API key 模式**：`codex login --with-api-key`（key 从 stdin 读入，写进 auth.json）。另有 `--with-access-token`、`--device-auth`。
- **实测：仅设置环境变量 `OPENAI_API_KEY` 不构成登录态**（0.147.0 中 `codex login status` 仍报 Not logged in）——FF-pane 的 cli_login 探测不能只查环境变量。
- **登录态探测命令**：`codex login status`，已登录输出 `Logged in using ChatGPT`（退出码 0），未登录输出 `Not logged in`（退出码 1）。适合 T1.5 的 cli_login 探测。
- 未登录时跑 exec：产生多个 `error` 重试事件后 `turn.failed`（401），进程退出码 1（fixture `exec-error-auth.jsonl`）。
- 第三方模型：`-c model_provider=...` 配 config.toml 的 providers 段可换 OpenAI 兼容端点；FF-pane 第一阶段按 cli_login 类型接入即可。

---

## 6. 六项能力声明核对（对照设计文档 5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `codex exec resume <thread_id>` 真机验证；同 thread_id、上下文完整；强杀后仍可恢复 |
| 2 | 流式输出 | **部分** | JSONL 事件随执行实时逐行输出（item 粒度流式），但 `agent_message` 整条到达，**无 token 级增量**；长回答期间无输出，UI 只能显示"生成中" |
| 3 | 文件修改事件 | **部分** | 有 `file_change`（路径 + add/update/delete + 状态），**无 diff 正文**；diff 需适配器/权限层自取（git 快照对比） |
| 4 | 命令执行事件 | **是** | `command_execution` 含命令、聚合输出、退出码、状态，started/completed 双事件 |
| 5 | 权限请求转发 | **否** | `codex exec` 无 `-a` 审批参数、事件流无审批请求类型；沙箱拒绝表现为 `declined`/failed 后模型自行调整。转发审批需走 `codex app-server` 或 MCP server 模式（常驻进程 + 双向协议），不属 L1 exec 范围 |
| 6 | 中途取消 | **部分** | 无优雅取消协议，靠杀进程树；无终止事件需适配器自判；副作用小（会话已落盘可恢复） |

---

## 7. 适配器实现建议（映射到 FF-pane 统一事件）

### 7.1 事件映射表

| FF-pane 统一事件 | Codex 来源 | 备注 |
|---|---|---|
| `session_start` | `thread.started`（取 `thread_id` 登记为 Native Session ID） | 首行即到，可立即持久化 |
| `text` | `item.completed` + `type=agent_message`（`reasoning` 可选作过程提示） | 无增量，一次整条 |
| `file_change` | `item.completed` + `type=file_change`（status=completed 才算数） | diff 自补，见风险 2 |
| `command` | `item.started/completed` + `type=command_execution` | started 显示"运行中"，completed 取 exit_code |
| `permission_request` | **无原生来源**，由 FF-pane 权限执行层（T2.7）自产 | 见风险 3 |
| `end` | `turn.completed`（completed）/ `turn.failed`（failed）/ 进程退出无终止事件（cancelled 或 crashed） | 进程退出是最终兜底信号 |

其余事件处理：流级 `error` 与 item 级 `error` 记入 Run 原始日志并可作 UI 警示条；`todo_list` 可映射为进度显示（可选）；`mcp_tool_call`/`web_search` 记日志即可。

### 7.2 进程模型

- 每轮 = 一次 spawn：首轮 `codex exec --json -C <项目> ...`，后续轮 `codex exec resume <thread_id> --json ...`。适配器的 `send()` 就是再 spawn 一次 resume。
- stdin 显式置空（重定向 NUL / `stdio: ['ignore', ...]`），否则 codex 会等 stdin 或把管道内容附进提示词。
- 解析器按行 JSON.parse，**忽略未知 type / 未知字段**（官方明言 schema 会漂移，词汇表以 fixture + 版本锁定）。
- stdout 一律按 UTF-8 解码；aggregated_output 内可能有中文本地化文本与 \r\n。

### 7.3 三个最关键的坑

1. **Windows 原生沙箱不可靠**：`-s workspace-write` 在 %TEMP% 目录实测直接失败（`windows sandbox: helper_unknown_error: apply deny-read ACLs`），且失败后 turn 照样 `turn.completed`（退出码 0），只能从 item status=failed 与 agent_message 文本看出任务没做成。含义：(a) 不能假设"turn.completed = 任务成功"，Run 成败要看验证命令；(b) FF-pane 的权限控制不能依赖 codex 沙箱，需要 T2.7 自己的权限层兜底，必要时用 `--dangerously-bypass-approvals-and-sandbox` 换取行为确定性（配合外层写路径拦截）。
2. **file_change 无 diff**：设计文档 5.1 要求"路径 + diff"，codex 只给路径。建议 Run 开始前对 write_scope 做 git 快照（或临时 git init），Run 结束后 `git diff` 生成 `changes.diff`——同时服务权限层的越界写检测。
3. **无审批转发 + 无优雅取消**：headless 下权限请求这条统一事件在 Codex 上永远由 FF-pane 权限层自产（先拦截后放行的模式做不到，只能事后拦截+重跑，或事前收窄 sandbox）；取消必须整树强杀并自判结束原因（进程退出而无 turn.completed/turn.failed → cancelled/crashed）。

### 7.4 其他注意点

- `--skip-git-repo-check` 常开；否则新项目目录（未 git init）直接启动失败。
- 成本控制：`-c model_reasoning_effort="low"` 实测有效；`-m` 可指定便宜模型。
- `--output-schema` 可强制最终回复符合 JSON Schema，适合让 Worker 输出结构化完成报告/澄清请求，建议 T2.3 实现时评估。
- `codex login status` 作 cli_login 探测命令（退出码判定）。
- CODEX_HOME 勿指向临时目录（会告警拒建 helper）；用用户默认 `~/.codex` 即可。
- 版本漂移（R3）：0.147.0 的事件词汇已与官方 Rust 源码核对一致；`--json` 输出仍标注实验性质，升级 CLI 后先跑 fixture 回放测试再放行。
