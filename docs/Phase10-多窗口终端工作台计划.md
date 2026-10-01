# Phase 10 · 多窗口终端工作台 改造计划

> 状态：v1.0（Tony 已确认，执行中；**T10.0 / T10.1 / T10.2 / T10.3 / T10.4 / T10.5 / T10.6 / T10.7a / T10.7b / T10.9 / T10.10 已验收通过**，**T10.11 已实现待统一验收**，见 `docs/验收记录/`，tag `v0.10.0` … `v0.10.11`）
> 编写：主控（只写计划、派活、验收）；执行与检查均由子 agent（Grok 4.7 High Fast）完成
> 依据：本仓调研（FF-pane v0.9.2，最新任务 T9.11）、cc-pane 参考调研、终端/CLI 可行性调研

---

## 0. 一句话目标

把 FF-pane 从「后台悄悄跑一轮 AI」的工作台，改造成「**一个界面平铺多个真实命令行窗口**、跨多个项目并行、窗口之间能**派活和交流**」的多窗口终端工作台。

## 1. 已确认的决定

| 事项 | 决定 |
|---|---|
| 与旧流程关系 | 最终替换；**分阶段**：先建新工作台，Tony 确认好用后再下线旧流程（T10.11 单独关口） |
| 窗口形态 | 软件内嵌终端（PTY + xterm.js），不弹系统窗口 |
| 布局 | 先做分屏 + 标签页；自由画布放到以后 |
| 首批 CLI | Claude Code、Codex（另含普通 PowerShell 作为基础能力）；Grok 本阶段暂缓 |
| 管理者开窗口 | 不逐次确认，直接开；界面标明「由谁开启」 |
| 窗口间通信 | MCP 投递 + 每条消息自动落盘为 `.md` 记录 + 软件向对方窗口发一行提醒（忙时排队） |
| 保留功能 | 项目管理、记忆、知识库 |
| 计划页/任务看板/运行记录 | 默认隐藏；在对话窗口里说一声即可打开查看 |
| 权限 | 两种模式：沙盒（受限）/ yolo（全放开）。**权限只能自上而下下放**：Tony → 管理者 → 干活窗口；下级权限不超过上级；下级不能反过来影响上级 |
| 执行方式 | 子 agent 串行、直接在当前工作区改 |
| 提交 | 每完成一个任务提交一次，并把版本号末位 +1，打同名 tag |

## 2. 与旧设计的冲突（需在 T10.0 中改写文档红线）

旧文档明确「不做 PTY / 内嵌终端分屏 / Agent 互聊 / HTTP MCP」（`docs/技术选型.md` L201–L204、`README.md` L50–L52）。Phase 10 推翻前三条，文档须同步改写，避免后续子 agent 依据旧红线拒绝实现。MCP 仍坚持 **stdio**，不引入 HTTP。

## 3. 核心概念（新）

```
工作空间
 └─ 项目（多个，可同时打开）
     └─ 窗口（多个，每个 = 一个真实终端 + 一个 CLI）
          ├─ 角色：管理者 / 规划 / 执行 / 检查 / 普通
          ├─ 启动配置：CLI + Provider + 模型 + 权限
          ├─ 身份令牌：窗口专属，MCP 靠它识别“是谁在说话”
          └─ 上级窗口：由谁开启（权限只能向下传）
```

### 3.1 预定义角色（不用 Tony 手动设计）

工作台角色与旧会话 `Role` / `CustomRole` 分开。窗口角色只有五种：`manager`（管理者）、`planner`（规划）、`worker`（执行）、`reviewer`（检查）、`none`（普通，默认）。类型在 `packages/shared`；布局 schema v4 带 `role`（仍可读 v1–v3，缺省或非法值按普通处理）；主进程 `WorkbenchAuthRegistry` 在登记之后以注册表为准。

说明书是随应用打包的 Markdown（`apps/desktop/resources/workbench-roles/{base,manager,planner,worker,reviewer}.md`）。开发态从应用目录 `resources/workbench-roles` 读，打包后从 `extraResources` 的 `workbench-roles` 读。设置页可查看、编辑覆盖副本（应用数据目录 `workbench-role-overrides/`，原子写，空内容拒绝）或恢复默认。覆盖副本优先。

系统提示 = `base` + 该角色说明书。`none` 只有 `base`。新开与续接都注入：

- Claude：合并正文写入按窗口的临时文件，参数 `--append-system-prompt-file`（追加，不替换 Claude 自己的系统提示）。
- Codex 0.159.2：`-c developer_instructions=<JSON 字符串>`。已用隔离 `CODEX_HOME` 的 `codex debug prompt-input` 验证：该键出现在第一条 developer 消息的开头，skills / permissions / collaboration 仍在，属于追加而不是整段替换。未知 `-c` 键会被静默忽略，故未采用未出现在二进制里的 `experimental_instructions_file`。`model_instructions_file` 对 `prompt-input` 无效果，且名称像替换，不使用。不写项目 `AGENTS.md`，不改用户 `~/.codex`。

运行中改角色不重启。主进程 `setWindowRole(actor, windowId, role)` 用纯函数 `canSetRole` 裁决后改注册表和布局，并向存活 PTY 投递一行：`[FF-pane] 你的角色已设为…，请先阅读 <说明书绝对路径> 并按其行事`。投递走空闲队列，**永不强制写入**。窗口向 PTY 提交回车（用户按 Enter，或队列自己写出的回车）后记为忙；Claude 的 Stop，或 Codex notify 的 `agent-turn-complete`，才记为空闲。自动投递必须同时是空闲、用户在该窗口 1500ms 内没有输入、输出静默达到 1500ms。启动后还没收到回合结束时不自动投递，窗口里显示「有 N 条待投递——立即发送 / 取消」。PermissionRequest 等待中绝不投递。正文不含换行，回车单独发送；发出回车后下一条要等下一次回合结束。下次启动/续接改用系统提示。Claude 用 `--settings` 合并观察型 hooks（不写 `~/.claude`，不覆盖用户 hooks，没有额外信任开关，也不改用户项目 hooks 的信任状态）。hooks 用 exec 形态：`command` 是 node.exe 绝对路径，`args` 是脚本路径和固定事件名；官方文档写明带 `args` 时忽略 shell，事件 JSON 只从 stdin 进入。Codex 不用 hooks，也不使用 `--dangerously-bypass-hook-trust`；改为 `-c notify=[node.exe 绝对路径, hook 脚本绝对路径]`，由 Codex 把事件 JSON 追加为最后一个参数，不经 cmd / PowerShell / 任何 shell。脚本放在 extraResources，普通 node 能读。没有 node.exe 时不装 notify，该窗口投递一直手动确认，并在界面说明。这条 `-c` 会盖过用户 `config.toml` 里的 notify：工作台 Codex 窗口会暂时替换用户自定义 notify，不转发、不写 `~/.codex`。hook 经本地命名管道 / Unix socket 上报，请求带窗口令牌。

`canSetRole`：界面用户可设任意窗口的任意角色；窗口把自己设为 `manager` 仅限 `openedBy=user` 的顶层窗口；窗口可设定自己后代的角色；其余拒绝。MCP `ffpane_set_role` 在 T10.7 接入，本单只提供上述主进程 API。

界面：新建 AI 窗口可选角色（默认普通）；标题栏角色徽章（点击或右键菜单）；管理者标题栏用主色底；命令面板「将当前窗口设为管理者」。对 AI 说「你来当管理」时，说明书要求它调用 `ffpane_set_role`（工具本身 T10.7 才实现）。

- **管理者**：接 Tony 的目标 → 澄清 → 拆分 → `ffpane_write_brief` → `ffpane_open_window` 开规划/执行/检查 → 收回报，必要时 `ffpane_read_output` → 派检查 → 汇总。不亲自改代码。
- **规划**：只读代码，用 `ffpane_write_brief` 写计划，`ffpane_report` 回报路径。
- **执行**：按 brief 改代码、自测，`ffpane_report` 汇报 done/blocked/failed。
- **检查**：不改代码，跑检查、审阅 diff，给出通过/不通过，`ffpane_report` 汇报。

### 3.2 窗口间通信（混合方案）

1. **发送靠 MCP**：`send_message` / `report_to_manager` 等工具，由主进程负责投递。
2. **全部落盘**（T10.7a）：不给 `.ffpane` 加 gitignore，记录可提交。已读游标在应用数据目录，不进项目。
   - 机读：`<项目根>/.ffpane/threads/index.jsonl`，一行一条 `{v:1,id,ts,projectId,from:{windowId,title,role},to:{windowId,title,role},kind:"message"|"report",status?,text,files?,briefPath?,threadFile}`。追加写；最后一行半写时读取跳过。
   - 人读：`<项目根>/.ffpane/threads/<YYYY-MM-DD>-<团队名>.md`。团队 = 双方所在的最上层管理者窗口（名称规范化 + 短 id）。追加形如 `### 21:03:15 · 管理者「总管」→ 执行「前端A」· 消息`，正文整段写成引用块（每行前加 `> `，保留换行，去掉其它控制字符，`\r\n` 归一），从而无法伪造 `###` 标题。`index.jsonl` 的 `text` 保留原始正文。路径与标题去掉或拒绝 C0/DEL。再可有附件行。
3. **长内容外置**：计划/任务说明写成 `.ffpane/briefs/*.md`，消息里只放路径。
4. **提醒**：主进程向目标窗口终端写一行「[新消息] 来自 X，请调用 read_inbox」；窗口忙（输出未静默）时排队，空闲再投。提醒丢了也不怕——消息在收件箱和 `.md` 里。
5. **兜底**：不支持 MCP 的 CLI 可直接读写 `.ffpane/inbox/<窗口>/` 下的 `.md`。

### 3.2.1 工作台 MCP 工具清单（T10.6 角色说明书与 T10.7 实现共同遵守）

服务名 `ffpane-workbench`（stdio sidecar，按窗口令牌识别调用方，主进程用 T10.5 的 `authorize` 裁决）：

| 工具 | 作用 | 裁决要点 |
|---|---|---|
| `ffpane_whoami` | 返回本窗口 id、名称、角色、权限、上级、项目 | 任何窗口 |
| `ffpane_list_windows` | 列出本窗口可见的窗口（自己的后代 + 上级链） | 只返回可见范围 |
| `ffpane_set_role` | 设定窗口角色（含把自己设为管理者） | 与 `canSetRole` 相同：用户任意；自设 manager 仅用户开启的顶层窗口；窗口可设定后代；其余拒绝 |
| `ffpane_open_window` | 开子窗口：CLI、启动配置、角色、权限、标题、任务说明文件路径 | 仅管理者；权限 ≤ 自己；受窗口上限 |
| `ffpane_write_brief` | 在 `.ffpane/briefs/` 写任务说明 `.md`，返回路径 | 路径限定在 briefs 目录内 |
| `ffpane_send_message` | 给后代发消息/指令（正文或 brief 路径） | 仅后代 |
| `ffpane_report` | 向上级汇报（状态 done/blocked/failed/progress + 摘要 + 可选文件路径） | 仅上级链 |
| `ffpane_read_inbox` | 读取本窗口收件箱（未读/全部） | 仅自己 |
| `ffpane_read_output` | 读取后代窗口环形缓冲尾部。默认最后 8KB，`maxBytes` 可调，硬顶 32KB。先按字节取尾再去掉 ANSI / 控制序列。窗口未运行时返回状态说明 | 仅后代 |
| `ffpane_close_window` | 关闭后代窗口：杀 PTY、吊销令牌、清投递队列、从布局移除。直接子窗口标记 `parentClosed`，权限仍按原上限封顶。关闭者的团队记录追加一条系统行。不能关自己 | 仅后代 |
| `ffpane_open_panel` | 参数 `plan` / `tasks` / `runs`。向渲染端发事件，打开工作台隐藏抽屉的对应页签，并 toast「由 &lt;窗口标题&gt; 打开」。不在工作台时先切到该窗口的项目。同一窗口至少间隔 3 秒，过频拒绝且不发事件 | 任何窗口 |
| `ffpane_memory_search` | 查调用者所属项目的记忆（active 与 candidate，不含 archived）。参数 `query` | 任何窗口。忽略参数里的项目路径。最多 20 条；标题加正文合计不超过 16KB，超出截断并标明。空白或超过 200 字的查询拒绝 |
| `ffpane_memory_add` | 新增一条项目记忆候选（`decision` / `rule` / `lesson`）。自动记录来源窗口标题、id、角色，时间用条目的 createdAt。记忆页显示来源标签，用户可删除。写入走现有 `saveEntry` 与索引钩子；旧注入仍只含用户通过后的 active | 已授权管理者，或 `openedBy=user`，且该窗口未被冷启动清洗锁住。控制字符去掉（正文保留换行）。标题最多 120 字，正文最多 2000 字。同一窗口至少间隔 10 秒 |

角色默认建议权限：管理者 `edit`（实际由 Tony 设定）、规划 `read-only`、执行 `edit-exec`、检查 `edit-exec`（说明书约束不改代码，只跑检查）。

### 3.3 权限模型

| 等级 | 含义 | Claude Code（2.1.220） | Codex（0.159.2） |
|---|---|---|---|
| `read-only` | 看代码，不改不跑 | `--permission-mode plan` + `--disallowedTools Edit Write NotebookEdit MultiEdit Bash` | `-s read-only`（续接：`-c sandbox_mode="read-only"`） |
| `edit` | 能改项目内文件 | `--permission-mode acceptEdits` + `--disallowedTools Bash` | `-s workspace-write -a on-request`（续接：`-c sandbox_mode=…` + `-c approval_policy="on-request"`） |
| `edit-exec` | 可改文件 + 跑命令 | `--permission-mode acceptEdits`（不禁 Bash；交互下 Bash 仍由 CLI 询问） | `-s workspace-write -a never`（续接：`approval_policy="never"`） |
| `yolo` | 完全放开 | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

- 沙盒模式 = 前三级；yolo = 第四级。
- **诚实说明**：Windows 上这是「CLI 自带的工具/审批规则 + 本软件的 MCP 裁决」，**不是**操作系统级隔离。「只写不读」无法实现，不提供。
- **Codex 局限**：`workspace-write` **无法单独禁止命令执行**；`edit` 与 `edit-exec` 的差异主要靠审批策略。0.159.2 已移除 `-a untrusted`（仅 `on-request` / `never`）。续接时沙箱/审批**不自动继承**，须每次重给。
- **规则**：子窗口等级 ≤ 开启它的窗口；只有界面用户能任意设定顶层窗口等级；MCP 不给下级修改上级的工具；每次调用凭窗口身份令牌在主进程裁决（`authorize` / `canDelegate`）。
- **窗口身份令牌**：每次启动/续接由主进程签发 ≥32 字节高熵令牌，仅存内存注册表，不落盘、不进布局、不进 renderer、**不进 argv**。经 `FF_PANE_WINDOW_TOKEN` 注入 CLI 进程环境；Claude 临时 `--mcp-config` 的 `env` **只写** `${FF_PANE_WINDOW_TOKEN}` 占位符（官方环境变量展开，真实值不落盘）；Codex 用 `mcp_servers.<name>.env_vars` 白名单从父进程转发（值不进 `-c`）。
- **启动封顶**：主进程权威权限表；`workbench:launch-cli` 对有父级的窗口取 `min(请求, 祖先链上限)`；renderer 不得传 `parentWindowId`（父子关系仅主进程在 T10.7 建立）；热同步继续忽略 renderer 伪造的父级。
- **冷启动**：本项目第一次读布局走 `restoreColdLayout`：按磁盘上的父子关系重建主进程注册表，断环后再按祖先链封顶。`openedBy` 不是 user、且父级缺失或不在树上时，与断环一样降为 read-only 并锁住；清洗结果写回磁盘。同一会话再次 `syncLayout` 不得用磁盘上更高的权限或 `openedBy=user` 盖掉。不得把冷读到的权限当成顶层用户授权。
- **管理权**：磁盘上的 `manager` 只用于显示，不授予开窗口。用户在界面续接或重新开始一个顶层（`openedBy=user`、无父级）且角色为 manager 的窗口时，视为重新授权（`setWindowRole` 用户身份，不因角色未变再投递切换行）。有父级的 manager 仅当其父级当前已是被授予的 manager 才继承授权，否则标题栏显示「管理权待恢复」。`managerGrantPending` 只驱动显示。父级被断环去掉、`openedBy` 仍不是 user 的，续接不当成用户重新授权。被清洗锁住的窗口也不能靠续接重新授权，除非界面显式改过该窗口角色。权限为 yolo 或角色为 manager 时，续接 / 重新开始先弹一次确认，取消则不启动。
- **徽章**：重启后从 `.ffpane/threads/index.jsonl` 尾部（最多 256KB 且最多 400 行）加已读游标重算未读数与最近汇报状态，随布局 hydrate 一次取回。系统记录不计入未读。
- **权限请求配对**：真实 Claude `PermissionRequest` 没有 `tool_use_id`。hook 从 stdin 计算 `tool_name` + 规范化 `tool_input` 的 SHA-256，只上报工具名与摘要。有 `tool_use_id` 时优先按 id 配对；否则按摘要多重集配对。批准时若用户改了输入，摘要不同，继续闩住直到 `UserPromptSubmit`。权限被拒绝且没有结束事件时继续闩住。伪造 Stop 在未决计数大于 0 时不解锁。
- **父窗口关闭**：保留子窗口，标记 `parentClosed`；仍受开启时封顶约束。祖先降级后，超限后代标记 `permissionNeedsDowngrade`，下次启动/续接自动封顶（热改 CLI 参数不可能，界面提示重启）。
- **关掉窗口**：点窗口 X 时在 `BrowserWindow` `close` 上先 flush 布局（最多 800ms）再关闭。`before-quit` 仍会再 flush 一次。

### 3.4 Provider 填表化

- 一条 Provider = 名称 + 适用 CLI + 接口地址 + 密钥 + 模型列表（+ 可选代理）。
- 提供**预设模板**（Anthropic 官方、Anthropic 兼容中转、OpenAI 兼容、xAI、本机已登录），选模板 → 填地址和密钥 → 保存即可用。
- 「Provider → 环境变量/启动参数」改为**数据表驱动**（每个 CLI 一张映射表），消除散落各处的 `switch`；新增中转站不写代码。只有接入全新 CLI 才需要写代码。
- 密钥继续用现有 `safeStorage` 加密存储，只在启动时经环境变量注入，不写进任何配置文件或命令行。
- 旧 `providers.json` 自动迁移。

---

## 4. 任务拆分（串行执行）

每个任务：执行子 agent 实现 → 检查子 agent 独立验收 → 主控复核 → 提交 + 版本号末位 +1 + tag → 写 `docs/验收记录/T10.x-验收.md`。

| 编号 | 任务 | 交付给 Tony 能看到的效果 |
|---|---|---|
| T10.0 | 准备：清理换行符假改动；为当前 HEAD 补打 `v0.9.2`；改写旧设计红线；把本计划并入 `开发计划.md` | ✅ 已验收（`docs/验收记录/T10.0-验收.md`，tag `v0.10.0`） |
| T10.1 | 终端底座：主进程 PTY 管理器 + xterm 组件 + 打包配置 | ✅ 已验收（`docs/验收记录/T10.1-验收.md`，tag `v0.10.1`） |
| T10.2 | 工作台布局：新页面，分屏 + 标签页，多项目同时打开，切项目不关窗口，布局自动保存恢复 | ✅ 已验收（`docs/验收记录/T10.2-验收.md`，tag `v0.10.2`） |
| T10.3 | Provider 填表化 + 模板 + 迁移 | ✅ 已验收（`docs/验收记录/T10.3-验收.md`，tag `v0.10.3`） |
| T10.4 | 在窗口中启动 Claude / Codex / Grok：注入 Provider、角色说明、知识库 MCP；支持续接 | ✅ 已验收（`docs/验收记录/T10.4-验收.md`，tag `v0.10.4`；角色说明书注入延至 T10.6，见开发进度调研结论） |
| T10.5 | 窗口身份令牌 + 权限等级 + 自上而下下放规则 | ✅ 已验收（`docs/验收记录/T10.5-验收.md`，tag `v0.10.5`；移交 T10.7 三条见 `docs/开发进度.md`） |
| T10.6 | 内置角色说明书 + 「设为管理者」 | ✅ 已验收（`docs/验收记录/T10.6-验收.md`，tag `v0.10.6`；移交 T10.7 四条见 `docs/开发进度.md`） |
| T10.7a | 工作台 MCP 主链路：sidecar + 控制通道工具调用；`whoami`/`list_windows`/`set_role`/`write_brief`/`open_window`（先登记父级再启动、封顶）/`send_message`/`report`/`read_inbox`；消息落盘 `.ffpane/threads`；新消息空闲提醒 | ✅ 已验收（`docs/验收记录/T10.7a-验收.md`，tag `v0.10.7`；移交 T10.7b 三条见 `docs/开发进度.md`） |
| T10.7b | 工作台 MCP 补全：`read_output`/`close_window`/`open_panel`；冷启动先恢复父子再封顶；管理权恢复与「管理权待恢复」；未读/汇报徽章从线程索引尾部重算；权限请求按工具名 + 输入摘要配对；横幅与取消说明；窗口 X 先 flush 布局 | ✅ 已验收（`docs/验收记录/T10.7b-验收.md`，tag `v0.10.8`；移交 T10.9 两条见 `docs/开发进度.md`） |
| T10.8 | ~~Grok 的 MCP 接入~~ **挂起**（Tony 决定本阶段不做 Grok） | — |
| T10.9 | 计划 / 任务看板 / 运行记录 改为隐藏面板，数据改接工作台，可由 MCP `open_panel` 呼出。面板为工作台内侧滑抽屉三个页签：**计划** = 本项目 `.ffpane/briefs/*.md` 列表与 Markdown 预览；**任务** = 团队看板（按子窗口最近汇报状态 progress/blocked/done/failed 分列，卡片含标题、角色、权限、上级、最近汇报摘要、brief 链接，点卡片聚焦该窗口）；**记录** = `.ffpane/threads/index.jsonl` 消息流（按团队/窗口/类型筛选，可打开对应 md）。旧 plan/tasks/runs 页面从侧边导航移除但路由保留到 T10.11。另含 T10.7b 移交两项修复 | ✅ 已验收（`docs/验收记录/T10.9-验收.md`，tag `v0.10.9`；下一步 T10.10） |
| T10.10 | 记忆 MCP（检索/新增），让窗口能主动用记忆 | ✅ 已验收（`docs/验收记录/T10.10-验收.md`，tag `v0.10.10`；首验有条件通过，必须项已修，下一步 T10.11） |
| T10.11 | **（Tony 已同意纳入本次）** 下线旧后台会话流程。删除会话 / 计划 / 任务 / 记录页面与路由、命令面板里的旧版入口、只服务旧流程的编排（orchestrator、settlement、planner-report、task-settled、repair、headless registry）。启动进工作台。侧栏只留项目、工作台、记忆、知识库，设置仍在底部。项目卡片和 B 栏不再读旧计划 / 任务 / 会话。旧磁盘数据不删不迁。保留工作台及其依赖（npm shim、环境清洗、Job Object、Profile、provider 注入、`session/env`、知识库 MCP）、项目管理、记忆、知识库、设置、密钥、Provider。配置 MCP 的实现和设置开关保留，但不再挂到已删除的旧会话上。领域与 storage 里的 Plan / Task / Run / Session 类型保留，应用不再调用。适配器包保留 | ✅ 已实现，待 Phase 10 统一验收（tag `v0.10.11`） |

### 4.1 每个任务的通用检查要求（由主控派给检查子 agent）

1. `pnpm --filter @ff-pane/desktop run typecheck` 通过
2. `pnpm lint` 通过（含 i18n 检查）
3. `pnpm test` 全绿，且新增逻辑有对应单测
4. 涉及界面的任务：新增/更新 Playwright E2E 并通过 `pnpm test:e2e`
5. 涉及打包/原生模块（T10.1 起）：`pnpm smoke` 通过；必要时安装版冒烟
6. 反向探针：检查子 agent 须主动尝试“越权/异常”路径（例如 worker 调用修改管理者权限、令牌伪造、忙时投递）
7. 验收记录按 `docs/验收记录/T9.11-验收.md` 格式落档
8. 给 Tony 的「手动试一下」清单（3～5 步，大白话）

---

## 5. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 往正在运行的 AI 命令行里写字不可靠 | 提醒只作“敲门”，正文走 MCP 收件箱 + `.md`；提交回车即忙，Codex 用 notify 的 `agent-turn-complete` 回空闲后再投递 |
| Windows 沙箱不可靠 | 权限以 CLI 规则 + MCP 裁决为准；界面如实标注 |
| Grok 无法按窗口注入 MCP | 见第 6 节待定项；Grok 可先走 `.md` 收件箱兜底 |
| 原生模块 node-pty 打包 | 沿用 better-sqlite3 的 N-API 预编译 + asarUnpack + `npmRebuild:false`；加冒烟 |
| 多窗口性能 | 限制同时窗口数（默认 12，可调）；隐藏标签页暂停渲染 |

## 6. Tony 已确认（2026-09-30）

1. **Grok 暂缓**：Phase 10 只做 Claude Code 与 Codex；T10.8 挂起，Grok 相关项（权限映射、MCP 接入）不在本阶段交付。
2. **版本号**：T10.0 起跳 `0.10.0`，之后每个任务末位 +1（T10.1 → `0.10.1`，依此类推），每次打同名 tag。
3. **计划整体同意**，从 T10.0 开始执行。

---

## 7. 主控交接说明（2026-10-01，换新对话继续时先读本节）

### 7.1 分工规则（Tony 明确要求）

- **主控**：只对计划负责。可以读计划/文档、搜索文档、改计划；**不写代码、不读代码、不看 diff**；根据子 agent 汇报做决定并派活。所有写代码、修复（再小也算）、审查、跑检查、提交，全部交给子 agent。
- **模型**：主控继续用 Opus 5.5（Tony 指定，不换）；子 agent 一律 `grok-4.7-high-fast`（Cursor Models 额度池）。
- **以文件交互，不以上下文交互（Tony 2026-10-01 要求）**：
  - 所有子 agent 的完整汇报（派活要点、改动文件、命令结果、问题、裁定）**追加**写入总记录文件 `docs/对话记录/Phase10-对话总记录.md`（只追加、不改旧条目，按时间顺序）。每条格式：`## <YYYY-MM-DD HH:mm> · T10.x · <执行|检查|修复|复验|提交> · <简称>`，下面依次写：任务要点 / 结论 / 改动文件 / 命令结果 / 问题与遗留 / 相关文件链接（如验收记录）。
  - 子 agent 回复主控的消息**不超过 3 行**：结论（如“有条件通过，2 项必须修”）+ 总记录中该条的标题 + 是否需要主控决策。
  - 主控需要细节时，只读总记录里对应那一条（用搜索定位标题），不通读全文。
  - 主控派活的说明保持简短，引用本计划章节与总记录条目，不重复粘贴长内容。
- **与 Tony 沟通**：简体中文、大白话、少术语；有疑问随时用选择题问；每完成一步简单汇报。

### 7.2 每个任务的流程

1. **执行子 agent**（新开）：按任务说明实现，不提交；自测只跑 lint、desktop typecheck、相关单测、受影响的 e2e。
2. **检查子 agent**（新开，独立）：审查并做反向探针；**首验完整跑** lint / typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`；写 `docs/验收记录/T10.x-验收.md`（含给 Tony 的手动试用清单）；裁定为“通过 / 有条件通过 / 不通过”。
3. **修复**：交回原执行者修（中间轮只跑相关测试）；同一子 agent 修超过两轮就换新的接手，只给它验收记录和问题清单。修完由原检查员复验，最后一轮完整跑。
4. **提交**（交给执行者）：版本末位 +1（根与 `apps/desktop` 的 `package.json`、README 状态行、测试里假 AppInfo 的版本）；`docs/开发进度.md` 标 ✅ 并登记移交事项；本计划状态同步；提交信息仿照 `feat: T10.x …`；打**轻量** tag `v0.10.x`；**不 push**。
5. 子 agent 汇报要精简（结论、问题、命令结果）。

### 7.3 子 agent 通用纪律（每次派活都要写进说明）

- 永远不提交、不修改未跟踪文件 `apps/desktop/scripts/real-config-probe.mjs`。文件一律 LF。
- 不读写用户真实数据目录 `~/.aiworkbench`，不修改 `~/.claude`、`~/.codex`；不运行消耗 AI 额度的命令（`--help`、`debug prompt-input` 等不调用模型的可以）。测试必须隔离（e2e `_launch.ts` 已设 `FF_PANE_E2E`、`CODEX_HOME` 等）。
- 旧后台会话流程已在 T10.11 下线。磁盘上的旧文件保留，界面不再读取。
- 不写“改了什么”式注释。

### 7.4 已沉淀的安全原则（后续任务必须遵守）

- 启动任何子进程都用参数数组，**不经过 cmd/.cmd/.bat/PowerShell 或任何 shell**（npm shim 要解析到真实 exe 或 node + 脚本）。
- 密钥只经环境变量；窗口令牌不落盘、不进 argv/日志/IPC（Claude 的 MCP 配置里用 `${VAR}` 占位符；Codex 用 `env_vars` 转发）。
- 控制通道只走本地命名管道，禁止 HTTP/TCP；每条请求凭令牌认窗口。
- 绝不把 AI 生成的消息正文写进其他窗口的 PTY，只写固定模板的提醒；标题等字段必须消毒。
- 只在确认“回合结束”且没有未决权限请求时才自动投递回车；没有可靠信号时只允许用户手动发送；永不超时强写。
- 不使用 `--dangerously-bypass-hook-trust`。
- 权限只能自上而下：子窗口 ≤ 祖先链；冷读布局里的权限/管理者身份不算授权，被清洗的窗口锁住；续接 yolo/管理者窗口要用户确认。

### 7.5 当前进度（交接时）

- 已完成并提交：T10.0 ~ T10.7b、T10.9、T10.10、T10.11，当前版本 **0.10.11**（tag `v0.10.11`）。T10.8 挂起。
- **T10.10**：✅ 已验收（`docs/验收记录/T10.10-验收.md`，tag `v0.10.10`）。首验有条件通过。必须项已修：写入前占住 10 秒间隔（写失败也占）；回读后丢掉 archived。自查 test 2643 / 1 skip、smoke 11、e2e 67。本轮按收尾指令提交，单独复验并入 Phase 10 统一验收。
- **T10.11**：已实现并提交（tag `v0.10.11`），未经本任务单独验收，并入 Phase 10 统一验收。旧会话 / 计划 / 任务 / 记录页面与只服务它们的编排已删。启动进工作台。侧栏剩项目、工作台、记忆、知识库，设置仍在底部。旧磁盘数据不删不迁。配置 MCP 开关还在，但不再挂到旧会话。领域类型与 data.ts 里的旧查询通道保留，界面不调用。
- **下一步**：Phase 10 统一验收。T10.8（Grok）仍挂起。
- 已登记的残余风险（不阻断）：权限摘要多重集可能被“减穿”；Codex 首轮前手动发送的残余；工作台 Codex 窗口会暂时替换用户自定义 notify；Codex 会话认领在同目录极短时间双开时可能超时。详见 `docs/开发进度.md`。
