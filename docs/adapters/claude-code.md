# Claude Code 适配器调研(T2.0)

**调研日期:** 2026-08-29
**CLI 版本:** Claude Code 2.1.220(npm 安装;入口 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,npm 同时生成 `claude.ps1` / `claude.cmd` shim)
**调研方式:** 真机验证(Windows 11 + PowerShell,OAuth 订阅登录态)。本文所有 JSON 样例均来自真实录制,fixture 存于 `packages/adapters/fixtures/claude-code/`。
**结论先行:** 设计文档 5.1 的六项能力全部可满足(命令执行事件有一处小保留),Claude Code 是 L1 接入的最佳范本;最优接法是 **stream-json 双向管道**(stdin 喂消息、stdout 收事件),权限转发与优雅取消都建立在这条管道上。

---

## 1. headless 模式与启动参数

### 1.1 基本形态

```text
claude -p "<任务文本>" --output-format stream-json --verbose [其他参数]
```

- `-p / --print`:非交互模式,跑完退出。**headless 的开关就是它**。非交互模式跳过工作目录信任对话框(help 原文明示),因此只能在可信目录运行——FF-pane 由自己管理 Run 工作目录,天然满足。
- `--output-format`:`text`(默认)/ `json`(单个结果对象)/ `stream-json`(逐行 JSONL 事件流)。**`-p` + `stream-json` 强制要求 `--verbose`**,否则立即报错退出(实测:`Error: When using --print, --output-format=stream-json requires --verbose`)。
- `--input-format`:`text`(默认)/ `stream-json`(stdin 逐行喂 JSON 消息,进程保活可连续多轮)。权限转发与优雅取消**只有**在 `--input-format stream-json` 下才可用,FF-pane 应始终用这个形态。
- 工作目录:就是子进程的 spawn cwd,无专用参数;`--add-dir <目录...>` 可额外授权 cwd 之外的目录。
- 退出码:正常 0;取消 / max-turns 超限 / 执行错误为 1。

### 1.2 与 FF-pane 相关的参数全表(2.1.220 实测)

| 参数 | 作用 | 备注 |
|---|---|---|
| `-p, --print` | headless 开关 | |
| `--output-format stream-json` | JSONL 事件流输出 | 必配 `--verbose` |
| `--input-format stream-json` | stdin 流式输入 | 双向管道形态,推荐 |
| `--verbose` | stream-json 输出的前置条件 | |
| `--include-partial-messages` | 追加 `stream_event` 增量事件(打字机流) | 仅 `-p` + stream-json |
| `--include-hook-events` | 输出 hook 生命周期事件 | 仅 stream-json |
| `--model <名或别名>` | 会话模型,如 `haiku` / `sonnet` / 全名 | 冒烟测试用 `haiku` |
| `--fallback-model <列表>` | 主模型过载时自动降级 | 仅 `-p` |
| `--allowedTools / --disallowedTools <列表>` | 预授权 / 禁用工具,支持 `Bash(git *)` 形式的细粒度匹配 | 逗号或空格分隔 |
| `--tools <列表>` | 直接裁剪内建工具集(`""` 全禁 / `default` 全开 / `Bash,Edit,Read`) | 比 disallowedTools 更彻底 |
| `--permission-mode <模式>` | `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`(不传为 default) | 见 §6 |
| `--permission-prompt-tool stdio` | **权限请求转发到 stdin/stdout 控制协议**(隐藏参数,help 不列但实测有效) | 见 §6.3 |
| `--max-turns <n>` | 最大 agent 轮次(**隐藏参数**,help 已不列但实测有效) | 超限:result `error_max_turns`,退出码 1 |
| `--max-budget-usd <金额>` | 单次运行花费上限 | 仅 `-p`,新的成本护栏 |
| `--session-id <uuid>` | 预指定会话 ID | FF-pane 可自己生成并登记 |
| `-r, --resume <id>` / `-c, --continue` | 原生会话恢复 | 见 §4 |
| `--fork-session` | resume 时派生新会话 ID | |
| `--no-session-persistence` | 不落盘会话(不可 resume) | 仅 `-p` |
| `--system-prompt / --append-system-prompt` | 替换 / 追加系统提示 | FF-pane 角色注入用 append |
| `--settings <文件或JSON>` | 附加设置 | |
| `--setting-sources user,project,local` | **限制加载哪些配置来源** | 控制配置泄漏的关键,见 §8 坑 5 |
| `--mcp-config` / `--strict-mcp-config` | 注入 MCP 服务器 / 忽略其他 MCP 配置 | |
| `--agents <json>` | 定义自定义子 agent | |
| `--json-schema <schema>` | 结构化输出校验 | 可用于让 Worker 输出结构化报告 |
| `--bare` | 极简模式:跳过 hooks/LSP/插件/CLAUDE.md 自动发现,认证仅走 `ANTHROPIC_API_KEY` | 适合"纯净执行器"形态,但订阅登录态不可用 |
| `--dangerously-skip-permissions` | 跳过全部权限检查 | FF-pane 不应使用 |
| `--add-dir <目录...>` | 额外可访问目录 | |
| `--effort low..max` | 思考强度 | |
| `--replay-user-messages` | stdin 消息回显到 stdout 作为确认 | 仅双向 stream-json |

隐藏参数探测方式:传参不带值触发 `argument missing` 报错即证明参数存在(`--max-turns`、`--permission-prompt-tool`、`--max-thinking-tokens` 均如此确认)。**隐藏意味着官方可能在后续版本移除,适配器要把它们当作"能力探测点"而非硬依赖**(R3 风险)。

---

## 2. 事件流格式(逐类,真实样例)

stream-json 是**每行一个 JSON 对象**。所有事件(除 `result` 外)都带 `session_id` 与 `uuid`;与消息相关的事件带 `parent_tool_use_id`(子 agent 场景)与 `timestamp`。

### 2.1 `system/init` —— 会话开始

第一行必为它。字段节选(完整见 fixture 01 第 1 行):

```json
{"type":"system","subtype":"init",
 "cwd":"C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-cc-rec\\a",
 "session_id":"9e228810-a71a-4268-88a7-d8b0b667b41f",
 "tools":["Task","Bash","Edit","Glob","Grep","Read","WebFetch","WebSearch","Write","..."],
 "mcp_servers":[],
 "model":"claude-haiku-4-5-20251001",
 "permissionMode":"default",
 "apiKeySource":"none",
 "claude_code_version":"2.1.220",
 "slash_commands":["...用户全局技能会出现在这里..."],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
 "memory_paths":{"auto":"C:\\Users\\USER\\.claude\\projects\\<cwd编码>\\memory\\"}}
```

要点:`session_id` 在这里拿;`capabilities` 数组可用来探测 interrupt 协议支持;`permissionMode`/`tools`/`model` 可回填 FF-pane 顶部状态条。

### 2.2 `assistant` —— 模型输出(文本 / thinking / 工具调用)

**一条 API 消息的每个 content block 单独占一行**,同一条消息的多行共享 `message.id`(fixture 01 中 thinking 块与 tool_use 块是两行,`message.id` 均为 `msg_011CeWmaHy25DShBjKAnHTnf`)。content block 类型:

- `{"type":"thinking","thinking":"...","signature":"<加密blob>"}`
- `{"type":"text","text":"I created hello.txt ..."}`
- `{"type":"tool_use","id":"toolu_01UEqZdZ...","name":"Write","input":{"file_path":"...","content":"hello"},"caller":{"type":"direct"}}`

### 2.3 `user` —— 工具结果(文件修改与命令执行的真实载体)

工具执行完,CLI 以 `user` 角色事件回填 `tool_result`。**关键:除标准的 `message.content[].tool_result`(给模型看的文本)外,顶层还有结构化的 `tool_use_result` 字段(给程序看的)**——这是 FF-pane 提取 diff 与命令结果的正确来源:

**Write(新建文件)**,fixture 01:

```json
{"type":"user",
 "message":{"role":"user","content":[{"tool_use_id":"toolu_01UEqZdZ...","type":"tool_result",
   "content":"File created successfully at: ...hello.txt (file state is current in your context — no need to Read it back)"}]},
 "tool_use_result":{"type":"create","filePath":"...\\hello.txt","content":"hello","structuredPatch":[],"originalFile":null,"userModified":false}}
```

**Edit(修改文件)**,fixture 02 —— `structuredPatch` 是标准 unified diff hunk:

```json
{"tool_use_result":{"filePath":"...\\hello.txt","oldString":"hello","newString":"hello world",
 "originalFile":"hello",
 "structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,
   "lines":["-hello","\\ No newline at end of file","+hello world","\\ No newline at end of file"]}],
 "userModified":false,"replaceAll":false}}
```

**Bash(命令执行)**,fixture 01:

```json
{"message":{"role":"user","content":[{"tool_use_id":"toolu_018R4fkp...","type":"tool_result","content":"hello","is_error":false}]},
 "tool_use_result":{"stdout":"hello","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}
```

注意:**成功的 Bash 结果没有显式退出码字段**。成功 = 退出码 0;失败时 `is_error: true` 且 content 文本中含退出码描述。命令本体在前面的 `tool_use` 事件 `input.command` 里,两者靠 `tool_use_id` 关联。

**被拒 / 被中断的工具**,fixture 05:

```json
{"message":{"role":"user","content":[{"type":"tool_result","content":"The user doesn't want to proceed with this tool use. ...","is_error":true,"tool_use_id":"toolu_018tycQu..."}]},
 "tool_use_result":"User rejected tool use",
 "tool_result_meta":[{"id":"toolu_018tycQu...","non_execution_kind":"user-rejected"}]}
```

注意 `tool_use_result` 此时是**字符串**而非对象——类型上必须按 `unknown` 处理。

### 2.4 `stream_event` —— 打字机级增量(需 `--include-partial-messages`)

包裹 Anthropic API 原生 SSE 事件,fixture 06 的序列:`message_start → content_block_start → content_block_delta(×n) → content_block_stop → message_delta → message_stop`。文本增量在 `event.delta.text`。不开此参数时,文本只在整条 `assistant` 行到达时一次性出现(每个 API 轮仍是流式到行级,但块内无增量)。

### 2.5 `system` 的其他 subtype(可忽略的噪声)

实测出现:`thinking_tokens`(思考进度计数)、`status`、`task_started`。**适配器必须对未知 `system` subtype 直接跳过**,这是版本漂移的主要形态。

### 2.6 `control_request` / `control_response` —— 控制协议(双向)

仅 `--input-format stream-json` 下存在,详见 §5、§6.3。

### 2.7 `result` —— 会话结束

最后一行(硬杀时没有)。三种实测 subtype:

| subtype | 场景 | is_error | 退出码 | terminal_reason |
|---|---|---|---|---|
| `success` | 正常完成 | false | 0 | `completed` |
| `error_during_execution` | interrupt 取消 / resume 找不到会话等 | true | 1 | `aborted_tools` / 无 |
| `error_max_turns` | 轮次超限 | true | 1 | `max_turns` |

关键字段(fixture 01 末行):`result`(最终文本)、`num_turns`、`total_cost_usd`、`usage` / `modelUsage`(token 与费用明细,可直接入 Run 记录)、`permission_denials[]`(被自动拒绝的工具调用清单,含 `tool_name`/`tool_use_id`/`tool_input`)、`duration_ms` / `duration_api_ms`。

---

## 3. 输入格式(`--input-format stream-json`)

stdin 每行一个 JSON。用户消息:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"任务文本"}]}}
```

进程保活期间可连续发多条(多轮对话在同一进程内完成,session 连续)。控制类输入见 §5、§6.3。发送完毕关闭 stdin 或收到 `result` 后由适配器决定是否结束进程。

---

## 4. 原生会话

- **获取:** `system/init` 事件的 `session_id`(UUID);也可用 `--session-id <uuid>` 让 FF-pane 预生成并直接登记。
- **存储:** `~/.claude/projects/<cwd 编码>/<session-id>.jsonl`(实测路径,如 `C--Users-USER-AppData-Local-Temp-ffpane-cc-rec-a`)。resume 后追加写入同一文件,session_id 不变。
- **恢复:** `claude -p --resume <session_id> "<新指令>"`(fixture 02,实测成功,上下文完整延续);`-c/--continue` 恢复当前目录最近一次会话;`--fork-session` 在恢复时派生新 ID(原会话不动)。
- **硬性限制(实测,fixture 09):resume 严格绑定 cwd。** 会话文件按 cwd 编码目录存储,在其他目录 resume 同一 ID 会失败:stdout 先输出一行**非 JSON 纯文本** `No conversation found with session ID: ...`,再输出 `result/error_during_execution`,退出码 1。FF-pane 登记 Native Session ID 时必须**连同 cwd 一起登记**,恢复时用同一 cwd 启动。
- `--no-session-persistence` 可用于一次性运行(如 Reviewer),明确放弃恢复能力。

---

## 5. 取消方式

两条路径,实测均有效:

**① 优雅取消(推荐):interrupt 控制请求**(fixture 05)。前提 `--input-format stream-json`。向 stdin 写:

```json
{"type":"control_request","request_id":"<自定义id>","request":{"subtype":"interrupt"}}
```

CLI 行为(实测):立即回执 `{"type":"control_response","response":{"subtype":"success","request_id":"<同id>","response":{"still_queued":[]}}}` → 正在执行的工具被终止,tool_result 标记 `is_error: true` + `non_execution_kind: "user-rejected"` → 输出 `result`,`subtype: "error_during_execution"`、`terminal_reason: "aborted_tools"` → 进程退出码 1。整个过程约 1~2 秒,事件流完整闭合,会话已落盘可 resume。`init.capabilities` 里的 `interrupt_receipt_v1` 即此协议的能力声明。

**② 硬杀进程树(兜底)**(fixture 07)。`taskkill /PID <pid> /T /F`。后果实测:stdout 戛然而止(最后一行是 `system/task_started`,**没有 result 事件**);**孙进程(如 `sleep.exe`)可能成为孤儿存活**。

> **归因更正(T8.2,2026-09-01)**:本节原写「msys 的进程模型会断开父子链」,四变体对照实测表明**与 msys 无关**——
> `bash → sleep` 只要中间层还活着就杀得干净;而**纯原生 `node → node`、中间层先退出**同样逃逸。
> 真因是:`taskkill /T` 遍历的是**当下的父子表**,中间进程若在被杀前自己先退出,它的子进程会被系统
> 重父化、脱离这棵树——`/T` **沉默地不列出它**(对仍存活的顶层 taskkill 返回 0 并报告成功;退出码 128
> 「目标不存在」只在对已不存在的 pid 下手时出现)。msys 只是碰巧常触发「中间层先退出」这个形态。
> **已根治**:`packages/adapters/src/process/job-object.ts` 在 spawn 之后立即用 Windows Job Object 圈禁,
> 按 Job 归属终止而非按父子表,重父化不改变 Job 归属。

结论仍然成立:适配器应优先走 interrupt 协议,硬杀只作兜底。

结论:**先 interrupt,超时(建议 5 秒)再硬杀**。

---

## 6. 权限机制

### 6.1 默认行为:自动拒绝,不阻塞

`-p` 模式下无人可问,未授权的工具调用被**直接拒绝**(fixture 03):模型收到拒绝文本后结束,`result.permission_denials` 数组列出被拒调用(`tool_name`/`tool_use_id`/`tool_input`),`subtype` 仍是 `success`(is_error 为 false)——**适配器不能只看 subtype,必须检查 permission_denials**,否则"任务其实没做"会被当成成功。

### 6.2 静态授权

- `--allowedTools "Write" "Bash(git *)"`:按工具名 + 参数模式预授权(FF-pane 把任务合同的权限信封翻译成这份清单)。
- `--permission-mode`:`acceptEdits`(自动同意文件编辑)/ `bypassPermissions`(全放行,禁用)/ `plan`(只读规划)/ `manual` / `dontAsk` / `auto`(2.1.x 新增)。
- `--tools`:直接裁剪工具集,比事后拒绝更硬(Reviewer 只读可用 `--tools "Read,Grep,Glob"`)。

### 6.3 动态转发(FF-pane 审批闭环的核心,实测可用)

`--permission-prompt-tool stdio` + 双向 stream-json(fixture 04)。未授权工具调用发生时,CLI 在 stdout 发:

```json
{"type":"control_request","request_id":"ee857bcb-...","request":{
  "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
  "input":{"file_path":"...\\p.txt","content":"x"},
  "description":"p.txt",
  "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
  "tool_use_id":"toolu_01Xsb4h2..."}}
```

CLI **挂起等待**,外部程序(FF-pane 主进程)在 stdin 回:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<同id>",
  "response":{"behavior":"allow","updatedInput":{...原input...}}}}
```

`behavior: "allow"`(可带修改后的 `updatedInput`)或 `"deny"`(可带 `message` 说明理由)。实测批准后文件真实创建、任务继续完成。`permission_suggestions` 还可以直接渲染成 UI 的"本次允许/会话内允许编辑"选项。这正是设计文档"权限请求 → 任务 blocked → 用户一键批准/拒绝"要的机制,**无需 MCP 服务器**(`--permission-prompt-tool mcp__server__tool` 的 MCP 方式也存在,但 stdio 方式更简单,未测 MCP 路径)。

### 6.4 说明

`--permission-prompt-tool` 在 2.1.220 中是隐藏参数(help 不列,实测有效且为官方 Agent SDK 的底层机制)。若未来被移除,同等能力可经 MCP permission tool 或 hooks(PreToolUse)实现,协议形态需按 R3 流程重新摸底。

---

## 7. 认证方式

- **订阅登录(cli_login 类型):** 本机实测 `claude auth status` 输出 JSON:`{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`——**这就是 FF-pane T1.5"cli_login 登录态探测"要执行的命令**。登录/登出用 `claude auth login/logout`(交互式,FF-pane 只引导用户去终端做,不代办)。凭证由 CLI 自管(Windows 实测不在 cmdkey 可见的凭证管理器条目,也无 `~/.claude/.credentials.json`;具体位置属实现细节,**适配器不应触碰凭证本体**)。
- **API key 模式:** 环境变量 `ANTHROPIC_API_KEY`(FF-pane 按 §4.3 规则注入单次 Run);`init.apiKeySource` 字段回报 key 来源(本机登录态下为 `"none"`)。`claude setup-token` 可生成长期 token(需订阅)。
- **企业通道:** Bedrock/Vertex/Foundry 走各自凭证(`--bare` 模式说明中确认),M1 不涉及。

---

## 8. 六项能力声明核对(设计文档 5.1)

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **是** | `--resume <session_id>` 实测成功(fixture 02);限制:必须同 cwd(fixture 09) |
| 2 | 流式输出 | **是** | stream-json 行级流式;`--include-partial-messages` 提供 token 级增量(fixture 06) |
| 3 | 文件修改事件 | **是** | `tool_use`(Write/Edit)+ `user` 事件顶层 `tool_use_result.structuredPatch` 提供路径与 diff(fixture 01/02) |
| 4 | 命令执行事件 | **是(带保留)** | `tool_use.input.command` + `tool_use_result.{stdout,stderr}`(fixture 01);**退出码非结构化**:成功隐含 0,失败靠 `is_error` + 文本解析 |
| 5 | 权限请求转发 | **是** | `--permission-prompt-tool stdio` + `can_use_tool` 控制请求,外部批准/拒绝闭环实测通过(fixture 04);依赖隐藏参数,留 R3 观察 |
| 6 | 中途取消 | **是** | interrupt 控制请求优雅取消实测通过(fixture 05);硬杀兜底有孤儿进程坑(fixture 07) |

## 9. 适配器实现建议(映射到统一 AgentEvent)

### 9.1 推荐进程形态

```text
spawn: claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --permission-prompt-tool stdio
       --model <Profile指定> --allowedTools <权限信封翻译> [--max-turns N] [--max-budget-usd X]
       [--setting-sources user] [--strict-mcp-config]
cwd:   Run 的工作目录(同时是 resume 的 key)
stdin: user 消息 / control_response(审批)/ control_request(interrupt)
```

Windows 下 spawn 目标是 npm shim,Node `spawn` 需 `shell: true` 或直接 `cmd /c claude ...`,或解析真实 `claude.exe` 路径直接执行。

### 9.2 事件映射表

| FF-pane 统一事件 | 来源 | 提取要点 |
|---|---|---|
| `session_start` | `system/init` | `session_id`(连同 cwd 登记)、`model`、`permissionMode`、`tools` |
| `text` | `assistant` 行中 `content[].type === "text"`;打字机用 `stream_event` 的 `content_block_delta` | 同一 `message.id` 的多行是同一条消息的不同块,勿重复渲染;`thinking` 块按需丢弃或降级显示 |
| `file_change` | `assistant/tool_use`(name ∈ Write/Edit/NotebookEdit)配对其 `user/tool_result` | 路径取 `tool_use_result.filePath`;diff 取 `structuredPatch`(Write 新建时 patch 为空、内容在 `content`);以 `tool_use_id` 配对 |
| `command` | `assistant/tool_use`(name === Bash)配对 `user/tool_result` | 命令取 `input.command`;输出取 `tool_use_result.stdout/stderr`;退出码:`is_error===false → 0`,否则从 content 文本解析(解析不到记 -1) |
| `permission_request` | `control_request`(subtype `can_use_tool`) | 挂起 Run → 任务转 blocked → 用户决定后回写 `control_response`;`permission_suggestions` 渲染为审批选项 |
| `end` | `result`(或 stdout EOF 无 result) | `success`+空 `permission_denials` → completed;`permission_denials` 非空 → 视为 blocked/failed 复盘;`aborted_tools` → cancelled;`error_max_turns` → failed;无 result 行 → crashed |

### 9.3 已实证的坑(按重要度)

1. **一条消息多行输出:** 每个 content block 独立成行且重复整个 `message` 外壳,按 `message.id` 去重聚合,否则 UI 重复渲染、token 统计翻倍。
2. **permission_denials 假成功:** 默认模式下被拒的 Run 返回 `subtype: "success"`(§6.1),必须检查 `permission_denials` 数组,否则漏报失败。
3. **resume 绑定 cwd:** Native Session ID 必须与 cwd 成对登记(§4);跨目录 resume 报错且**首行是非 JSON 文本**。
4. **解析器容错:** stdout 可能出现非 JSON 行(fixture 09)、未知 `system` subtype(`thinking_tokens`/`status`/`task_started`)、`tool_use_result` 对象/字符串双形态、硬杀后无 result 的截断流(fixture 07)。逐行 `try-parse`,未知即跳过,EOF 无 result 即 crashed。
5. **用户全局配置泄漏:** init 的 `slash_commands`/`skills` 显示 headless 会继承用户 `~/.claude` 的技能、hooks、CLAUDE.md。FF-pane 的 Run 应加 `--setting-sources user`(或至少 `--strict-mcp-config`)控制变量;`--bare` 最纯净但会断订阅登录,不可默认用。
6. **Windows 硬杀孤儿进程:** 孙进程逃逸树杀(§5,**真因是重父化而非 msys**,T8.2 已用 Job Object 圈禁根治);取消一律先 interrupt、超时再杀。
7. **隐藏参数漂移风险:** `--max-turns`、`--permission-prompt-tool` 已从 help 隐藏(§1.2),升级 CLI 前先跑 fixture 回放 + 参数探测(`argument missing` 法),对应开发计划 R3。
8. **成本与预算:** `result.total_cost_usd`/`usage` 直接入 Run 记录;`--max-budget-usd` 是比 max-turns 更贴合"成本控制"的护栏,两者可同时上。

### 9.4 能力声明(供 T2.4 直接使用)

```text
supportsNativeResume:      true   (session_id + cwd 成对登记)
supportsStreaming:         true   (stream_event 增量)
supportsFileChangeEvents:  true   (structuredPatch)
supportsCommandEvents:     true   (退出码从 is_error/文本推断)
supportsPermissionForward: true   (stdio control 协议)
supportsCancel:            true   (interrupt 控制请求,硬杀兜底)
```
