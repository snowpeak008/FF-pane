# Grok Build 适配器调研（T7.3）

- **调研版本：** grok 1.0.13（`5e9a58528b76`），Windows 11，安装于 `~/.grok/bin/grok.exe`（原生 PE 可执行文件，非 npm 垫片）
- **调研日期：** 2026-08-31
- **调研方式：** 真机运行 + CLI 随装官方文档（`~/.grok/docs/user-guide/`，与 1.0.13 同版本发布）逐项核对
- **fixture：** `packages/adapters/fixtures/grok-build/`（**全部真机录制**，模型端替换说明见该目录 README）

> **关于「真机」的口径**：本机 grok 未登录（`grok models` 报 not authenticated）。为录到成功
> 路径，用一个本地假 OpenAI 兼容服务端替换了模型这一环（`fixtures/tools/fake-openai-server.mjs`），
> 经 grok 的自定义模型配置（`base_url`）接入。**被录制的仍是真实 CLI 的真实行为**——事件行、
> 工具落地、退出码、会话恢复全部出自 grok 本体，只有模型的回话内容是可复现的脚本。
> 未经此法验证的只有一件事：真实 xAI 后端特有的字段（`signature`、`cache_read_input_tokens`
> 非零值、`stopReason` 的 `refusal`/`max_tokens` 取值），这些在下文均已标注「未实测」。

---

## 1. Headless / 非交互模式

### 1.1 启动命令

```text
grok -p <PROMPT> [OPTIONS]
grok --prompt-file <PATH> [OPTIONS]
```

- 交互式 TUI 与 headless 是同一个二进制：给了 `-p` / `--prompt-file` / `--prompt-json` 就进 headless。
- **一次进程 = 一轮**，与 codex exec 同构；多轮靠 `-r/--resume <session_id>` 反复 spawn。
- 另有 `grok agent stdio`（ACP over stdio 的常驻双工通道）。那是 M3 的 ACP 路线，不在本工单范围；
  L1 适配器走 headless turn 模型，与既有四家保持同一个接口形状。

### 1.2 关键参数（1.0.13 实测存在）

| 参数 | 作用 | 适配器用法 |
|---|---|---|
| `-p, --single <PROMPT>` | 单轮提示词，答完即退 | 必开 |
| `--prompt-file <PATH>` | 从文件读提示词 | **实际采用**（理由见 §7.2） |
| `--output-format <FMT>` | `plain` / `json` / `streaming-json` / `streaming-messages-json` | 必开 `streaming-json` |
| `--cwd <PATH>` | 工作目录 | 必开，指向项目根 |
| `--always-approve`（别名 `--yolo`） | 自动批准全部工具执行 | **必开**，否则一律「User cancelled」，见 §7.3 坑 1 |
| `--permission-mode <MODE>` | `default`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`/`plan` | 与 `--always-approve` 同义项，二选一即可 |
| `--allow <RULE>` / `--deny <RULE>` | 权限规则，`ToolPrefix(glob)` 语法，deny 优先 | 可作纵深防御，**不作唯一防线**（§7.3 坑 2） |
| `--tools <LIST>` | 工具白名单（内部工具 ID，如 `run_terminal_command`） | 只读角色可用它物理摘掉写工具 |
| `--disallowed-tools <LIST>` | 工具黑名单；另支持 `Agent` / `Agent(explore)` 禁子 Agent | 同上 |
| `-m, --model <MODEL>` | 模型 ID | Profile 指定模型 |
| `-r, --resume <ID_OR_TITLE>` | 恢复会话；UUID 形态一律按 ID 解释 | 原生会话恢复 |
| `-c, --continue` | 续接当前目录最近一次会话 | 不用（语义比 ID 模糊） |
| `-s, --session-id <UUID>` | 为**新**会话指定 UUID；已存在则报错 | 可选，可让 Run 与会话 ID 对齐 |
| `--fork-session` | 与 `-r`/`-c` 同用时分叉出新会话 | 暂不用 |
| `--max-turns <N>` | 最大 Agent 轮数 | 成本护栏 |
| `--reasoning-effort <E>` | 推理强度（别名 `--effort`） | 成本控制 |
| `--rules <RULES>` | 追加到系统提示词的额外规则 | 暂不用（本产品的约束走提示词第 1~4 层） |
| `--system-prompt-override <P>` | 覆盖系统提示词 | **勿用**：会连同工具使用规范一起冲掉 |
| `--no-subagents` | 禁止派生子 Agent | 建议开（子 Agent 的动作不进主事件流，见 §7.3 坑 4） |
| `--disable-web-search` | 关掉联网搜索与抓取 | 按任务信封的 network 位决定 |
| `--sandbox <PROFILE>` | 沙箱档位 | **Windows 无效**，见 §7.3 坑 3 |
| `--no-auto-update` | 本次不查更新 | 建议常开 |
| `--verbatim` | 提示词原样送出，不做任何包装 | 建议开（本产品自己组装提示词） |
| `--worktree [NAME]` | 在新 git worktree 里开工 | **headless 下该标志不建 worktree**（官方文档明写） |
| 环境变量 `XAI_API_KEY` | API 密钥认证 | §4.3 密钥红线的唯一下发通道，正合 |
| 环境变量 `GROK_HOME` | 重定向整个数据目录（配置 / 认证 / 会话） | 见 §7.4 的取舍 |
| 环境变量 `GROK_DISABLE_AUTOUPDATER=1` | 进程级禁更新 | 建议常开 |

### 1.3 退出码（实测 + 官方文档）

| 码 | 含义 | 实测 |
|---|---|---|
| 0 | 提示词正常走完 | ✔ 成功流；**⚠ 全部工具被拒的空转轮也是 0**（§7.3 坑 1） |
| 1 | 认证失败 / 网络错误 / 运行时错误 / `--cwd` 不存在 | ✔ 四种都实测过 |
| 2 | 命令行参数错误（clap 层） | ✔ 未知参数 |
| 130 | SIGINT | 官方文档（Windows 上无对应实测） |
| 143 | SIGTERM | 官方文档 |

`--cwd` 指向不存在的目录时：**stdout 一个字节都没有**，仅 stderr 一行 `Error: Failed to set working
directory ...`，退出 1。适配器不能指望「至少有一条 error 事件」。

---

## 2. 事件流格式（`--output-format streaming-json`）

NDJSON，每行一个带 `type` 的对象，由 grok 的 ACP session update 投影而来。叶子字段名
（`toolCallId`/`kind`/`rawInput`/`rawOutput`）沿用 ACP，`toolName` 与 `usage` 行是 xAI 增补。
日志走 stderr，stdout 只有事件流，天然分离。

| type | 时机 | 关键载荷 |
|---|---|---|
| `available_commands` | **每次模型响应前都发一遍** | `tools[]`、`commands[]`（同一轮内内容完全相同，重复出现） |
| `text` | 回答文本增量 | `data`（片段，非全文） |
| `thought` | 思考文本增量 | `data`（未实测，本次录制的假模型不产思考块） |
| `tool_call` | 工具调用开始 | `toolCallId`、`toolName`、`title`、`kind`、`status`、`rawInput` |
| `tool_call_update` | 工具进度与结果 | `status`（**可为 `null`**）、`content[]`、`rawOutput`、`locations[]` |
| `usage` | 每次模型响应的边界 | `usage`（本次响应的 token） |
| `plan` | 计划更新 | `entries`（未实测） |
| `end` | 收尾 | `stopReason`、`sessionId`、`requestId`、`usage`、`num_turns`、`modelUsage` |
| `error` | 出错 | `message` |

### 2.1 一次写文件（真实录制，`real-streaming-json-success.jsonl`）

```jsonc
{"type":"tool_call","toolCallId":"call_write_1","title":"write","kind":"write","status":"pending",
 "toolName":"write","rawInput":{"file_path":"C:/.../hello.txt","content":"hello"},"content":[],"locations":[]}
{"type":"tool_call_update","toolCallId":"call_write_1","status":null,
 "content":[{"type":"diff","path":"C:/.../hello.txt","oldText":"","newText":"hello"}],
 "rawOutput":null,"locations":[{"path":"C:/.../hello.txt"}]}
{"type":"tool_call_update","toolCallId":"call_write_1","status":"completed",
 "content":[{"type":"diff","path":"C:/.../hello.txt","oldText":"","newText":"hello","_meta":{...}}],
 "rawOutput":{"type":"SearchReplace","EditsApplied":{...,"absolute_path":"C:/.../hello.txt"}},"locations":[]}
```

**三点与其他三家不同**：

1. `status` 实测取值是 `pending` → `null` → `completed`，官方文档写的是 `in_progress`。
   **以实测为准**，且 `null` 必须当「中间进度、状态未变」处理，不能当未知值丢弃。
2. **文件内容变更直接进事件流**：`content[].type === "diff"` 带 `oldText`/`newText` 全文。
   这是四家里唯一不用 git 快照自补就能拿到变更正文的（codex 只给路径）。
   但给的是**新旧全文而非 unified diff 文本**，要落进 `FileChangeEvent.diff` 得自己渲染。
3. `kind` 是 ACP 的工具类目（`write`/`edit`/`execute`/`read`/`search`/`think`/`fetch`/`other`），
   判断「这是不是一次文件修改」应看 `kind`/`toolName`，而不是解析 `title`（那是给人看的）。

### 2.2 一次跑命令（真实录制，同一文件）

```jsonc
{"type":"tool_call","toolCallId":"call_bash_1","title":"run_terminal_command","kind":"execute",
 "status":"pending","toolName":"run_terminal_command","rawInput":{"command":"node -v","description":"..."}}
{"type":"tool_call_update","toolCallId":"call_bash_1","status":"in_progress",
 "content":[{"type":"content","content":{"type":"text","text":"v24.15.0\r\n"}}],
 "rawOutput":{"type":"Bash","output":[118,50,...],"output_for_prompt":"v24.15.0\n","exit_code":0,
  "command":"node -v","truncated":false,"signal":null,"timed_out":false,
  "current_dir":"C:\\...\\grokprobe","output_file":"...\\terminal\\call_bash_1.log","total_bytes":10}}
{"type":"tool_call_update","toolCallId":"call_bash_1","status":"completed", ...}
```

`rawOutput` 给全了：退出码、命令原文、工作目录、是否截断、是否超时、信号、字节数、
甚至完整输出的落盘路径。**命令事件是四家里最完整的一份**。
注意 `output` 是**字节数组**（UTF-8 码点），可读文本在 `output_for_prompt`；
`content[].content.text` 则是带 `\r\n` 的原始终端文本。

### 2.3 `end` 与 `error` —— 「end 一定在最后」不成立

官方文档写 `end` is always the last event。**实测有反例**：

- 未登录（`real-streaming-json-auth-error.jsonl`）：整条流只有一行 `{"type":"error","message":"Not signed in..."}`，**无 end**，退出 1。
- API 报错（`real-streaming-json-api-error.jsonl`）：`available_commands` ×2 → `error`，**无 end**，退出 1。
- 强杀（`real-streaming-json-killed.jsonl`）：只剩 `available_commands` ×2，**无 end 无 error**，stderr 为空。

结论：`end` 缺席是常态而非异常，兜底信号只能是**进程退出**（与四家调研同一条结论）。

### 2.4 其余输出格式

- `json`：一轮结束后吐一个对象（`text`/`stopReason`/`sessionId`/`requestId`/`usage`/`num_turns`/`modelUsage`），
  见 `real-json-success.json`。适合脚本，不适合适配器（拿不到过程事件）。
- `streaming-messages-json`：Anthropic Messages 线格式投影。对本产品无增益——
  官方明说它为兼容而生、含占位字段，且 `uuid` **不是相关性键**、不可用于去重。
  要「xAI 原生、无占位」就该用 `streaming-json`。

---

## 3. 原生会话与恢复

- 会话存于 `$GROK_HOME/sessions/<URL 编码的 cwd>/<session_id>/`（SQLite + 终端日志），**按 cwd 分桶**。
- `end.sessionId` 即 resume 凭据（UUIDv7）。
- **真机验证（`real-streaming-json-resume.jsonl`）**：`-r <id>` 恢复后
  1. `end.sessionId` 与首轮**完全相同**（不新开会话）；
  2. 转发给模型的消息里带着首轮的全部上下文——12 条消息，含首轮的两次工具调用与其结果。
     这是把假模型收到的请求体 dump 下来数出来的，不是从「模型答对了」反推的。
- 会话按 cwd 分桶意味着 **resume 绑定 cwd**：换目录恢复，轻则找不到、重则在错误目录里施工。
  与 claude / gemini 同一个约束，`NativeSessionBinding`（ID + cwd 成对）正是为此而设。

---

## 4. 取消方式

无优雅取消协议（headless 是单向流，`grok agent` 的双工通道才有）。只能杀进程树：

- 实测 `taskkill /PID <pid> /T /F`：stdout 停在 `available_commands`，**无终止事件**，stderr 空。
- 官方文档：SIGINT/SIGTERM 下会话状态保存到最后一次完成的工具调用，**文件改动不回滚**，
  退出码 130/143。可用 `-r` 从断点续。

---

## 5. 认证方式

| 方式 | 说明 | 与本产品的关系 |
|---|---|---|
| `XAI_API_KEY` | 环境变量 | **首选**：正好落在 §4.3「密钥只经 env 下发、不落盘不进命令行」的红线内 |
| `grok login` | 浏览器 OAuth2 | 对应 Provider 的 `cli_login` 类型，凭证在 `~/.grok/auth.json` 由 CLI 自管 |
| `grok login --device-code` | 设备码 | 无浏览器机器 |

未认证时的表现见 §2.3。自定义模型（`[model.*]` 带 `base_url` + `api_key`/`env_key`）可绕开 xAI 后端，
凭据解析顺序为：模型内 `api_key` → `env_key` 指向的变量 → 登录态 → 全局 `XAI_API_KEY`。

---

## 6. 六项能力声明核对（对照设计文档 §5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `-r <session_id>` 真机验证：sessionId 不变、上下文 12 条消息完整回填（§3） |
| 2 | 流式输出 | **是** | `text` 事件是**真增量**（实测一句话被切成两片投递），非整条到达。四家里唯一够格 |
| 3 | 文件修改事件 | **是** | `tool_call_update.content[].type === "diff"` 直接给 oldText/newText 全文 + 路径 + 状态，无需 git 快照自补（§2.1） |
| 4 | 命令执行事件 | **是** | `rawOutput` 含退出码、命令、cwd、截断/超时标志、输出（§2.2），信息量四家最全 |
| 5 | 权限请求转发 | **否** | headless 是单向流，无审批回执通道；待批工具直接以 `failed` +「User cancelled」落地。转发审批须走 `grok agent stdio`（ACP 双工，M3 范围） |
| 6 | 中途取消 | **部分** | 无优雅协议，只能树杀；无终止事件需自判；副作用不回滚但会话可续（§4） |

**额外一项（本产品自加）：MCP 注入 = 否。** grok 的 MCP 只能配在
`~/.grok/config.toml`（用户全局）或 `<cwd>/.grok/config.toml`（写进用户仓库），
**没有逐轮注入参数**（`--plugin-dir` 只存在于 `grok agent` 子命令）。两条路都与
「绝不改写用户的全局配置 / 不在用户仓库里留残留」相抵触，故 T6.6 的知识库只读检索工具
**在 grok 上不可用**，适配器忽略 `ctx.mcpServers`。可行的将来路径见 §7.4。

---

## 7. 适配器实现建议

### 7.1 事件映射表

| grok 事件 | → FF-pane AgentEvent |
|---|---|
| 首个事件到达时 | 无（`session_start` 要等 `end` 才有 sessionId，见 §7.3 坑 5） |
| `text` | `text`（channel=answer, final=false），流末补一条 final |
| `thought` | `text`（channel=reasoning） |
| `tool_call` / `tool_call_update`，`kind` ∈ {write, edit} 或 toolName ∈ {write, search_replace} | `file_change`（path 取 `rawInput.file_path` 或 `locations[0].path`；diff 由 oldText/newText 渲染） |
| `tool_call` / `tool_call_update`，`kind === "execute"` | `command`（command / exitCode / output / cwd 全取自 `rawOutput`） |
| 其余 `tool_call*`（read/search/fetch/think/other） | `raw` |
| `usage` | `raw`（token 统计以 `end` 的汇总为准，逐条 usage 会重复计） |
| `end` | `session_start`（补发 sessionId）+ `end` |
| `error` | `end`(failed) |
| `available_commands` / `plan` / 未知 type | `raw` |

### 7.2 进程模型

- **一轮一 spawn**，与 codex 同构；续轮 `-r <session_id>`，故接口上不需要 `send()`。
- **提示词走 `--prompt-file` 而不是 `-p`**：官方明写 headless **不读 stdin**（codex 的做法在这里不可用），
  而任务合同/交接包动辄数千字、含换行与引号，作命令行参数要顶着 Windows 32767 字符上限和
  引号转义两道风险。逐轮写一个临时文件、用完即删，与 claude 适配器写临时 `--mcp-config` 是同一套纪律。
  临时文件落在系统临时目录而非项目内，避免在用户仓库里留残留。
- stdin 无用途，spawn 时直接关闭。
- `grok.exe` 是原生 PE 可执行文件，**不是 npm 垫片**，故没有 codex 那个「cmd 垫片截断多行位置参数」的问题；
  但 Windows PATH 解析（`Path` vs `PATH`）的坑仍在，沿用既有 `findExecutableOnWindowsPath`。

### 7.3 五个最关键的坑（外加一条成本注记）

1. **默认权限模式下 headless 一事无成，且退出码是 0。**
   实测（`real-streaming-json-headless-noapprove.jsonl`）：不加 `--always-approve` 时，
   写文件工具直接 `status: "failed"` +「User cancelled the execution for tool `write`」，
   文件没落地，`end.stopReason: "cancelled"`，**进程退出码 0**。
   这正是四份 T2.0 调研共同点名的「权限拒绝伪装成功」，在 grok 上的形态是**退出码撒谎**。
   两条应对缺一不可：① 必开 `--always-approve`（安全由 FF-pane 权限层承担，与 codex 的 bypass 同理）；
   ② `end.stopReason === "cancelled"` 必须映射成 `cancelled` 而**不是** `completed`——
   否则一次什么都没干的 Run 会被记成成功，还会满足任务 done 的证据门槛。

   **「其实没执行」的文本标记共三条**（`failed` 命中其一即改判 `denied`）。
   来源是适配器实现 `packages/adapters/src/grok-build/mapper.ts` 的 `DENIAL_MARKERS`，
   重录 fixture 时据此逐条核对措辞：

   | 标记 | 实录出处 |
   |---|---|
   | `User cancelled the execution` | `real-streaming-json-headless-noapprove.jsonl:7`（无审批路径）、`real-streaming-json-deny-rule.jsonl:12`（命令工具） |
   | `Denied by permission policy` | `real-streaming-json-deny-rule.jsonl:7`（`--deny` 路径，见坑 2） |
   | `was not executed` | 同上第 7 行——实录原文是「Tool \`write\` **was not executed**: Denied by permission policy: …」，即它与上一条同句出现 |

   第三条是前两条的伴生句，单独留着是**刻意冗余**：三条都只会把「其实没执行」的 `failed`
   归到 `denied`，措辞哪天漂移时的症状是多记一条阻断证据，而不是漏掉一次越界。
2. **`--deny` 规则是纵深防御，不是防线。** 实测 `--deny "Write(**)"` 确实拦住了写
   （`real-streaming-json-deny-rule.jsonl`：`failed` +「Denied by permission policy」），
   但规则语法是 grok 自己的 glob 方言，与本产品的 `writePaths` 信封不同源；
   真正的裁决必须留在 W2.7 权限层。可以下发规则，但不能把安全押在它上面。
3. **Windows 上没有沙箱。** `--sandbox` 靠 Landlock（Linux）/ Seatbelt（macOS）内核原语，
   Windows 上无对应实现。结论与 codex 一致：沙箱不指望 CLI。
4. **子 Agent 的动作不进主事件流。** grok 可派生 subagent（`spawn_subagent` 工具），
   其内部工具调用不出现在本轮 NDJSON 里，只有汇总结果回来。这意味着子 Agent 写的文件
   **不会产生 `file_change` 事件**，Run 的变更证据会有缺口。故建议默认 `--no-subagents`；
   若将来要开，变更证据必须改由 git 快照兜底。
5. **`sessionId` 只在 `end` 里给。** 流的开头没有任何携带会话 ID 的事件
   （`available_commands` 不含），所以 `session_start` 只能在收到 `end` 时补发。
   轮次中途崩掉 = 拿不到会话 ID = 这一轮无法续接，这是实况，不是实现缺陷。
6. （附）**一轮 = 三次模型调用。** dump 实测：除主对话外，grok 还会各发一次「生成会话标题」
   与「生成仪表盘行」的旁路请求，且标题请求用的是**内置默认模型 ID**（`grok-4.6`）
   而非 `-m` 指定的模型。对成本核算与自定义模型路由都有影响，`end.num_turns` 只数主对话轮。

### 7.4 GROK_HOME 的取舍（记录已否决方案）

`GROK_HOME` 能把配置、认证、会话整体重定向。技术上，给本产品开一个专属 GROK_HOME 就能：
在其 `config.toml` 里写 `[mcp_servers.*]` → 拿回 T6.6 的知识库工具；且用户的 `~/.grok` 分毫不动。

**本工单不采用**，两条理由：① 登录态（`auth.json`）也在 GROK_HOME 里，重定向后
`cli_login` 类型的 Provider 立刻失效，只剩 API key 一条路；② 会话目录跟着搬家，
用户在自己终端里跑的 grok 会话与本产品里的互相看不见——这是个会让人困惑的隐性割裂。
留作日后「按 Provider 类型分流」的可选项，届时需要 UI 上说清楚。
