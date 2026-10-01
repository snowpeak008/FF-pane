# Phase 10 统一验收（v0.10.9 .. v0.10.11）

**执行时间：** 2026-10-01
**执行人：** 验收子 Agent（独立验收，非实现者）
**被验对象：** `v0.10.9`（`a036284`）之后到 `v0.10.11`（`d2755a5`，HEAD）的三笔提交。T10.10 记忆 MCP 与必须项修复：`9626fcb`，tag `v0.10.10`。T10.11 下线旧后台会话：`bb391fa`。收尾记录：`d2755a5`，轻量 tag `v0.10.11`。
**依据：** `docs/Phase10-多窗口终端工作台计划.md` §7，以及总记录里 T10.10、T10.11 与「Phase 10 · 开发完成」条目。T10.10 首验必须项见 `docs/验收记录/T10.10-验收.md`。
**环境：** Windows 10 · PowerShell · **除本验收记录与总记录追加条目外未改其它文件**、未 commit / stash / checkout / reset · 打包目录在系统临时目录，冒烟后已删除 · **未读取 / 未修改 `~/.aiworkbench`**（打包冒烟把 `FF_PANE_DATA_ROOT` 指到临时目录）· **未修改 `~/.claude` / `~/.codex`** · 未跑消耗 AI 额度的命令 · 未改 `apps/desktop/scripts/real-config-probe.mjs`

---

## 裁定：**有条件通过**

T10.10 首验的两项必须修复已经落地，单测打在真实工具路径上。T10.11 没有误删工作台、记忆、知识库、Provider、Profile、密钥、设置仍要的代码。启动进工作台，侧栏只剩约定的四页加底部设置。旧计划 / 任务 / 会话文件没有删除或迁移逻辑。安全原则没有被这三笔提交改坏。lint、desktop typecheck、单测、smoke、e2e、打包后冒烟都过了。

提交给 Tony 试用之前，要先改一处仍在界面上的假话：设置页「工作台自配置工具」打开后，仍说会注册给 Agent、写入走确认对话框、调用记入执行记录。这三件事现在都不会发生。

| 类别 | 内容 |
|---|---|
| **必须修复** | 1 项。见下节。 |
| **建议（非阻断）** | 见文末建议。待 Tony 确认的产品决定单独成节，不挡这 1 项。 |

---

## 必须修复

**设置页自配置开关的说明与事实不符。**

`configToolEnabled` 只在设置页读写，以及 `packages/storage` 的项目设置里。`git grep` 在 `apps/desktop/src` 与 `packages` 里没有第二处读取。工作台启动（`launch-cli.ts`）不看这个开关。确认对话框 `ConfigDraftDialog.tsx` 已随会话页删除。执行记录页已删除。

界面仍在说反话（中英各一份）：

- `settings.configTool.hint`：关掉时「不会注册给 Agent」。反过来说，打开就会注册。实际打开也不会注册。
- `settings.configTool.enabledNote`：已启用后「每次写入都要经过草案校验与你的确认对话框，全部调用会记入执行记录」。确认对话框和执行记录页都不在了。
- `settings.configTool.subtitle` 同样把「提交草案、经你确认才保存」写成当前能力。

开关本身可以留着，那是下面留给 Tony 的决定。必须先把这三句改成现在的实话：开关会保存，当前不会进入任何窗口，也没有确认对话框。英文同步。

---

## 1. T10.10 两项必须修复是否真的解决

**已解决。**

同一窗口的 10 秒间隔改到写文件之前占住。`reserveMemoryAdd` 在 `addMemory` 里、在 `await deps.addProjectMemory` 之前执行，中间没有其它 `await`。检查通过就记下时间；空标题、空正文、超长在占位之前就返回，不占间隔。写失败也占着。JavaScript 单线程：两笔同时进来时，先跑到占位的那笔记下时间，后一笔会看到并拒绝。控制通道即使先 `await describe` 再进 `addMemory`，也挡得住，因为占位发生在下一次让出事件循环之前。

检索在 `loadEntry` 之后丢掉不是 `active` 也不是 `candidate` 的条目。索引还停在 candidate、文件已改成 archived 时，不会返回。

单测 `apps/desktop/tests/workbench-memory.test.ts` 走 `executeWorkbenchTool`：并发只放行一笔、写入失败也占间隔、归档不返回。本轮该文件 **8 项通过**。整套 `pnpm test` 含在其中。

首验建议里没做的两条仍在，不挡：有编辑权的窗口可以直接改 `.workbench/memory` 把状态写成 active，旧的「只注入 active」会收；检索仍会先读完整文件，16KB 只限制返回给模型的字数。

---

## 2. T10.11

### 2.1 有没有误删仍依赖的代码

**没有。** 以当前 git 树为准（编辑器索引里还能搜到已删文件，磁盘上已经不在）。

已删且没有残留 import：`session/index.ts`、`orchestrator.ts`、`registry.ts`、`repair.ts`、`settlement.ts`、`task-settled.ts`、`interrupted.ts`、`event-map.ts`，以及会话 / 计划 / 任务 / 记录页面、`session-run.ts`、会话 store。`git grep` 在现存源码里找不到这些模块的 import。

工作台启动仍引用并且文件还在：

- `session/env.ts`：Provider 注入进环境变量
- `session/knowledge-tool.ts`：知识库 MCP
- `session/quit.ts`：退出时 flush 工作台布局。主进程把「有没有在飞旧轮次」接成恒为否，不再等旧编排器
- 适配器里的 `resolveDirectCliTarget`（npm shim 解析到真实 exe）、Job Object、Profile、密钥经环境变量

desktop typecheck 通过，说明留下的引用都能对上。

配置 MCP 的实现、`session/config-tool.ts`、`session/config-draft-hub.ts`、设置页开关都还在。E2E「config MCP sidecar」仍过。它们不再挂到窗口上，见必须修复的文案问题。

`data.ts` 里 `plans:list` / `tasks:list` / `runs:list` / `sessions:list` 还在。渲染层对这些通道的 `git grep` 为空，启动路径也不调用。这是计划里写明保留的查询通道，不是误删后的悬空调用。

### 2.2 测试覆盖有没有变少

**工作台、记忆、知识库、Provider 的测试文件没有减少。** 对照 `v0.10.9` 的清单，这四类同名文件都还在，并且多了 `apps/desktop/tests/workbench-memory.test.ts`。这四类里有改动的测试（`workbench-mcp.test.ts`、`workbench-mcp.spec.ts`、`workbench-cli.spec.ts`、`fake-workbench-cli.js`、`domain.test.ts`）是净增加。知识库与 Provider 的测试文件相对 `v0.10.9` 无 diff。

少掉的是已删除旧流程的测试（会话编排、计划、任务板、交接、回放等）以及只服务那些页面的 E2E。这是 T10.11 允许的。整套从 T10.10 自查的 2643 降到 **2384 过 / 1 跳过**（135 个文件），与「删掉旧流程测试」相符。

### 2.3 启动、侧栏、死链接、死命令、文案

**启动和侧栏符合约定。** `/` 重定向到 `/workbench`。`PAGE_SHORTCUT_ORDER` 是项目、工作台、记忆、知识库。设置仍是 Ctrl+,。E2E「应用启动并渲染默认工作台空态」和「Ctrl+1~4 逐个落在对应页面」通过。命令表面板里没有 `nav-session` / `nav-plan` / `nav-tasks` / `nav-runs`。`#/session` 落到找不到页面，不会再打开旧页面。

**无用语言包还在，不挡，见建议。** 已删页面的键没有被现存界面引用：`nav.session` / `nav.plan` / `nav.tasks` / `nav.runs` 各 2 个键全未使用；`session.*` 103 个键全未使用；`knowledge.sendToSession`（「发送到会话」）未使用。知识库页按钮只剩复制引用。`command-ipc.test.ts` 里的 `nav-session` 是搜索算法的假数据，不是命令表。

必须修复那一节的自配置文案是还在显示、并且说错了的句子，单独算必须项，不算「没用到的键」。

### 2.4 旧数据有没有被删或改写

**这三笔提交里没有删除或迁移用户旧计划、任务、会话文件的逻辑。** `project-summary.ts` 不再调用 `listPlans` / `listTasks` / `listRuns` / `listSessions`。项目卡片只显示名称、路径、数据目录缺失警告、登记时间。B 栏点项目进入工作台，不再画任务落定圆点。

Provider 的旧文件迁移在 `packages/storage` 里，本范围没有改那条路径。`connection-mode.ts` 里清掉 Provider 文件的 `unlink` 也不是这三笔提交引入的。

### 2.5 文档是否与实际一致

README、`docs/技术选型.md`、`docs/项目设计计划-v1.0.md` 的现行描述已经改成工作台：启动进工作台，侧栏四页加设置，旧文件保留、不迁移。技术选型补了一句：旧的 `child_process` + JSONL 编排不再装配，适配器包仍给定 CLI、进程树和登录探测用。设计计划第 2 章改成现行形态，并写明后面的历史章节是档案。

一处说法偏满，见建议：README 写「软件不再读取」旧文件。界面和启动确实不读。主进程查询通道还在，有外部调用时仍会读。

版本号三处一致：根 `package.json`、`apps/desktop/package.json`、README 状态行都是 **0.10.11**。打包冒烟应用信息也是 FF-pane v0.10.11。

---

## 3. 安全原则（计划 §7.4）

**这三笔提交没有破坏。** `launch-cli.ts`、`terminal/`、`control-channel.ts`、`idle-deliver.ts`、`hook-launch.ts`、`packages/adapters/src` 相对 `v0.10.9` 无 diff。

新的记忆工具不启动子进程，不把窗口令牌写入记忆文件、参数或日志（来源里记的是窗口 id 和标题），不把正文写进别的窗口的 PTY，没有 `--dangerously-bypass-hook-trust`。控制通道仍是原来的本地管道加令牌。

开发态和打包冒烟的 PTY 行显示本机 PowerShell，那是终端自己探测到的用户 shell，不是这三笔提交改出来的「用 shell 去启动 Agent」。

---

## 4. 命令结果

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过。Biome 737 个文件，无修正。`check-i18n` PASS |
| `pnpm --filter @ff-pane/desktop run typecheck` | 通过 |
| `vitest run apps/desktop/tests/workbench-memory.test.ts` | **8 过**（并发间隔、写失败占间隔、归档不返回都在里面） |
| `pnpm test` | 与别的扫描并行的那次：2381 过 / 3 失败 / 1 跳过（命令面板加载超时、PTY 集成超时、适配器「超时自动树杀」读不到 `up`）。单独重跑：2383 过 / 1 失败 / 1 跳过，失败是未改过的 `terminal-pty.integration.test.ts` 在清理临时目录时 EPERM。该文件单独再跑通过。再整套一次：**2384 过 / 1 跳过**（135 个文件，约 20 秒） |
| `pnpm smoke` | **11 项 ALL PASS**。应用信息 FF-pane v0.10.11。含 PTY、`workbench-hook.mjs`、角色说明书、`workbench-mcp.js`。pdfjs 缺 `@napi-rs/canvas` 的警告在 PASS 之前，不记失败 |
| `pnpm test:e2e` | **45 过**（约 5.1 分钟）。含默认工作台空态、Ctrl+1~4、侧栏不再有旧页面、隐藏面板、管理者写入记忆 |
| `electron-builder --dir` | 成功。输出在 `%TEMP%\ffpane-p10-accept-pack\win-unpacked`，没有写进仓库。打包后已删除 |

打包产物核对（冒烟前）：`FF-pane.exe`、`resources\workbench-hook.mjs`、`resources\workbench-roles\base.md` 与 `manager.md`、解包后的 `conpty.node` / `conpty.dll` / `OpenConsole.exe` 都在。`app.asar` 内有 `workbench-mcp.js`、`knowledge-mcp.js`、`config-mcp.js`。`workbench-hook.mjs` 按配置排除在 asar 外，放在 `resources`。

打包后 `FF-pane.exe --smoke`（`FF_PANE_DATA_ROOT` 指向临时目录）：**ALL PASS**，应用信息 **FF-pane v0.10.11**。hook 与 workbench-mcp 的路径落在该临时安装目录。pdfjs 同样警告缺 canvas。临时目录已删除。

---

## 5. 建议（非阻断）

1. 删掉已下线页面的语言包：`nav.session` / `nav.plan` / `nav.tasks` / `nav.runs`、整段 `session.*`、旧页面的 `plan.*` / `tasks.*` / `runs.*`、`knowledge.sendToSession`。工作台抽屉用的是 `workbench.drawer.*`，不要一起删。知识库页注释仍写「发送到当前会话」，可顺手改掉。
2. README 把「软件不再读取」改成「界面和启动不再读取；主进程查询通道还留着，界面不调用」。
3. 首验两条建议仍有效：直接改记忆文件可把状态写成 active；检索先读完整文件。
4. 单测在机器忙时仍会偶发：命令面板加载超时、适配器超时树杀读不到 `up`、PTY 集成测试清理目录 EPERM。安静重跑能过。这三笔提交没有改这些测试。

---

## 【待你确认的决定】

T10.10：

1. 写入失败也要再等 10 秒；标题或正文为空、还没开始写就失败的，不用等。建议同意。这样连着点两次不会写出两条；空内容不该惩罚你。
2. 有编辑权的窗口仍可以直接改项目里的记忆文件，把状态改成已生效，之后的注入会带上它。建议先这样。要挡死得把记忆挪出项目目录，或给每条做签名，那是另一件事。
3. 检索会先把命中的文件读完，16KB 只限制交回给模型的字数。建议先这样。这个工具新写的正文最多 2000 字；只有手改的超大文件才会多占内存。

T10.11：

1. 项目卡片不再显示计划版本、进行中任务数、最后活动。只留路径、登记时间，以及数据目录缺失警告。建议同意。那些数字来自已经下线的旧流程。
2. B 栏不再显示任务落定圆点。点项目进入工作台。建议同意。
3. 侧栏快捷键改为 Ctrl+1 到 Ctrl+4：项目、工作台、记忆、知识库。设置仍是 Ctrl+,。建议同意。以前的 Ctrl+3 是会话，现在是记忆。
4. 知识库去掉「发送到当前会话」，只留复制引用。建议同意。会话页已经没有了。
5. 配置 MCP 开关还在设置页，但不会进入任何窗口。建议先留着开关和实现，但必须把说明改成「当前不会生效」（见必须修复）。等你决定要不要接到工作台，再写回「打开后会注册给 Agent」。
6. 习惯建议桥随会话页删除。记忆页里的习惯管理还在。建议同意。
7. 直接打开旧地址（例如 `#/session`）会显示找不到页面，不会再读旧数据。建议同意。

---

## 【手动试用步骤】

1. 启动应用。应直接进入工作台。左侧只有项目、工作台、记忆、知识库，设置在最底下。
2. 还没有项目的话，先到项目页选一个目录建好，再回到工作台。
3. 新建一个窗口，设为管理者，启动 Claude 或 Codex。
4. 让这个管理者再用工作台工具开一个子窗口，并交代一件小事。
5. 等子窗口用汇报回一句。管理者这边应能看到新汇报。
6. 打开命令面板，选打开任务面板（也可以让管理者自己打开）。应滑出看板，上面有这个子窗口的状态。

## 复验（必须项）

2026-10-01 13:13。未提交改动里，与这项有关的只有 `locales/zh-CN.json`、`locales/en-US.json` 各 4 句（以及修复者已追加的对话总记录）。`settings.configTool` 的 subtitle、safetyNote、hint、enabledNote，中英文都已改成实话：开关会保存；当前不会进入任何工作台窗口、不会注册给 Agent；没有确认对话框，调用也不会记入执行记录。不再把「注册给 Agent / 确认对话框 / 记入执行记录 / 提交草案经确认才保存」说成当前能力。

反向探针：`ConfigToolSection` 实际用到的 8 个键（title、subtitle、safetyNote、label、hint、enabledNote、needProject、saveError）中英文都在，没有仍显示的旧句子。设置页仍挂着这个区块；开关仍调用 `projects:update-settings` 写入 `configToolEnabled`。实现未删。

### 命令结果

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过。Biome 737 个文件，无修正。`check-i18n` PASS |
| `pnpm --filter @ff-pane/desktop run typecheck` | 通过 |
| `pnpm test` | **2384 过 / 1 跳过**（135 个文件，约 20 秒）。首跑即过，未触发已知偶发 |
| `pnpm smoke` | **11 项 ALL PASS**。应用信息 FF-pane v0.10.11。pdfjs 缺 `@napi-rs/canvas` 的警告在 PASS 之前，不记失败 |
| `pnpm test:e2e` | **45 过**（约 4.8 分钟）。含「设置页开关可打开并保持选中」 |

### 最终裁定

**通过。** 必须修复项已落地，五条命令首跑全部通过。这一项不需要主控再决定。
