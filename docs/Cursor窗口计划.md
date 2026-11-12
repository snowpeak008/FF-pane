# Cursor 窗口计划（T11.10）

> 状态：2026-11-09 Tony 登录好 Cursor CLI 后说「帮我开发一下吧」，写计划后直接开工，当天开发完成（1.0.29），待验收。§6 是开发中改掉的地方。
> 调研版本：Cursor CLI `2026.11.05-86047df`（Windows 11，`%LOCALAPPDATA%\cursor-agent`）。
> 真机探针脚本与日志在 `test-results/scratch/cursor-probe/`（不进库）。

## 1. 要做什么

工作台新开窗口时多一种「Cursor」，在终端窗格里跑 Cursor CLI 的交互界面，用本机 `cursor-agent login` 登录的账号（Tony 的账号是免费档，只能用 Auto、Grok 4.6、Grok 4.7）。
和 Claude、Codex、Grok 窗口一样：能当管理者/执行/检查等角色、能用工作台工具（发消息、汇报、开子窗口）、收到消息能自动投递、能续接、项目外不能写。

不做：中转来源（Cursor 只认自己的账号）、Cursor SDK（要 API key，而且是把代理塞进主进程，和终端窗格的做法不一样）。

## 2. 真机查到的事实

| 事 | 结论 |
|---|---|
| 安装 | 和编辑器分开装：`irm 'https://cursor.com/install?win32=true' \| iex`。装到 `%LOCALAPPDATA%\cursor-agent\`，`cursor-agent.cmd` → PowerShell → `versions\<版本>\node.exe index.js`。 |
| 命令名 | 同时装 `agent` 和 `cursor-agent`。本机 `agent` 被 Grok（`~/.grok/bin/agent`）占了，**只能认 `cursor-agent` 或直接找版本目录**。 |
| 直启 | 照 `cursor-agent.ps1`：取 `versions` 下日期最新的目录，跑 `node.exe index.js`，设 `CURSOR_INVOKED_AS=cursor-agent`、`NODE_COMPILE_CACHE`。不经 cmd / PowerShell。 |
| 会话编号 | `cursor-agent create-chat` 打印一个新编号；`--resume <编号>` 打开它。钩子里的 `conversation_id` / `session_id` 就是这个编号。 |
| 模型 | `--model <id>`，`cursor-agent models` 列出。免费档用 composer 会报 `Model unavailable on Free`。 |
| 权限参数 | `--mode plan`（只读规划）、`--force`（全部放行）、`--approve-mcps`（MCP 不再问）、`--sandbox enabled/disabled`、`--add-dir`。 |
| 插件 | `--plugin-dir <目录>`：`.cursor-plugin/plugin.json` + `mcp.json` + `hooks/hooks.json` + `skills/` + `rules/`。 |
| 插件 MCP | 能用。MCP 进程**不继承**CLI 的环境变量，但 `mcp.json` 里写 `${env:名字}` 会从 CLI 环境展开 → 令牌照 Grok 的办法传，文件里只有占位符。工具在 Cursor 里叫 `plugin-<插件>-<服务器>` 下的原名。 |
| 插件规则 | `rules/*.mdc`（`alwaysApply: true`）**不进模型**（问暗号答不出），不能用来放角色说明。 |
| 钩子 shell | Windows 上钩子命令走 PowerShell；但环境里有 `MSYSTEM` / `EXEPATH` / `SHELL`（Git Bash 带进来的）就改走 bash，命令全部报错，`beforeMCPExecution` 失败还会拦掉 MCP 调用。**Cursor 窗口的环境要去掉这三个**。 |
| 钩子命令格式 | `"<node.exe>" "<脚本>" <事件>` 实测可用（路径带空格也行）。钩子继承 CLI 的环境变量（令牌、管道名都在）。 |
| 一轮开始/结束 | 交互界面里 `beforeSubmitPrompt`、`stop` **只在用户级 `~/.cursor/hooks.json` 或项目级 `.cursor/hooks.json` 里有这个事件时才触发**，只写在插件里不触发（`3026.index.js` 的判断）。项目级目录是工作目录所在的 **git 根**，不是工作目录。 |
| 双份 | 项目级有了以后，插件里同名的钩子也跑，会报两次。所以钩子只放一处。 |
| 角色说明 | `sessionStart` 返回 `{"additional_context": …}` 能进模型（新开会话实测答出暗号）。续接（`--resume`）不触发 `sessionStart`。 |
| 提交时加上下文 | `beforeSubmitPrompt` 返回 `{"additional_context": …}` 能进模型（实测）。 |
| 干活中途 | `postToolUse` 返回 `{"additional_context": …}`（协议里有这个字段）。 |
| 写入检查 | `preToolUse` 返回 `{"permission":"deny","agent_message":…}`。工具名和输入：`Write {file_path, content}`、`Shell {command, cwd}`、`Read {file_path}`、`MCP:<名>`。 |
| 一轮结束状态 | `stop` 的 `status`：`completed` / `aborted` / `error`。 |
| 启动就绪 | 界面没起来时打进去的字会丢，回车不提交。`sessionStart` 钩子跑完前也不收输入。 |
| 信任目录 | 没见过的目录先弹「Workspace Trust Required」，界面卡住。`--trust` 帮助里写着只给无界面模式，实测交互界面也认。 |
| MCP 确认 | `--approve-mcps` 只放行加载服务器，每次调用工具仍弹「Run this MCP tool?」（可改文件档）。`preToolUse` / `beforeMCPExecution` 回 `allow` 都跳不过。项目 `.cursor/cli.json` 的 `permissions.allow` 写 `Mcp(*服务器名:*)` 能跳过；`allow`、`deny` 必须都是数组，少一个 CLI 直接退出。 |
| 插件服务器名 | Cursor 叫它 `plugin-<插件目录名>-<服务器名>`。 |
| 会话记录 | `~/.cursor/projects/<路径>/agent-transcripts/<编号>/<编号>.jsonl`，`~/.cursor/chats/<hash>/<编号>/`。 |

## 3. 做法

### 3.1 启动

- 新开：不指定编号，直接开。`sessionStart` 钩子把 Cursor 分的编号报回来，同时交说明、把窗口标成可投递（用 `create-chat` + `--resume` 就没有 `sessionStart`，第一条消息只能手动投）。续接：`--resume <记下的编号>`；没有编号不开选择器，同 Grok 报错让用户从历史里选。
- 参数：`--trust`、`--resume <编号>`、权限（§3.4）、`--model`（配置里填了才带）、`--approve-mcps --plugin-dir <本窗口插件目录>`、初始提示作为位置参数。
- 环境：`MSYSTEM`、`EXEPATH`、`SHELL` 写成 undefined 交给终端管理器（它把这份叠在主进程环境上，只有 undefined 才删得掉）；加 `CURSOR_INVOKED_AS`、`NODE_COMPILE_CACHE`；照常带令牌、管道名、写入根目录。

### 3.2 本窗口插件目录（`<数据根>/cursor-plugins/<窗口>/`）

- `.cursor-plugin/plugin.json`：名字 `ffpane`。
- `mcp.json`：工作台、知识库、自配置这几个服务器；令牌和信箱路径只写 `${env:…}`。
- 关窗、开窗失败都删。不含令牌和密钥（启动前照旧扫一遍）。

### 3.3 项目钩子（`<git 根或项目目录>/.cursor/hooks.json`）

- 合并写：只增删命令里带 `workbench-hook` 和 `cursor-` 事件名的条目，用户自己的条目原样保留；文件坏了不动它、这次不装钩子。
- 事件 → 脚本参数：`sessionStart`→`CursorSessionStart`、`beforeSubmitPrompt`→`CursorPromptSubmit`、`preToolUse`→`CursorPreToolUse`、`postToolUse`→`CursorPostToolUse`、`stop`→`CursorStop`。
- 脚本（`workbench-hook.mjs` 加 Cursor 分支）：
  - 没有窗口令牌/管道（比如用户在编辑器里打开项目）就什么也不做，退出 0。
  - `CursorSessionStart`：上报 SessionStart + 会话编号；输出本窗口的说明（角色 + 技能清单）。说明放在环境变量 `FF_PANE_CURSOR_CONTEXT_FILE` 指的临时文件里，**读完就删**。
  - `CursorPromptSubmit`：上报 UserPromptSubmit + 会话编号；说明文件还在（续接没有 sessionStart）就先带上；再照 Claude 取新消息正文 / 未读提示，拼成 `additional_context`。
  - `CursorPostToolUse`：上报 PostToolUse；问一次中途消息，有就 `additional_context`。
  - `CursorPreToolUse`：只做项目外写入检查（`Write`/`Edit`/`StrReplace`/`Delete` 看 `file_path`/`path`，`Shell` 当 PowerShell 查），拒绝输出 Cursor 的格式。
  - `CursorStop`：`completed`/`aborted` → Stop；`error` → StopFailure（错误类型 `unknown`）。
- 钩子用的 node：先找系统 node，没有就用 Cursor 自带的 `node.exe`（版本目录会随更新变，每次开窗重写文件）。
- 同项目多个 Cursor 窗口共用这一个文件，靠令牌认窗口，所以不用像 Grok 那样核对编号。

### 3.3b 项目权限（`<git 根或项目目录>/.cursor/cli.json`）

- `permissions.allow` 加 `Mcp(*ffpane-workbench:*)`，同 Claude 的 `--allowedTools mcp__ffpane-workbench`：只放行工作台工具，知识库、自配置照旧由 Cursor 询问。
- 合并写：只加不删，别的键和用户规则留着；`deny` 缺了补空数组；文件坏了不动它（工具调用时 Cursor 会问）。

### 3.4 权限

| 等级 | 参数 | 说明 |
|---|---|---|
| 只读 | `--mode plan` | Cursor 的只读规划 |
| 可改文件 | 不加 | 改文件直接改，命令按用户 Cursor 设置询问 |
| 可改可跑 | `--force` | Cursor 没有只放行命令的一档；不加参数每条命令都弹确认，管理者派的执行窗口会卡死，所以同 Codex 不再询问 |
| 全部 | `--force` | 全部放行 |

项目外写入不管哪档都由 `preToolUse` 拦（T11.8）。

### 3.5 其余

- 配置：项目配置多一路 `cursor`，只有本机登录；模型可空（空 = Cursor 默认 Auto）。没有思考强度（Cursor 的强度写在模型名里）。配置里没有这一路也能开窗（按本机登录）。设置页「列出模型」跑 `cursor-agent models`。
- 子 agent：Cursor 没有关子 agent 的启动参数，同 Grok 只靠说明书。
- 压缩比例：Cursor 没有这个设置，不传。
- 屏幕识别（等投递时看输入框）：没核对过，同 Grok 不看。
- 投递：有钩子 → 回合信号自动、消息正文走钩子（同 Claude）；没装上钩子 → 手动确认、提醒行带摘要。
- 技能：同 Codex / Grok，把清单接在说明后面。

## 4. 风险

- Cursor CLI 改钩子判断或插件格式：开窗时 `turnSignal` 会降成手动，不会错投。
- 在项目里写 `.cursor/hooks.json` 和 `.cursor/cli.json`：用户用 Cursor 编辑器打开项目时钩子也会跑，但没有令牌就立刻退出；`cli.json` 只放行本软件的工作台工具。和 Grok 写 `.grok/` 一样，使用说明里写明了。
- 免费档额度用完：CLI 自己在界面里报错，FF-pane 不处理。

## 5. 验收

- 新开 Cursor 窗口：界面起来、模型对、工作台工具能调。
- 给它发消息：自动投递，正文由钩子带进去，回一轮后窗口变空闲。
- 关掉再续接：同一编号，带上新的角色说明。
- 让它往项目外写文件：被拒。

## 6. 开发中改掉的地方（2026-11-09）

- 新开不用 `create-chat`（§3.1）：没有 `sessionStart` 就既交不了说明、也标不成可投递。
- 加 `--trust`：真机第一次开窗卡在信任确认。
- 加项目 `cli.json` 放行（§3.3b）：真机第一轮卡在 MCP 确认 5 分钟。第一版没写 `deny`，CLI 直接退出，已补。
- 环境变量要写成 undefined 才删得掉：真机从 Git Bash 启动的 FF-pane 里钩子仍走 bash。
- 插件目录改名 `ffpane`，服务器在 Cursor 里叫 `plugin-ffpane-ffpane-workbench`。
- 插件 `rules/*.mdc` 不进模型，说明走 `sessionStart` / 第一次 `beforeSubmitPrompt` 的 `additional_context`（计划写的就是这样）。
- 钩子输出只用 ASCII（中文写成 `\uXXXX`），防 PowerShell 控制台代码页把中文弄乱。

### 6.1 第一次实战（2026-11-09 晚，《海上生存》管理者开 Cursor 子窗口）

- **子窗口没挂到管理者名下**：`auth-registry.ts` 的 `toAuthNode` 只认 Claude / Codex，界面一回存布局，Cursor 子窗口就从权威表掉出去，管理者读输出、发消息、关窗都被拒「不是后代」。Grok、DeepSeek 子窗口从 T10.16 / T10.17 起就有同样的问题。改成所有 AI 窗口都进表；`set-role` 补登记、改模型强度、界面改权限和设管理者也一并放开。
- **任务没提交**：其实是 Cursor 拒了（`Model not available: This model provider is not supported in your region`），那一轮作废、任务说明退回输入栏。cursor-agent 是 Node 程序，不读系统代理。Cursor 窗口在环境里没有 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 时读 `HKCU\…\Internet Settings`，系统代理开着就设 `HTTPS_PROXY`、`HTTP_PROXY`（`NO_PROXY` 只放本机）。真机：窗口里 `$env:HTTPS_PROXY` 是 `http://127.0.0.1:7897`。
- **执行窗口卡在命令确认**：可改可跑一档改成 `--force`（见 §3.4）。
- 真机复验：Cursor 管理者开 Cursor 子窗口，子窗口自动开工，管理者列得出、读得到输出。
