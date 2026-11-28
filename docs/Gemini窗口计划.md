# Gemini 窗口计划（T11.23 草案）

> 状态：2026-11-27 调研完成，只写计划，没动代码，等 Tony 说开工。
> 调研环境：Windows 11，Gemini CLI 0.57.0（npm 全局），本机没装 agy（Antigravity CLI）。

## 1. 要做什么

工作台新开窗口多一种「Gemini」，在终端窗格里跑交互界面，沿用 Claude、Codex 的两种连法，分两期做（Tony 2026-11-27 定）：

- **第一期 · 本地登录**：跑 `agy`，用本机 Google 账号（反重力 / Antigravity）登录，FF-pane 不注入密钥。做法见 §3。
- **第二期 · 中转**：跑 `gemini`，地址和密钥由 FF-pane 从中转来源注入。Tony 说中转站最好是支持 Gemini 原生接口的，都是配合 CLI 工具用，探针时核实。做法见 §7。

两期共用同一个窗口种类 `gemini`，连法决定跑哪个程序。能力对齐 Cursor 窗口：角色、工作台工具、消息投递、续接、项目外不能写。

## 2. 调研结论

关键判断：**两条路是两个不同的程序**。Gemini CLI 的「Google 账号登录」已于 2026-06-18 停用（第三方文章转述，未在官方页面核实），接替的是 `agy`。所以 `gemini` 只能走 API key（中转），本地登录只能走 `agy`。

### 2.1 gemini（中转）已核实

| 事 | 结论 | 依据 |
|---|---|---|
| 中转变量 | `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`；必须是 API key 登录，Google 登录会绕过地址；地址须 HTTPS 或 localhost | 包内 grep 确认读取；文档 |
| 参数 | `--approval-mode default/auto_edit/yolo/plan`、`-m`、`-i`（跑完初始提示留在交互）、`--resume <uuid>`、`--session-id <uuid>`、`--skip-trust`、`--include-directories` | 本机 `--help` |
| 会话 | `~/.gemini/tmp/<项目hash>/chats/`；新开可预分配 `--session-id`，续接 `--resume <uuid>`，和 Claude 的做法一样 | 官方会话文档 |
| 每窗口配置 | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 指到本窗口的 settings 文件，优先级高于用户和项目文件。hooks、mcpServers、认证类型都写这一个文件，**不碰 `~/.gemini` 和项目 `.gemini`**（比 Cursor 只能写项目 `.cursor` 干净） | 包内 grep 确认读取该变量；文档 |
| 钩子事件 | `SessionStart`、`BeforeAgent`、`AfterAgent`、`BeforeTool`、`AfterTool`；stdin 给 `session_id`、`cwd`、`transcript_path`；`additionalContext` 能进模型；`BeforeTool` 回 `decision: deny` + `reason` 可拦 | 官方钩子文档 |
| 钩子执行 | 按 `getShellConfiguration` 选 shell，代码里有 PowerShell 分支；Windows 上实际是哪个要真机核对（Cursor 吃过 Git Bash 的亏）。环境里有 `GEMINI_PROJECT_DIR`、`GEMINI_CWD`、`GEMINI_SESSION_ID` | 包内源码 |
| 工具名 | `write_file`、`replace`、`run_shell_command`、`read_file`、`glob`、`grep_search`、`list_directory` | 包内源码 |
| MCP | `mcpServers` 里 `httpUrl` + `headers` 可连主进程共用的 HTTP 服务；工具名 `mcp_<服务器>_<工具>`，服务器名别带下划线（`ffpane-workbench` 没问题） | 官方 MCP 文档 |
| 代理 | 读 `HTTPS_PROXY` / `HTTP_PROXY`，Cursor 的系统代理补法可直接复用 | 包内 grep |
| 信任 | `--skip-trust` 或 `GEMINI_CLI_TRUST_WORKSPACE=true` | 本机 `--help`；包内 grep |

### 2.2 agy（本地登录）官方资料补齐后（2026-11-27 第二轮调研，第一期做这一路）

**安装与登录**
- 安装：`irm https://antigravity.google/cli/install.ps1 | iex`，装到 `%LOCALAPPDATA%\agy\bin`，命令 `agy`，`agy --version` 看版本。
- 登录：没有 login 子命令。首次启动在界面里选账号，个人 Google 账号走浏览器 OAuth，凭据存系统凭据管理器；退出登录在界面里输 `/logout`。官方没写更新命令。

**启动参数**（官方参考页原样）：`--mode`、`--model`、`--effort`、`--add-dir`（可重复）、`-c/--continue`（最近一条）、`--conversation <id>`（按编号续接）、`-i/--prompt-interactive`（跑完初始提示留在交互）、`-p/--print`、`--sandbox`、`--dangerously-skip-permissions`、`--log-file`。没有 `--session-id`、没有跳过信任的参数。

**设置文件**：固定 `~/.gemini/antigravity-cli/settings.json`，官方没写覆盖路径的环境变量。但 1.5.18 的 `agy --help`（2026-11-27 实测）有 `--settings`：只对本次会话生效、不保存，值是 settings.json 键组成的 JSON 对象（内联或文件路径），所以权限等配置可以每窗口单独给，不用碰用户设置；能放哪些键、是否真的覆盖用户设置，等账号能对话后验证。同一份帮助还显示：`--resume`、`-r` 是 `--conversation` 的别名，`--mode` 取值 `accept-edits`、`auto`、`plan`，`--effort` 取值 `low|medium|high|xhigh|max`，子命令有 `models`、`mcp`、`plugin`、`update`（设置页「列出模型」可直接用 `agy models`）。`--sandbox`、`--model`、`--mode`、`--dangerously-skip-permissions` 只对本次会话生效、不写文件。`agentMode`：`auto`、`default`、`accept-edits`、`plan`；`toolPermission`：`request-review`、`proceed-in-sandbox`、`strict`、`always-proceed`。`trustedWorkspaces` 由 CLI 问过之后自己加，没有手动入口。

**钩子**（官方 hooks 页）
- 文件：工作区 `<项目>/.agents/hooks.json`、全局 `~/.gemini/config/hooks.json`、插件内的 `hooks.json`。写在 `settings.json` 里的 hooks 不加载。
- 事件：`SessionStart`、`PreToolUse`、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`。matcher 只对两个 Tool 事件有效，是工具名正则。**文件结构（2026-11-28 实测，官方 `hooks.md` 也这么写）**：顶层键是钩子名，下面按事件分；`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop` 是平铺（数组里直接放 `{type, command, timeout}` 处理器，不套 `matcher` 和 `hooks`），只有 `PreToolUse`、`PostToolUse` 是分组（`[{matcher, hooks:[处理器]}]`）。套错了 agy 不报到界面，只在 `~/.gemini/antigravity-cli/cli.log` 写 `Failed to parse hooks file ... invalid hook "<钩子名>": command hook must specify 'command'`，整份钩子都不生效。处理器字段：`type` 默认 `command`、`command` 必填、`timeout` 秒（默认 30）；钩子命令在 Windows 上由 `cmd /c` 执行，工作目录是 `hooks.json` 所在目录（`.agents`），不是项目根，项目根看 stdin 的 `cwd` 和 `workspacePaths`。
- stdin（camelCase）：都有 `conversationId`、`workspacePaths`、`transcriptPath`、`modelName`、`lastUserInput`；`PreToolUse` 加 `toolCall{name,args}`；`Stop` 加 `terminationReason`、`error`、`fullyIdle`。
- stdout：`SessionStart` 可回 `injectSteps`；`PreInvocation` / `PostInvocation` 可回 `injectSteps`；`PreToolUse` 回 `decision`（`allow`、`auto_approve`、`deny`、`ask`、`force_ask`、`deny_unless_prior_grant`）加 `reason`；`Stop` 回 `decision` 加 `reason`。
- 工具名：写文件 `write_to_file`、`replace_file_content`、`multi_replace_file_content`；命令 `run_command`。
- **`allow` 和 `auto_approve` 不一样（2026-11-28 实测）**：`PreToolUse` 回 `allow` 只表示钩子不拦，不能代替权限放行，无头模式下 `run_command` 仍按 `command` 权限被自动拒绝（transcript 里是 `user denied permission to run command`）；回 `auto_approve` 才真正放行，命令执行成功，`PostToolUse` 随后触发。`auto_approve` 官方 `hooks.md` 没列，是从 agy 更新日志和二进制里查到的（内部名 `hook_auto_approve`）。官方更新日志还写过：管理员强制审批的场景（离开终端沙盒的命令、管理员策略要求审核的命令、「始终询问」策略下工作区外的文件读写）不会被 `auto_approve` 绕过，所以企业账号上它可能不灵，不能把它当成唯一的放行手段。
- `PostToolUse` 官方写明只认空对象 `{}`；`Stop` 的 `decision` 只有 `continue` 会让它重新进入循环，其他值放行停止，所以观察型钩子别回 `continue`。
- 钩子环境（2026-11-28 实测，原先「官方没写」的部分）：环境里有 `ANTIGRAVITY_CONVERSATION_ID`（与 stdin 的 `conversationId` 一致）；窗口令牌等我们设在 agy 进程里的环境变量会传进钩子；用户自己的 `MSYSTEM=MINGW64`、`EXEPATH`、`SHELL` 也会带进去，目前不影响脚本运行。仍没测：脚本非 0 退出码的含义，以及交互界面里钩子走的环境是否相同。

**MCP**（官方 MCP 页）
- 文件：全局 `~/.gemini/config/mcp_config.json`、工作区 `<项目>/.agents/mcp_config.json`、插件内。根键 `mcpServers`。
- stdio：`command`、`args`、`env`、`cwd`。远程只支持 Streamable HTTP：`serverUrl`（或 `url`）加 `headers`；不支持 SSE 和 `httpUrl`。
- 官方没写 `env`、`headers` 里能不能展开环境变量。
- 工具名 `mcp_<服务器>_<工具>`；默认懒加载，经内置 `call_mcp_tool` 调用。未配置的 MCP 工具默认要用户批准，放行规则写 `mcp(服务器/*)`，规则存放位置和格式官方这一页没写。

**会话**（只有第三方资料：txcript 文档、agent-intern 等 PyPI 包，官方没写，待探针核实）
- 数据根 `~/.gemini/antigravity-cli`；会话是 `conversations/<uuid>.db`，转写镜像在 `brain/<uuid>/.system_generated/logs/transcript.jsonl`；`agy --conversation <uuid>` 靠 db 重建上下文；`brain/<uuid>/` 目录缺了续接会卡住。
- 新开没有预分配编号。第三方桥接工具靠 `cache/last_conversations.json` 或最新的 `brain/` 目录认领。我们有更稳的办法：钩子 stdin 带 `conversationId`，`SessionStart` 钩子直接上报（官方文档写了字段，真机待核对）。
- `agy -p` 无界面模式第三方报告 stdout 为空，不影响交互窗口。

**已知问题**（第三方帖子，待官方核实）：AI Pro 账号报 `Eligibility check failed`；部分模型 2026-10 起只给 Ultra / 企业档，免费和 Pro 可能只剩 Flash。

**本机（2026-11-28）**：`agy` 1.5.18 已装在 `%LOCALAPPDATA%\agy\bin\agy.exe`，Tony 的账号已能对话（见 §5 第 2 项）。数据根 `~/.gemini/antigravity-cli`：`cli.log`（钩子加载和解析报错都在这里）、`log/cli-<时间>.log`、`brain/<编号>/.system_generated/logs/transcript_full.jsonl`（转写，注意文件名是 `transcript_full.jsonl`，不是第三方资料写的 `transcript.jsonl`）、`conversations/`、`settings.json`。转写每行一个步骤（`step_index`、`source`、`type`、`status`），注入的 `injectSteps` 在里面是 `SYSTEM_MESSAGE`，被拒的工具调用是 `status: ERROR`，错误文本含 `user denied permission`。`~/.gemini/antigravity/` 里只有一份 2026-05 的旧 `mcp_config.json`。

**对第一期的影响**：钩子和 MCP 都只能写工作区 `.agents/` 下的文件（同 Cursor 写项目 `.cursor/`，多个窗口共用，靠窗口令牌区分），设置不再是死角：`--settings` 能按窗口单独给、不保存（能放哪些键、是否压过用户设置，等账号能对话后验证）；权限先用启动参数，需要 `toolPermission` 之类的键时走 `--settings`，仍然不改用户全局设置。

## 3. 第一期做法（本机登录，`agy`）

### 3.1 窗口种类和路由

- 窗口种类加 `gemini`（`WORKBENCH_WINDOW_KINDS`），项目配置多一路 `gemini`。第一期只有「本机登录」，不填来源；配置里没有这一路也能开窗（同 Cursor，`resolve-config.ts` 照写回落）。第二期再加「中转」。
- 窗口种类 → 程序：本机登录跑 `agy`，中转跑 `gemini`。`workbenchKindToRuntime` 现在一种 kind 只对应一种 runtime，第二期要按连法分开；第一期先写死 `agy`，留好口子。
- 模型：配置里可空（空 = agy 自己的默认）。`--model` 要的是显示名（官方例子是 Gemini 3.5 Flash 这种），不是 id。官方没写列出模型的命令，设置页第一期让用户手填，探针看 agy 有没有。
- 思考强度：agy 有 `--effort`，可取值官方没写，第一期不传，探针后再开。没有压缩比例；不能用启动参数关子 agent，同 Grok 只靠说明书。

### 3.2 启动

- 程序：先看 PATH 上的 `agy`，再看默认的 `%LOCALAPPDATA%\agy\bin`；找不到报 cli-missing，提示 `irm https://antigravity.google/cli/install.ps1 | iex` 安装、首次启动选账号登录。2026-11-28 实测是原生程序 `%LOCALAPPDATA%\agy\bin\agy.exe`（`agy --help` 直接可跑），所以直接启动这个 exe，不经 cmd；刚装完时已开着的终端 PATH 里可能还没有它，找不到时按默认目录再找一次。
- 参数：
  - 新开不指定编号（agy 没有 `--session-id`），由 `SessionStart` 钩子上报 `conversationId`；
  - 续接 `--conversation <编号>`；没有编号不用 `-c`（它会接最近一条），同 Grok 报错让用户从历史里选；
  - `--model`（填了才带）；权限见 §4；
  - 初始提示用 `-i`（跑完提示留在交互界面）。
- 信任：agy 没有跳过信任的参数，也不能手写 `trustedWorkspaces`（那是用户设置，不写）。第一次在新目录开窗会停在信任确认，要用户在终端窗格里按一下，CLI 自己记下。启动就绪判断要等到确认之后（确认前打进去的字会丢）。探针看 `--dangerously-skip-permissions` 是否一并跳过信任。
- 环境：窗口令牌、管道名、写入根目录；按 Cursor 去掉 `MSYSTEM`、`EXEPATH`、`SHELL`（钩子走哪个 shell 官方没写，先照 Cursor 防着）；没设代理时补系统代理（复用 `cursorProxyEnv`，agy 读不读代理探针确认）。不设任何 Google 密钥变量。
- 开窗前后都不改 `~/.gemini`：新增 `assertNotUserAgyPath`，同 Cursor 的 `assertNotUserCursorPath`，写入目标落在 `~/.gemini` 下就拒绝。

### 3.3 工作区文件（`<项目>/.agents/`）

agy 的钩子和 MCP 只认全局（`~/.gemini/config/`，不能碰）和工作区两处，所以只能写项目里的 `.agents/`，做法同 Cursor 写 `.cursor/`：同项目多个窗口共用一份，靠环境里的窗口令牌区分；合并写，只增删本软件的条目，用户自己的原样保留；文件坏了不动它、这次不装、投递改手动；内容没变不写；写入前过 `assertNotUserAgyPath`。

**`.agents/hooks.json`**：钩子名 `ffpane-workbench`，事件和脚本参数：

| agy 事件 | 传给脚本的参数 | 做什么 |
|---|---|---|
| `SessionStart` | `AgySessionStart` | 上报会话编号 `conversationId`；`injectSteps` 交角色说明和技能清单 |
| `PreInvocation` | `AgyPromptSubmit` | 上报一轮开始；说明文件还在就先带上（续接可能没有 `SessionStart`）；未读消息正文放 `injectSteps` |
| `PostInvocation` | `AgyPostInvocation` | 问一次中途消息，有就放 `injectSteps`（`PostToolUse` 只能回空对象，不能用来插消息） |
| `PreToolUse` | `AgyPreToolUse` | 项目外写入检查：`write_to_file`、`replace_file_content`、`multi_replace_file_content` 看路径，`run_command` 当命令查；拒绝回 `decision: deny` + `reason` |
| `Stop` | `AgyStop` | `terminationReason` 正常结束 → Stop，带错误 → StopFailure；只回 `decision` 不要回 `continue` |

- 没有窗口令牌或管道（用户自己开的 agy）什么也不做，退出 0；stdout 只打最后的 JSON，调试走 stderr；输出只用 ASCII（中文写成 `\uXXXX`）。
- 钩子命令形如 `"<node>" "<workbench-hook.mjs>" Agy…`，路径带引号或 shell 会展开的字符就不装；node 先找系统的。钩子命令在 Windows 上由 `cmd /c` 执行（官方 hooks.md），工作目录是 `.agents`；2026-11-28 实测无头模式下 `node <脚本> <事件名>` 能正常跑，stdin 有 `conversationId`、`cwd`、`workspacePaths`，窗口令牌能传进来，`ANTIGRAVITY_CONVERSATION_ID` 也在环境里。脚本仍以 stdin 和我们注入的环境变量为准。命令里带引号的路径、中文和空格路径在 `cmd /c` 下的表现还没测，要在交互界面里补测。写入 `.agents/hooks.json` 时必须按 §2.2 的结构：`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop` 平铺，`PreToolUse` 分组；写完后核对 `cli.log` 里有没有 `Failed to parse hooks file`。`PreToolUse` 要放行就回 `auto_approve`，回 `allow` 只是不拦，命令仍会被权限检查拒绝。
- `PostToolUse` 不装；`PreToolUse` 的 matcher 留空匹配全部（MCP 放行也走这里，见下）。

**`.agents/mcp_config.json`**：根键 `mcpServers`，工作台、知识库、自配置各一条，先全走 stdio（`mcp-transport.ts` 表里 agy 填 stdio，HTTP 配置写法以后再补）。

- 令牌：官方没写 `env`、`headers` 里能不能展开变量。文件里绝不放令牌明文，只写占位符，真实值在 agy 进程环境；若 agy 不展开，退路是让 MCP 小进程自己从继承的环境读（agy 是否把环境传给 MCP 进程，探针确认，Cursor 就不传）。
- 放行：未配置的 MCP 工具默认每次问用户，管理者派的执行窗口会一直卡着。放行规则 `mcp(ffpane-workbench/*)` 的存放位置官方没写，用户设置又不能写，所以改用 `PreToolUse` 钩子：对工作台 MCP 的调用回 `decision: auto_approve`。懒加载时调用走内置 `call_mcp_tool`（参数 `ServerName`），钩子按它认服务器名；知识库、自配置照旧由 agy 询问。`auto_approve` 在 `run_command` 上已实测能跳过权限确认（2026-11-28，见 §5 第 2 项，回 `allow` 不行）；对 MCP 工具（含懒加载的 `call_mcp_tool`）是否同样有效，仍要用真实的工作台 MCP 进程验证。`run_command` 的命令在钩子 stdin 的 `toolCall.args.CommandLine`，项目外写入检查时按它解析。
- 服务器名不带下划线（`ffpane-workbench` 没问题）。

### 3.4 会话编号、说明和消息投递

- **编号**：新开靠 `SessionStart` 钩子上报 `conversationId`（2026-11-28 实测：新开时 `SessionStart` 的 stdin 有 `conversationId`，环境里的 `ANTIGRAVITY_CONVERSATION_ID` 与它一致，`PreInvocation`、`Stop` 等事件里也都有，所以不必等 `SessionStart`，任何一个事件拿到就能记下；`transcriptPath` 指向 `brain/<编号>/.system_generated/logs/transcript_full.jsonl`；续接时 `SessionStart` 是否再触发仍待测）。第三方桥接工具靠 `cache/last_conversations.json` 或最新的 `brain/<编号>/` 目录认领，只当钩子装不上时的退路，按本窗口启动时间和工作区过滤，认不准就标「未识别」，不静默接最近一条。
- **续接**：`--conversation <编号>`。`brain/<编号>/` 缺了会卡住（第三方报告），续接前检查这个目录在不在，不在就报错让用户从历史里选。
- **角色说明**：新开靠 `SessionStart` 的 `injectSteps`。说明放在 `FF_PANE_AGY_CONTEXT_FILE` 指的临时文件，读完就删（同 Cursor）；续接如果不触发 `SessionStart`，就在第一次 `PreInvocation` 带上。`injectSteps` 的格式已实测（2026-11-28）：`{"injectSteps":[{"systemMessage":{"systemMessage":"文本"}}]}`，`SessionStart` 和 `PreInvocation` 里都有效，注入内容在 transcript 里是 `SYSTEM_MESSAGE` 步骤；`systemMessage` 必须是嵌套对象，不能直接给字符串。`PreInvocation` 每轮可能触发多次（有工具调用时会再来一轮），所以不重复的内容（如说明文件）要自己去重。模型是否按注入内容作答，以及续接时 `SessionStart` 是否再触发，仍待验证。
- **消息投递**：有钩子 → 回合信号自动（`PreInvocation` 开始、`Stop` 结束），正文由钩子带进去；没装上 → 手动确认，提醒行带摘要。`Stop` 的 `fullyIdle` 可以当「真空闲」的信号。
- **排队**：agy 设置里 `queuedMessages` 默认 `queue`，忙时打进去的字会排队而不是丢，比 Cursor 宽松；投递仍等空闲，不依赖它。
- 回车时机、括号粘贴：第一期按 Cursor 的间隔（0.6 秒）先试，探针里核对。

## 4. 权限（`agy`）

agy 启动参数里和权限有关的只有 `--mode`、`--dangerously-skip-permissions`、`--sandbox`，都只管本次会话、不写设置文件。`toolPermission` 原本只能写在用户设置里，不碰；现在 `--settings` 可以只对本次会话传这个键（不保存），「可改可跑」这一档可以试 `--settings` 传 `toolPermission: proceed-in-sandbox`，是否可行、是否压过用户设置，等账号能对话后验证。

| 等级 | 参数 | 说明 |
|---|---|---|
| 只读 | `--mode plan` | 官方列的 `agentMode` 取值之一，只读规划 |
| 可改文件 | `--mode accept-edits` | 改文件自动接受，命令仍按用户设置询问 |
| 可改可跑 | 待探针：`--mode auto` 或 `--dangerously-skip-permissions` | agy 没有只放行命令的一档。不放行，管理者派的执行窗口会卡在命令确认（Cursor 真机吃过这个亏，agy 还没测过，预期同样）。官方写 `auto` 模式会自动开终端沙盒，可能正好是项目内放开；但 `auto` 对企业账号和旧版本不可用，也没写它到底批准什么，所以先不定 |
| 全部 | `--dangerously-skip-permissions` | 官方写明自动批准所有工具权限请求 |

- 项目外写入不管哪档都由 `PreToolUse` 钩子拦（T11.8）。关键前提：**`--dangerously-skip-permissions` 下钩子的 `deny` 是否仍然生效**，官方没写，探针必须验证。如果不生效，全部档就拦不住项目外写入，要退回 `--sandbox`，并如实写进使用说明。
- agy 自带的 `allowNonWorkspaceAccess` 默认关（不许访问工作区外），这是一层原生防护；但用户设置里可能被改成开，我们不能每窗口覆盖，只能靠钩子兜底。
- 映射表 `WorkbenchPermissionCli` 加 `agy`，4 档各一行，新开和续接同一组参数。
- `--mode` 和 Shift+Tab 的执行模式是同一个东西，用户在窗口里切换后，权限等级的显示会和实际不一致，只在使用说明里提一句，不做监控。

## 5. 风险与待验证（开工第一步先跑探针）

探针脚本和日志放 `test-results/scratch/agy-probe/`（不进库）。Tony 去登录、测试本机账号；探针需要装好 agy 并登录之后才能跑。

1. **基本信息**：`agy --help` 核对完整参数表（官方参考页是索引，部分参数没写取值）；`agy` 是 exe 还是脚本，能不能解析成原生程序直启；`--version`；有没有列出模型的命令；`--effort` 取值。
2. **账号能不能用（2026-11-28 实测：已通）**：Tony 说本机 agy 已经可以使用，`agy -p` 一句话返回 `OK`，退出码 0（模型 `gemini-3.8-flash-medium`）。此前（2026-11-27）同一台机器上报过 `Eligibility check failed: Your current account is not eligible for Antigravity`，那是账号资格问题，不是 agy 或本软件的问题。2026-11-28 共发了 5 条最短的真实请求，免费额度只用了这几条。实测结果：①钩子文件结构：`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop` 是平铺（直接放处理器对象，不套 `matcher` 和 `hooks`），只有 `PreToolUse`、`PostToolUse` 用分组结构（`matcher` 加 `hooks`）；结构不对时 agy 日志（`~/.gemini/antigravity-cli/cli.log`）会写 `Failed to parse hooks file ... command hook must specify 'command'`，整份钩子都不生效，我们自己写入 `.agents/hooks.json` 后要按这个日志核对。②stdin 有 `conversationId`、`workspacePaths`、`transcriptPath`、`cwd`、`lastUserInput`、`modelName`；环境里有 `ANTIGRAVITY_CONVERSATION_ID`，与 `conversationId` 一致；钩子进程的工作目录是 `.agents` 目录，项目根要看 stdin 的 `cwd`。③窗口令牌（`FF_PANE_WINDOW_TOKEN`）能传进钩子。④`injectSteps` 的 `{systemMessage:{systemMessage:文本}}` 在 `SessionStart` 和 `PreInvocation` 里都有效，标记出现在 transcript 的系统消息里；模型是否按注入内容回答，还没单独验证（那次请求里命令被拒，模型没有输出）。⑤`PreToolUse` 回 `allow` 不能放行：无头模式下 `run_command` 仍按 `command` 权限被自动拒绝；回 `auto_approve` 才放行，命令执行成功，`PostToolUse` 也触发；`run_command` 的参数在 `args.CommandLine`。⑥事件顺序：`SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`、`PostInvocation`，有工具调用时再来一轮 `PreInvocation`、`PostInvocation`，最后是 `Stop`，`terminationReason` 为 `NO_TOOL_CALL`，`fullyIdle` 为 true。⑦`MSYSTEM=MINGW64` 会带进钩子环境，不影响运行。仍未测：`--dangerously-skip-permissions` 下 `deny` 是否生效、`--settings`、`--mode` 各档、MCP、信任确认、交互界面里的行为、续接是否再触发 `SessionStart`。
3. **钩子执行环境**：Windows 上走哪个 shell、给钩子进程设了哪些环境变量、脚本退出码非 0 的含义、默认超时 30 秒够不够 node 启动。先照 Cursor 去掉 `MSYSTEM`、`EXEPATH`、`SHELL`。
4. **`.agents/` 要不要先信任**：工作区的 `hooks.json` 和 `mcp_config.json` 是否要用户确认或信任工作区之后才加载，加载时有没有弹窗。
5. **会话编号**：`SessionStart` 的 stdin 里 `conversationId` 是否真有；续接（`--conversation`）是否也触发 `SessionStart`；`brain/<编号>/` 和 `conversations/<编号>.db` 的位置对不对；`-i` 能不能和 `--conversation` 一起用。
6. **`injectSteps` 格式**：官方这页没展开。验证它能把角色说明、未读消息送进模型，以及注入的内容在界面里怎么显示。
7. **一轮有几次 `PreInvocation`**：`invocationNum` 说明一轮里可能多次触发。回合开始信号要按 `invocationNum` 去重（只认第一次），否则会把一轮当成好几轮。
8. **`Stop` 的返回值**：官方写 `decision` 必填，`continue` 会让它重新进入循环。观察型钩子应回什么值才不续跑，官方没列全；回错会让窗口一直转下去，探针里先试 `allow` 之类的值，并加一道保险：脚本绝不回 `continue`。
9. **MCP**：`env`、`headers` 里能不能展开环境变量；agy 是否把自己的环境传给 stdio 的 MCP 进程；懒加载的 `call_mcp_tool` 在钩子里长什么样；`PreToolUse` 回 `auto_approve` 能不能跳过 MCP 确认。
10. **权限档**：`--mode auto` 到底批准什么、命令还问不问；`--dangerously-skip-permissions` 是否一并跳过信任确认、钩子 `deny` 是否仍生效（§4）。
11. **信任确认**：新目录第一次开窗的确认界面长什么样，怎么判断启动就绪；回车时机和括号粘贴。
12. **代理和地区**：agy 读不读 `HTTPS_PROXY`；Cursor 在没代理时被地区限制拒过，agy 要不要同样补系统代理。
13. **同项目多个窗口共用 `.agents/`**：并发写入不互相覆盖，窗口令牌区分有效。

## 5.1 第一期代码（2026-11-28 已写完，待真机验收）

按 §6 的顺序做完了，没有提交。改动清单：

| 位置 | 改动 |
|---|---|
| `packages/shared/src/domain/workbench.ts` | 窗口种类加 `gemini`；运行时 `agy`；`runtimeToWorkbenchKind` / `workbenchKindToInjectionCli` 认得它 |
| `packages/shared/src/domain/project-config.ts` | 配置多一路 `gemini`（第一期只收本机登录） |
| `packages/core/src/workbench-permission/mapping.ts` | 权限表加 `agy` 四档：plan / accept-edits / accept-edits + skip-permissions / skip-permissions |
| `packages/storage/src/project-configs/store.ts` | 读写和校验 `gemini` 一路；中转写法直接拒绝 |
| `apps/desktop/src/main/workbench/agy-cli.ts`（新） | 找 `agy.exe`（PATH → `%LOCALAPPDATA%\agy\bin`）、进程环境、系统代理、`agy models` 解析 |
| `apps/desktop/src/main/workbench/agy-hook-config.ts`（新） | 合并写 `.agents/hooks.json`（平铺/分组结构按实测）、`.agents/mcp_config.json`、说明文件、`assertNotUserAgyPath` |
| `apps/desktop/src/main/workbench/cli-args.ts` | `buildInteractiveAgyArgs`：新开带开场白用 `-i`，续接 `--conversation` |
| `apps/desktop/src/main/workbench/launch-cli.ts` | `agy` 分支：定位、写项目文件、令牌占位、写入允许目录、回合信号、直接启动 exe |
| `apps/desktop/src/main/workbench/mcp-transport.ts` | `agy` 走 stdio |
| `apps/desktop/src/main/workbench/resolve-config.ts` | 配置里没有 `gemini` 这一路也能开（同 Cursor，本机登录） |
| `apps/desktop/src/main/data.ts` | `providers:list-local-models` 支持 `agy`（设置页读模型） |
| `apps/desktop/src/mcp/workbench-hook.ts` | Agy 五个事件的钩子：上报编号、注入说明/新消息、项目外写入守卫、工作台 MCP 回 `auto_approve` |
| 界面 | 新窗口对话框多一个 Gemini；图标；两种语言的文案 |

验证情况：

- 类型检查（主进程、渲染端、e2e）、biome、单测全过；新增 `apps/desktop/tests/workbench-agy.test.ts` 21 条。
- 真机核对：用本软件的合并逻辑生成 `hooks.json` 放进一个项目目录，`agy -p` 后日志是 `loaded 1 named hooks from 1 hooks.json file(s)`，没有 `Failed to parse hooks file`，说明结构和 agy 期望一致，`cmd /c` 也能执行我们写的钩子命令。
- 全量单测里 `packages/adapters/tests/gemini-cli.test.ts` 有一条「真机无认证」失败：本机 `gemini` 现在有了 OAuth 凭据（`~/.gemini/oauth_creds.json`），不再返回退出码 41，是那条测试的前提变了，与本次改动无关。

**2026-11-28 真机验收第一条（已通过）**：`--dangerously-skip-permissions` 下 `PreToolUse` 钩子的 `deny` 仍然生效。做法：在测试项目 `.agents/hooks.json` 装上本软件的钩子，环境里给 `FF_PANE_WRITE_ROOTS` 只含项目目录，跑 `agy -p ... --dangerously-skip-permissions` 让它连写两个文件。结果：项目外的被拒（`tool call denied by pre-tool hook: 不能写到项目外…`，文件没生成），项目内的正常写入。§4 的这层安全前提成立，全放开档不必退回 `--sandbox`。

附带确认两件事：钩子进程继承 agy 进程的环境（`FF_PANE_WRITE_ROOTS` 真能传进去）；agy 实际执行命令的工作目录是它自己认的项目目录，和我们传入的 `cwd` 一致。

**2026-11-28 其余真机验收结果**

- **`agy models` 格式（改了代码）**：真实输出是 `id<TAB>显示名`（如 `gemini-4-neon-high<TAB>Gemini 4 Neon (High)`），第一行是 `Fetching available models...`。原来的解析器按 ` - ` 分隔写，一条都解析不出来；已按真实格式重写并兼容旧写法。**`--model` 要的是左边那个 id，不是显示名**（§3.1 里写的「显示名」是错的）。本机 27 个模型全部正确解析。
- **续接（通过）**：`--conversation <编号>` 接回同一段对话，之前说的暗号记得。日志是 `Print mode: resuming conversation <编号>`。
- **续接不触发 `SessionStart`（确认）**：所以说明文件必须靠第一次 `PreInvocation` 带上，钩子已经这么做。
- **MCP 令牌（改了代码）**：agy **不展开** MCP `env` 里的 `${VAR}`，原样传字符串；但会把自己的环境原样交给 MCP 子进程。所以 `agy-inherit` 接法：配置文件里一个令牌字段都不写，子进程直接继承 `FF_PANE_WINDOW_TOKEN` / `FF_PANE_WB_PIPE`，已真机确认能拿到。文件里因此不含密钥，`assertTokenAbsent` 仍然成立。
- **副作用（不是本软件的问题）**：agy 把整个环境传给 MCP 子进程，包括启动它的进程环境里的东西。FF-pane 开窗时本来就剥掉 API key 类环境（`stripApiKeyEnv`），所以正常使用下不会外泄；但说明里要提醒：别在带密钥的 shell 里手开 agy。

**还没验证的**（下一轮真机验收要逐条过）：

1. 交互界面里新开 Gemini 窗口：信任确认、启动就绪、回车时机（无头模式测不了）。
2. ~~续接是否接回同一段、是否再触发 `SessionStart`~~ —— 2026-11-28 已验证：接回同一段；续接不再触发 `SessionStart`。
3. `-i` 带开场白在交互界面里的表现（`-p` 模式验证不了）。
4. ~~`--dangerously-skip-permissions` 下 `PreToolUse` 的 `deny` 是否仍生效~~ —— 2026-11-28 已真机验证通过（见本节开头）。
5. `accept-edits` 档下命令是否确实逐条询问；`yolo` 档是否一切放行。
6. MCP：令牌已确认能用（继承，不靠占位符展开）；仍待验：工作台工具能否真的调通，懒加载的 `call_mcp_tool` 与 `auto_approve` 是否如预期。
7. 同项目多窗口共用 `.agents/` 不互相覆盖。
8. ~~设置页「读取本地模型」~~ —— 2026-11-28 已按真实输出重写解析器并验证（27 个模型全对）。仍待验：界面上的按钮点了之后显示是否正常。

## 6. 开发顺序（Tony 说开工、探针通过后）

1. 探针（§5）→ 把结果补回本计划，计划里写「待探针」的地方都要落实。
2. 共享类型：窗口种类 `gemini`、项目配置多一路 `gemini`（本机登录）、`workbenchKindToRuntime` 增加 `agy`、MCP 运行时表、权限映射表、i18n。
3. 启动参数：`cli-args.ts` 加 `buildInteractiveAgyArgs`；`resolve-config.ts` 里 Gemini 同 Cursor，配置里没有这一路也能开。
4. 新建 `agy-cli.ts`（定位、环境、代理）和 `agy-hook-config.ts`（`.agents/hooks.json`、`.agents/mcp_config.json`、说明文件、`assertNotUserAgyPath`）。
5. `launch-cli.ts` 加分支：回合信号、空闲投递、提交核对、说明和技能清单（沿用 `developerInstructions` 那条路）；`auth-registry` 不用改，已按所有 AI 窗口登记。
6. 钩子脚本 `workbench-hook.mjs` 加 Agy 分支；`mcp-transport.ts` 登记 agy 走 stdio。
7. 界面：新开窗口对话框、配置编辑（只有本机登录一路）、窗口图标、设置页、安装与登录提示。
8. 单测 + 真机验收（对照 Cursor 窗口计划 §5：界面起来、工作台工具能调、自动投递、续接同一编号、项目外写入被拒）。

涉及文件按 Cursor 接入估：主进程 `workbench/` 下约 10 个、`shared`、`core`、`storage` 各 2 到 3 个、渲染端约 8 个，工作量和 Cursor 窗口相当；第一期不动 provider 模板和注入。

## 7. 第二期做法（中转路，`gemini`）

### 7.1 窗口种类和路由

- 窗口种类 `gemini` 和项目配置里的 `gemini` 一路第一期已经加好（§3.1）。第二期给这一路加上「中转」连法，和 Claude、Codex 一样两种连法都有。
- 连法决定跑哪个程序：中转跑 `gemini`，本机登录跑 `agy`（§3）。`workbenchKindToRuntime` 要改成按连法分开；权限映射、MCP 传输表、钩子脚本因此各有 `agy`、`gemini` 两套，不能混用。
- 没有思考强度（`gemini` 没有对应参数）、没有压缩比例、不能用启动参数关子 agent，同 Grok 只靠说明书。

### 7.2 中转来源

- 内置模板加 `gemini-compatible`，适用 CLI 加 `gemini`，地址和密钥必填。
- 注意：`gemini` 说的是 Gemini 原生接口（密钥走 `x-goog-api-key`），不是 OpenAI 兼容接口，现有 `openai-compatible` 的中转站不能直接拿来用。探测方式要新增一种 `gemini`（`PROVIDER_PROBE_KINDS`）。
- 注入：`GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL` 只进进程环境，不进 argv、不落盘。`session/env.ts` 旧路径里的 `GEMINI_API_BASE` 不是这个 CLI 认的变量，不能沿用；改走表驱动解析器，`provider-injection/resolve.ts` 加一行，`asTemplateCli` 加 `gemini`。

### 7.3 启动

- 程序：PATH 上的 `gemini`（npm 全局的 shim，`resolveDirectCliTarget` 已会解析 shim 直启）。没装报 cli-missing，提示 `npm i -g @google/gemini-cli`。
- 参数：`--skip-trust`；新开 `--session-id <新 UUID>`，续接 `--resume <UUID>`（没有编号不开选择器，同 Grok 报错让用户从历史里选）；权限（§7.6）；`-m <模型>`（配置里填了才带）；初始提示作位置参数。
- 环境：`GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、窗口令牌、管道名、写入根目录；环境里没设代理时补系统代理（复用 `cursorProxyEnv`）。不再设 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`（Windows 上被安全检查跳过，见 §7.7 第 4 项）。信任：参数 `--skip-trust` 与环境变量 `GEMINI_CLI_TRUST_WORKSPACE=true` 二选一，实测后者在 `-p` 下有效；交互界面下是否也能跳过信任弹窗，待真机核对。

### 7.4 项目级 settings 文件（`<项目>/.gemini/settings.json`）

原计划靠 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 给每个窗口单独指一份 settings，实测作废：Windows 上 gemini 0.71.1 的安全检查组要求目录属于管理员或 SYSTEM，窗口临时目录归当前用户，文件被直接跳过（§7.7 第 4 项）。改成写项目级 `.gemini/settings.json`，做法同 Cursor 写 `.cursor/`：

- 同项目多个窗口共用一份，靠环境里的窗口令牌区分；合并写，只增删本软件的条目，用户自己的原样保留；文件坏了不写、这次不装、投递改手动；内容没变不写；写入目标落在 `~/.gemini` 下就拒绝（照 Cursor 的 `assertNotUserCursorPath` 写一个）。
- 带项目级钩子启动时 gemini 会打印「检测到项目级钩子」的警告，交互界面里会不会要求确认，待真机核对；如果要求确认，开窗后要等用户在窗格里放行。

文件内容：

- `security.auth.selectedType`：实测 `gemini-api-key` 能让 gemini 认 `GEMINI_API_KEY` 认证（可作参考，真实取值以交互界面选一次后写进用户设置的内容为准）。这一项其实属于用户级设置，写项目级不一定被采纳；如果没生效，`gemini` 会退回到用户自己在 `~/.gemini/settings.json` 里选过的认证方式，所以启动前要检查用户级设置，认证不是 API key 时给提示，不去改它。
- `hooks`：五个事件，命令形如 `<node> <workbench-hook.mjs> Gemini…事件名`，路径不安全时不装钩子、投递改手动（照 Cursor）。实测项目级 hooks 生效。
- `mcpServers`：工作台、知识库、自配置。第二期先走 stdio（`mcp-transport.ts` 表里 gemini 填 stdio）：文档只写了 `env` 块会展开 `$变量`，`headers` 里能不能展开没写，令牌怎么传见 §7.7 第 1 项。
- 文件里不放令牌和密钥，启动前照旧扫一遍。

### 7.5 钩子脚本（`workbench-hook.mjs` 加 Gemini 分支）

| 事件 | 传给脚本的参数 | 做什么 |
|---|---|---|
| `SessionStart` | `GeminiSessionStart` | 上报会话编号；`additionalContext` 交角色说明和技能清单。续接也触发（`source=resume`），比 Cursor 省一步 |
| `BeforeAgent` | `GeminiPromptSubmit` | 上报一轮开始；未读消息正文放 `additionalContext` |
| `AfterAgent` | `GeminiStop` | 上报一轮结束 |
| `BeforeTool` | `GeminiPreToolUse` | 项目外写入检查：`write_file`、`replace` 看路径，`run_shell_command` 当命令查；拒绝回 `decision: deny` + `reason` |
| `AfterTool` | `GeminiPostToolUse` | 问一次中途消息，有就放 `additionalContext` |

- 没有窗口令牌或管道（用户自己在终端里开的 gemini）就什么也不做，退出 0。
- 脚本只往 stdout 打最后的 JSON，调试信息走 stderr；输出只用 ASCII（中文写成 `\uXXXX`），防控制台代码页弄乱。

### 7.6 权限（`gemini`）

| 等级 | 参数 | 说明 |
|---|---|---|
| 只读 | `--approval-mode plan` | 只读模式 |
| 可改文件 | `--approval-mode auto_edit` | 改文件自动批准，命令仍询问 |
| 可改可跑 | `--approval-mode yolo` | 没有只放行命令的一档；不放行执行窗口会卡在命令确认（Cursor 吃过同样的亏），所以同 Cursor 这一档不再询问 |
| 全部 | `--approval-mode yolo` | 全部放行 |

- 项目外写入不管哪档都由 `BeforeTool` 钩子拦（T11.8）。`--sandbox` 在 Windows 上要不要加，等第二期探针结果（§7.7），先不加。
- 映射表 `WorkbenchPermissionCli` 加 `gemini`，4 档各一行，新开和续接同一组参数。
- 全放开 `yolo` 是否仍会弹启动确认、`plan` 模式下 `BeforeTool` 钩子是否照样触发，要真机核对。

### 7.7 风险与待验证（第二期开工第一步先跑探针）

探针脚本和日志放 `test-results/scratch/gemini-probe/`（不进库）。

1. **令牌怎么传给 MCP**：文档只写了 `env` 块能展开变量，`headers` 不一定行。可行路径：stdio 小进程，令牌放 `env` 块写 `$FF_PANE_WINDOW_TOKEN`，真实值在进程环境；HTTP 路留到探针确认 `headers` 展开后再切。
2. **钩子在 Windows 上用哪个 shell（2026-11-27 部分实测，非交互 `-p` 模式）**：钩子命令 `node <脚本> <事件名>` 在 Git Bash 环境下能正常跑完，stdin 给 JSON、stdout 回 JSON 都有效，退出码 0。环境里的 `MSYSTEM` 去不掉：启动 gemini 时 `env -u MSYSTEM` 去掉后，钩子里仍是 `MINGW64`（gemini 会重启自身，环境里有 `GEMINI_CLI_NO_RELAUNCH`），`SHELL` 能去掉；钩子目前没被它带歪。仍待验证：真实交互界面里钩子走的 shell、带中文和空格路径的命令是否正常，所以钩子命令仍按 Cursor 的办法：路径带引号或 shell 会展开的字符就不装，输出只用 ASCII。
   另外已实测钩子环境变量：`GEMINI_PROJECT_DIR`、`GEMINI_CWD`、`GEMINI_SESSION_ID`、`GEMINI_PLANS_DIR` 由 gemini 设置，外层环境（含 `FF_PANE_WINDOW_TOKEN`）会继承。
3. **`selectedType` 取值（2026-11-27 部分实测）**：没有文档可依，试出 `gemini-api-key` 能让 gemini 认 `GEMINI_API_KEY` 认证（隔离 home 下 `--list-sessions` 从「必须指定 GEMINI_API_KEY」变成正常退出）。但这一项属于用户级设置，写在项目级文件里不一定被采纳；真实取值以交互界面里选一次「Use Gemini API Key」后写进用户设置的内容为准（Tony 本机 `~/.gemini/settings.json` 里那个值不是类型名，说明这一步可能没做对）。启动前要读用户级设置判断认证方式，不是 API key 就给提示，不去改。
4. **每窗口 settings（2026-11-27 实测：作废）**：gemini 0.71.1 在 Windows 上会检查 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 指向文件所在的目录，要求目录属于管理员或 SYSTEM 账号、普通用户不能写，否则直接跳过该文件（`Security Warning: Skipping system settings file`）。我们的窗口临时目录归当前用户，所以 §7.4 靠它做每窗口隔离的做法行不通。改用项目级 `<项目>/.gemini/settings.json`：`mcpServers` 和 `hooks` 都实测被读到（`gemini mcp list` 能看到、钩子能触发）。做法同 Cursor 写 `.cursor/`：同项目多个窗口共用一份，靠环境里的窗口令牌区分；合并写，只增删本软件的条目；写入前拒绝落在 `~/.gemini` 下。§7.4 要按这个改写。带项目级钩子启动时 gemini 会打印「检测到项目级钩子」的警告，交互界面里会不会弹确认还没验证。
5. **`--session-id` 与 `--resume <uuid>` 配合（2026-11-27 实测：通过，gemini 0.71.1，本地假接口、假 key）**：`--session-id <UUID>` 预分配的编号，与钩子 stdin 的 `session_id`、钩子环境变量 `GEMINI_SESSION_ID` 三者一致；`--resume <同一编号>` 续接成功，续接时 `SessionStart` 的 `source` 为 `resume`（新开是 `startup`）。会话文件在 `<GEMINI_CLI_HOME 或用户目录>/.gemini/tmp/<项目名>/chats/session-<时间>-<编号前8位>.jsonl`。所以做法同 Claude：新开预分配编号，续接用编号，不用像 Cursor 那样等钩子上报，也不用像 Codex 那样认领。另外实测：`SessionStart` 和 `BeforeAgent` 返回的 `hookSpecificOutput.additionalContext` 都出现在发给模型的请求体里，角色说明和未读消息的投递路径成立；`FF_PANE_WINDOW_TOKEN` 能传到钩子进程；请求走 Gemini 原生路径 `/v1beta/models/<模型>:generateContent` 和 `:streamGenerateContent?alt=sse`，密钥在 `x-goog-api-key` 头里、没有 Bearer 头，证实中转站必须支持 Gemini 原生接口。
6. **`-i` 初始提示**：是否等 `SessionStart` 钩子跑完再提交，回车时机（Cursor 是 0.6 秒间隔），按 Cursor 的做法先试。
7. **中转站协议**：确认用户的中转站收 `x-goog-api-key` 和 Gemini 原生路径（`/v1beta/models/...`）。只给 OpenAI 兼容接口的中转站，`gemini` 用不了；这是产品上要对用户讲清的限制。
8. **旧版本**：`GOOGLE_GEMINI_BASE_URL` 在 2026-04 才被核心代码认（第三方记录）；更老的 `gemini` 会忽略它，启动前可用 `gemini --version` 报个提示。
9. **`BeforeTool` 与 deny（2026-11-27 实测，非交互 `-p` 模式，本地假接口、假 key）**：
   - `--approval-mode yolo` 下，`BeforeTool` 触发，stdin 有 `tool_name: write_file`、`tool_input.file_path`、`tool_input.content`；钩子回 `{"decision":"deny","reason":"..."}` 后文件没有创建，`reason` 出现在下一次发给模型的请求体里。**yolo 下钩子的 deny 生效**，项目外写入检查这条路成立（T11.8）。
   - `--approval-mode default` 下 `-p` 没触发钩子、文件也没创建，模型第二次请求里已带 `functionResponse`。推测是写文件要用户确认，非交互模式没人确认就直接拒了，没走到钩子。这不能说明钩子在 default 下失效，只说明 `-p` 测不了 default 档，要用真实交互终端再测。
   - 仍待验证：`replace`（改文件）的 `tool_input` 字段名；脚本异常退出码非 0、非 2 只是警告、退出码 2 会拦下 `BeforeTool`（官方文档说法，没实测），脚本里别误用；用 MCP 工具时 `tool_name` 是否为 `mcp_<服务器>_<工具>`。
   - `auto_edit`（2026-11-27 实测）：`write_file` 时 `BeforeTool` 照样触发，文件被创建（这一档本来就不问改文件）；`run_shell_command` 时钩子没触发，因为命令要确认、`-p` 没人确认就被拒在钩子之前。
   - `plan`（2026-11-27 实测）：`write_file`、`run_shell_command` 都被拒，`BeforeTool` 没触发。plan 本身不改任何东西，项目外写入检查在 plan 下不生效，但实际不构成漏洞；这一档的只读靠 gemini 自己的 plan 模式，不靠钩子。
   - `run_shell_command` 的 `tool_input` 实测是 `{ command, description }`，`tool_name` 是 `run_shell_command`。
   - MCP 握手和调用工具还没测通：探针里那个只会 `setInterval` 的 node 进程不是 MCP 服务器，gemini 启动时一直等它握手，导致 `-p` 卡到超时。启动就绪判断要考虑 MCP 慢握手，要用真正的 MCP 服务器（工作台的小进程）再测。

### 7.8 开发顺序（第一期做完、Tony 说开工后）

1. 探针（§7.7）→ 补回本计划。
2. 共享类型：窗口种类和项目配置的 `gemini` 一路第一期已加；这里补模板 id `gemini-compatible`、探测方式 `gemini`、`workbenchKindToRuntime` 按连法分开（§7.1）、MCP 运行时表加 gemini、权限映射加 gemini 的 4 档、i18n。
3. 注入：`provider-injection` 加 `gemini`，`env.ts` 去掉错误的 `GEMINI_API_BASE`。
4. 启动：`cli-args.ts` 加 `buildInteractiveGeminiArgs`，新建 `gemini-cli.ts`（定位、代理、环境）和 `gemini-hook-config.ts`（本窗口 settings），`launch-cli.ts` 加分支。
5. 钩子脚本 Gemini 分支，`auth-registry` 不用改（已按所有 AI 窗口登记）。
6. 界面：新开窗口对话框、配置编辑、窗口图标、设置页。
7. 单测 + 真机验收（对照 Cursor 窗口计划 §5）。

涉及文件按 Cursor 接入估：主进程 `workbench/` 下约 10 个、`shared`、`core`、`storage` 各 2 到 3 个、渲染端约 8 个，工作量和 Cursor 窗口相当。

## 8. 第一期的难点说明（agy 本机登录，已并入 §3 至 §6）

本节是最初的调研记录，保留作对照；最新的做法以 §3 至 §6 为准。当时的判断是这一路比中转路难，原因是官方资料缺口大：

- 钩子、MCP、会话文件位置、新开预分配编号、代理，目前都没查到官方说明。没有钩子就拿不到回合信号，投递只能手动确认；没有预分配编号就要在 `agy` 退出时提示的续接命令里取，或扫会话文件认领（类似 Codex 的认领）。
- 每窗口隔离做不到：设置文件固定在 `~/.gemini/antigravity-cli/settings.json`，没查到覆盖路径。如果要改 `toolPermission`，会动用户全局设置，违反「不写用户目录」的原则；只能靠 `--dangerously-skip-permissions` 一类启动参数，且 `--mode` 的含义没查清。
- 账号层面：官方论坛有 AI Pro 账号 `Eligibility check failed` 的报告，部分模型已限制给 Ultra / 企业档，免费或 Pro 账号可能只剩 Flash，要先让 Tony 用自己的账号确认能不能正常对话。
- 本机没装 `agy`。

后续：第二轮调研已经查到 agy 的钩子、MCP 和会话资料（见 §2.2），当时的缺口大半补上，Tony 也定了先做 agy。剩下的官方空白（钩子的 shell 和环境变量、`injectSteps` 格式、信任确认、权限档的真实行为）由 §5 的探针落实：Tony 登录 agy 后跑探针，再开工。第一期做完后窗口种类和路由已经具备，第二期（§7）只需新增 `gemini` 的启动分支和中转注入。

## 9. 已定与待办

已定（Tony 2026-11-27）：

1. 分两期做：第一期本机登录 `agy`，第二期中转 `gemini`。
2. 中转站最好支持 Gemini 原生接口，都是配合 CLI 工具用；第二期探针时再核实用户实际用的那家是否收 `x-goog-api-key` 和原生路径。
3. Tony 还没登录 agy，他自己想办法测试；计划先写完，不等登录。

待办：

1. 【进行中，2026-11-28】agy 账号已能对话（见 §5 第 2 项），钩子结构、`conversationId`、窗口令牌、`injectSteps`、`auto_approve` 已实测。还剩的探针（探针放在 `test-results/scratch/agy-probe/`，每次只发一条最短请求，免费额度有限）：①`--dangerously-skip-permissions` 下钩子 `deny` 是否生效（§4 关键前提）；②`--mode accept-edits` / `auto` / `plan` 各档下命令和写文件的真实行为；③`--settings` 能放哪些键、是否压过用户设置；④`--conversation <编号>` 续接是否再触发 `SessionStart`，`-i` 能否与它同用；⑤MCP：`env` 展开、环境是否传给 stdio 进程、懒加载 `call_mcp_tool` 在钩子里的样子；⑥交互界面里的信任确认、启动就绪判断、回车时机（需要真实终端，无头 `-p` 测不了）；⑦`Stop` 观察型钩子回什么值不续跑（目前不回内容、脚本不回 `continue`）。测完把结果补回 §3 至 §6 里写「待探针」的地方。
2. 探针通过、Tony 说开工，再按 §6 的顺序写代码。在此之前不动代码、不动项目里的 `.agents/`、不碰 `~/.gemini`。
   - 2026-11-28：Tony 说开工，第一期代码已写完（§5.1），等真机验收后提交。
3. 第二期开工前，先确认 §7.7 的探针和中转站协议。

## 10. 登录状态与界面体验（2026-11-28，Tony 要求对照 Codex、Cursor 补齐）

只有设计，没动代码。

### 10.1 现状的缺口

- 设置页的配置编辑器没有 Gemini 一块：用户没地方选连法，也没地方选 agy 模型，没有「读取模型」按钮。后端存储认 `gemini` 一路，界面没有入口。
- 新建窗口对话框把 Gemini 当成 Cursor 那样直接按本机登录放行，不检查 agy 装没装，也不看登没登录，要等开窗失败才知道。
- 配置缺失的报错文案里，Gemini 会落到「Codex」这个默认词上。

### 10.2 怎么判断 agy 登没登录（2026-11-28 实测）

- agy 没有 `status`、`login`、`logout`、`whoami` 子命令（`agy --help` 实测，子命令只有 acp、agent、changelog、install、mcp、models、plugin、remote-control、update 等）。登录只能在 agy 自己的交互界面里完成，不能像 Cursor 那样由软件跑 `login` 取链接。
- 登录信息在 Windows 凭据管理器的 `gemini:antigravity` 条目里，不在 `~/.gemini`。换 HOME 隔离不了：空 HOME 照样认证成功，日志写 `authenticated via keyring`。
- 判断办法：`cmdkey /list` 的输出里有没有一行 `LegacyGeneric:target=gemini:antigravity`。这一段是纯 ASCII，不受系统语言影响；真名命中 1 条，编造的名字命中 0 条。主进程用 execFile 直接调 `cmdkey`，不经 Git Bash，没有路径改写问题。
- 不能用的办法：
  - `cmdkey /list:名字`：退出码存在和不存在都是 0，输出是本地化文字（GBK）。
  - `agy models`：已登录和空 HOME 下都能列出模型，不能区分。
  - `cli.log` 里的「not logged into Antigravity」：每次启动瞬间都会出现，已登录也有，只是噪音。
- 条目在，只说明登录过，不保证令牌现在有效。令牌过期时 agy 会用刷新令牌自己续；真失效要等试连或开窗才知道，所以界面留「连接失败」一档。
- 没验证：条目真的不存在时 agy 的行为。不为测这个把 Tony 的账号退出来。

### 10.3 界面做法

四种状态：没装、没登录、已登录、连接失败。状态检测在主进程做（新通道 `gemini:status`），只读 `cmdkey` 和 agy 是否存在，不调用模型，不耗额度，不弹窗；每次打开新建窗口对话框读一次。

- 新建窗口选 Gemini：显示一行状态，样子照 Cursor 的账号面板。
  - 没装：拦住，给「去安装」，官方命令 `irm https://antigravity.google/cli/install.ps1 | iex`，界面确认后才跑。
  - 没登录：标黄，不拦；说明「先在 agy 里登录」，并给一个「打开登录窗口」按钮，开一个普通 agy 终端窗口让用户在里面登录，关掉后状态自动刷新。agy 首次启动是否自己提示登录，交互界面里还没验证。
  - 已登录：显示「已登录 · 本机登录 · 模型 xxx」。
  - 连接失败：标红并给原因。来源是读取模型失败，或开窗时 agy 报错。
- 设置页配置编辑器加 Gemini 一块：
  - 连法下拉放「本机登录（agy）」和「中转（gemini CLI）」；中转现在不可选，标「下一期支持」，第二期只需放开。
  - 模型输入框加「读取模型」按钮，跑 `agy models`（约 7 秒，要联网，不耗额度）；读到的模型给下拉。它同时当连通性检查，失败就把状态标成「连接失败」。
  - 不显示思考强度：agy 的模型 id 本身带档位，例如 `gemini-4-neon-high`。
- 新建窗口对话框：显示「使用配置 xxx（本机登录）」；配置缺失提示里的程序名改成 Gemini；没装 agy 时和 Claude、Codex 一样拦住。

### 10.4 代码范围（Tony 说开始后）

- 主进程：新增 `gemini:status`（读 `cmdkey` 和 agy 位置），`providers:list-local-models` 加 agy 一路，`shared-ipc/contracts.ts` 加类型。
- 渲染进程：新增 Gemini 账号面板，`NewWindowDialog.tsx` 接入，`ConfigEditorDialog.tsx` 加 Gemini 一块，两份 locales 加文案。
- 测试：状态解析（命中、不命中、没装），读取模型失败时的状态。

### 10.5 默认做法与待定

- Tony 说其他细节我自己优化，上面是按 Codex、Cursor 的体验取的默认做法。
- 待真机验证：「打开登录窗口」这条路里，agy 首次启动的登录提示和登录完成后凭据条目出现的时机。验证前先按「提示用户自己在 agy 里登录」的最保守说法写文案。

### 10.6 实现记录（2026-11-28 已写完，待真机验收）

- 主进程：`apps/desktop/src/main/gemini-account.ts` 新增 `gemini:status`（agy 在不在 + `cmdkey /list` 里有没有 `target=gemini:antigravity` 一行，行尾必须到头，不把名字相近的条目当成它）和 `gemini:install`（官方安装命令，界面先确认）。`cmdkey` 的输出按 latin1 读，只认 ASCII 段。契约和通道名单在 `shared-ipc/contracts.ts`，处理器在 `index.ts` 注册。
- 新建窗口：新增 `components/gemini/GeminiAccountPanel.tsx`，四种状态：没装（拦住，给「安装 agy」，确认后才跑）、没登录（标黄，提示怎么登录）、已登录（显示「已登录 · 本机登录 · 模型」）、连接失败（标红带原因）。「已登录」之后后台读一次 `agy models` 当连通性检查，失败就转成连接失败。没装拦开窗，没登录不拦。报错文案里的程序名补上 Cursor 和 Gemini，不再落到 Codex。
- 设置页：配置编辑器加 Gemini 一块。连法下拉里「中转」置灰，标「下一期支持」；模型框带「读取已探测的模型」，走 `agy models`；不显示思考强度。
- 和 §10.3 不同的一处：没有做「打开登录窗口」按钮。agy 首次启动会不会自己提示登录还没在交互界面里验证，先不替用户开窗口，改成文案告诉用户在终端里运行 agy 登录，再点「重新检查」。验证后再决定要不要加按钮。
- 测试：`apps/desktop/tests/gemini-account.test.ts` 9 条（命中、名字相近不误判、没装、读凭据失败、非 Windows）。全量单测除了老的 `gemini-cli.test.ts` 无认证真机测试外全部通过；类型检查、文案检查通过；biome 只剩别的会话的 `.claude/`、`.mcp.json` 解析报错。
- 没验证：界面在真实窗口里的样子，以及条目不存在时 agy 的实际表现（不为测这个把 Tony 的账号退出来）。

## 11. Provider 口径更正与补齐（2026-11-28，Tony 指出 Provider 页加不了 agy）

### 11.1 口径更正

Provider 是**模型来源**，不固定是中转还是登录：Claude、Codex 有「订阅账号登录」（`local-login` 模板）和「中转」两个方向，Gemini 也一样。前面 §3、§7、§10 里「Provider = 中转来源，所以 Gemini 第一期不进 Provider」的说法是错的，以本节为准。

### 11.2 现状与根因

- 后端早有 agy：`gemini:status` 读登录、`providers:list-local-models` 的 `agy` 一路读模型，窗口种类和项目配置路由也在。
- 缺口全在 Provider 这一层：
  1. 设置页 Provider 编辑器「本机已登录」里的 CLI 下拉写死只列 `claude-code`、`codex`（`ProviderEditorDialog.tsx` 的 `VISIBLE_CLI_LOGIN_RUNTIMES`），选不到 agy，看不到 agy 登录状态，也读不了 agy 模型。
  2. `PROVIDER_TEMPLATE_CLIS` 没有 `gemini`，`local-login` 的适用 CLI 只有 claude-code、codex，模板卡片和注入映射表里没有 Gemini 的位置。
- 注意：`local-login` 在 Provider 里只是一条共享的「本地 CLI」来源，下拉只用来探登录状态和读模型，不落盘；配置里的 `local_cli` 路线本来就不带 providerId。所以订阅方向补的是 Provider 页的可见性和模板声明，不涉及存储格式。

### 11.3 分两步

**第一步（订阅方向，本次做）**
- `PROVIDER_TEMPLATE_CLIS` 加 `gemini`；`local-login` 适用 CLI 加 `gemini`；注入映射表登记 `local-login × gemini`（空映射，同 claude-code、codex）。
- Provider 编辑器 CLI 下拉加 `agy`：登录状态走 `gemini:status`（映射成同一种「已登录 / 未登录 / 未安装 / 未知」徽章），「读取本地模型」走 `providers:list-local-models` 的 `agy`。
- 模板卡片文案、en-US、zh-CN 补上 Gemini（agy）。
- 测试：登录状态映射、探测缓存对 agy 的处理、模板与注入映射表对照。

**第二步（中转方向，仍是原第二期，§7）**
- 新增 `gemini-compatible` 模板、探测方式 `gemini`（原生接口，`x-goog-api-key`）、注入 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`，配置编辑器放开 Gemini 的「中转」，`store.ts` 放开 Gemini 路线的 providerId。
- 这一步要配套 `gemini` 启动分支（`gemini-cli.ts`、`gemini-hook-config.ts`），不做启动就放开模板会让用户配出开不了窗的来源，所以不单独先放。

### 11.4 Cursor、Grok 一并补上（2026-11-28，Tony 要求）

Provider 下拉里 Cursor、Grok 同样是漏的，原因同上：下拉名单是最早只有 Claude、Codex 时写死的，后来加了 DeepSeek、Cursor、Grok、Gemini 都没跟着改。已一起补：
- 下拉名单改成数据驱动（`LOCAL_LOGIN_PROBE_RUNTIMES`：claude-code、codex、grok-build、cursor、agy），以后加新的本机登录 CLI 只改这一处。
- Cursor：登录状态走 `cursor:status`，读模型走 `providers:list-local-models` 的 `cursor`。Grok：登录探测和读模型 adapters 早就有（`grok-build`），只是下拉没列。
- 模板：`PROVIDER_TEMPLATE_CLIS` 加 `cursor`；`local-login` 适用 CLI 变成 claude-code、codex、grok、cursor、gemini；注入映射表补 `local-login × grok / cursor`（空映射）。DeepSeek 只有中转，不在其中。
- 测试：下拉名单、Cursor 状态映射。全量单测 3127 通过，类型检查、i18n、biome 过。

### 11.5 实现记录（2026-11-28，第一步已写完，待真机看界面）

- 模板：`PROVIDER_TEMPLATE_CLIS` 加 `gemini`；`local-login` 适用 CLI 加 `gemini`；注入映射表登记 `local-login × gemini`（空映射）。
- Provider 编辑器「本机已登录」的 CLI 下拉多了 `agy`：登录徽章走 `gemini:status`（`agyStatusToProbeView` 转成已登录 / 未登录 / 未安装 / 未知），「读取本地模型」走 `providers:list-local-models` 的 `agy`。
- 文案：`local-login` 模板说明（zh-CN、en-US）写上 Gemini（agy）。
- 测试：`cli-login-ui.test.ts` 加 3 条状态映射。全量单测 3125 通过，桌面端类型检查、i18n 检查、biome 都过。
- 没验证：Provider 页在真实窗口里的样子；agy 在下拉里读模型的实际耗时（`agy models` 约 7 秒）。
- 第二步（中转）没动，见 §11.3。

### 11.6 Cursor 账号管理并进 Provider（2026-11-28，Tony 指出顶部和 Provider 里各有一个 Cursor）

- 原来设置 → 模型页顶部有一块独立的 Cursor（`CursorSection`），里面是软件内登录、换账号、退出、更新、安装 cursor-agent，以及 Cursor 窗口的默认模型；Provider「本机已登录」里新加的 Cursor 项只有登录状态和读取模型，两处看着重复，但功能不是一回事。
- 处理：顶部那块从设置页移除，原样嵌进 Provider 编辑器：选「本机已登录」、CLI 下拉选 `cursor` 时显示完整的账号管理，Provider 里不再单独探测 Cursor 登录徽章（避免两处各查一遍）。功能一个没删，默认模型仍写进全局设置 `cursorDefaultModel`，与保存 Provider 无关。
- 测试：`cursor-account.spec.ts` 改成先打开 Provider 编辑器再选 cursor；该 e2e 与 `provider-config-ux.spec.ts` 共 4 条通过，全量单测 3127 通过。

### 11.7 管理者开不了 agy 窗口（2026-11-28，管理者实测反馈）

- 现象：管理者调 `ffpane_open_window`，写 `cli: agy`，报「cli 只能是 claude、codex、grok、deepseek 或 cursor」。
- 根因：2.0.2 只把 Gemini 接进了 `launch-cli.ts`（启动本身）和新建窗口对话框的外观，**几个入口没放行 `gemini`**：
  1. `mcp-tools.ts` 和 `open-child.ts` 的 `cli` 白名单、`workbench-tools.ts` 的工具定义枚举（管理者开窗）；
  2. `handlers.ts` 的 `workbench:launch-cli`：`kind` 映射没有 `gemini`，直接抛「kind must be …」，所以**从界面新建 Gemini 窗口同样开不起来**，不只是管理者；
  3. `handlers.ts` 的重启白名单，以及钩子上报会话编号的分支（agy 新开靠 SessionStart 钩子上报 `conversationId`，没记下来，续接会断）；
  4. `resume-handoff.ts` 的类型。
- 修：以上全部放行 `gemini`；管理者写 `agy` 当作 `gemini` 的别名收下；工具说明里写上 gemini 启动 agy。会话编号并入 Claude、Cursor 同一个分支（凭窗口令牌上报，报来的就是本窗口的）。
- 测试：`workbench-mcp.test.ts` 加 2 条（`gemini`、`agy` 别名都能开；真正的开子窗口路径按 gemini 启动并记进布局）。全量单测通过。
- 没验证：真机用 agy 实际开出来（要装新包后由管理者或界面实测）；`handlers.ts` 的 kind 映射没有单测，靠类型检查和上面两条间接覆盖。
- 另一个缺口，已补：管理者的自配置工具（`config-tool.ts`）原来路由名单里没有 `gemini`，管理者没法用它改 Gemini 这一路。现在字段白名单、工具说明、解析、脱敏视图都带上 `gemini`；只收本机登录，写中转会被拒（和 Cursor 同口径）。主进程那一侧没有另一份名单，草案走存储层校验，那里本来就认。`mcp-config-tool.test.ts` 加 1 条；全量单测 3130 通过。
