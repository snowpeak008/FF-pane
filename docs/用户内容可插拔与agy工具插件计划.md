# 用户内容可插拔与 agy 工具插件计划

> 状态：2026-11-28 方案已和 Tony 对齐，只写计划，没动代码，等 Tony 说开工。
> 背景：agy 的 agent 拿不到 MCP 工具，只有「插件自带的 MCP 服务器」才行（见 `Gemini窗口计划.md` §11.10）。装插件要写用户的 `~/.gemini/config/plugins`，所以先定规矩。

## 1. 原则（Tony 2026-11-28 定，已入记忆）

凡是 FF-pane 要写进**用户自己内容**（CLI 的全局配置、插件、设置）的，一律做成可插拔的附加项：

1. **默认不写。** 装软件、升级软件、开窗口，都不往用户目录里写。
2. **用户自己选择添加。** 用户配好 agy 之后，在设置里点「添加」才装。不添加就无效。
3. **可随时拔掉。** 设置里有「卸载」；卸载 FF-pane 本身时，安装程序按台账把装过的东西一并带走。
4. **跨版本都能清理。** 新版本能卸掉旧版本装的东西：按固定名字 + 归属标记识别，不按版本。
5. 只在本次会话生效、不留痕迹的做法（环境变量、agy 的 `--settings`）不算「改用户内容」，照常用。

## 2. 第一个落地：agy 的 ffpane 工具插件

### 2.1 为什么要插件（已实测，2026-11-28）

- 项目里 `.agents/mcp_config.json` 配的 MCP 服务器，agy 连得上（`/mcp` 里 ✓），但 agent 的工具集里没有，也拿不到 `call_mcp_tool`。
- **插件自带**的 MCP 服务器，agent 自己先读 `~/.gemini/antigravity-cli/mcp/<服务器>/<工具>.json` 描述，再用 `call_mcp_tool`（服务器名 `<插件名>_<服务器名>`）调用；真正的 ffpane 服务器能收到调用。
- 环境变量（窗口令牌）能从 agy 进程传到插件启动的服务器进程。
- 每次调用会弹「Allow calling this tool?」批准。

### 2.2 插件内容

- 目录：`~/.gemini/config/plugins/ffpane-workbench/`（名字固定）。
- `plugin.json`：名字、版本、说明，带归属标记（见 §3）。
- `mcp_config.json`：一个服务器 `ffpane-workbench`，命令是当前安装的 FF-pane 以 `ELECTRON_RUN_AS_NODE=1` 运行 `workbench-mcp.js`。令牌和管道名只走环境变量，不写进文件。
- 工具名：`ffpane-workbench_ffpane-workbench/ffpane_*`（插件名_服务器名）。批准规则和钩子都要按这个名字匹配。

### 2.3 状态与行为（Tony 定）

| 状态 | 行为 |
|---|---|
| **没装** | **不兜底**。agy 窗口照常能开，但没有 ffpane 工具；界面明说，不弹窗、不抢焦点（用角标和说明行）。**永远不会自动补装。** |
| **已装且是最新** | 什么都不做 |
| **已装但过期** | **自动更新**。过期 = 按当前安装的 FF-pane 生成的插件内容，和已装的不一致（安装位置变、服务器入口变）。 |
| **用户在 agy 里自己卸了** | 台账里清掉这一项，不补装 |
| **agy 没装** | 跳过，什么都不做 |

自动更新的做法：
- 触发时机：FF-pane 启动时、打开 Provider 里 agy 那一块时。只在「已装」时才检查更新。
- 用 `agy plugin install`（覆盖）+ `agy plugin validate` 校验；失败不留半成品，回滚到旧内容，状态标「更新待重试」，下次再试。
- 注意 Windows 上 agy 的 stdio 服务器进程会占着插件目录（agy 更新日志里写过），**有 agy 窗口开着时更新可能失败**：检测到就推迟，不强行。

### 2.4 设置界面

- 位置：设置 → Provider →「本机已登录」→ 选 agy，和账号状态放一起。
- 显示：未安装 / 已安装（版本）/ 过期、更新待重试；按钮「添加」「卸载」；一行说明「不添加就没有 ffpane 工具」。
- 新建 Gemini 窗口的账号面板、管理者开 agy 窗口时 `ffpane_open_window` 的返回，都带一句「未装插件，这个窗口没有 ffpane 工具」。

### 2.5 钩子自动批准

agy 的 PreToolUse 钩子对 `call_mcp_tool` 且服务器是 `ffpane-workbench_ffpane-workbench` 的，返回 `auto_approve`（实测 `allow` 不行）。只放行这一个服务器，不放行别的 MCP。

## 3. 台账与归属标记

- 台账：`~/.aiworkbench/user-mods.json`，每项记录：类型（`agy-plugin`）、位置、内容摘要、写入它的 FF-pane 版本、时间。
- 归属标记：插件目录里放一个文件（如 `.ffpane-owner`，内容是固定标识），卸载时必须同时满足「名字对」和「有标记」才删，避免误删用户自己装的同名插件。
- 台账丢了也能清理：直接按固定名字 + 标记找。

## 4. 卸载软件时一并带走

- 已有安装包钩子 `resources/installer.nsh`（现在管「卸载时可选一起卸 Claude 沙盒」）。在它上面加：卸载时，如果台账里有 agy 插件，且标记对，就调 `agy plugin uninstall ffpane-workbench`，找不到 agy 就直接删目录。
- 升级覆盖安装、静默安装不弹窗、不卸。
- 卸载程序在跑的时候 FF-pane 已经不在了，所以这一步不能依赖 FF-pane 的代码，只用台账（一个 JSON）和固定名字。

## 5. 其他改用户内容的地方（先盘点，不重构）

在做完 agy 插件之后，列一张清单：FF-pane 现在在哪些**用户目录**里写了什么（Claude、Codex、Cursor、Grok 的全局配置和钩子，项目里的 `.agents/`、`.cursor/` 等），按「是用户自己的内容 / 是项目里的协作文件 / 是 FF-pane 自己的数据」分类。哪些要改成可插拔，等 Tony 看清单再定。

## 6. 开发顺序（Tony 说开工后）

1. 台账模块（纯逻辑：读写、按名字+标记识别、清理）+ 单测。
2. 插件的生成、安装、校验、卸载、更新（调 `agy plugin ...`，不直接写目录，除了找不到 agy 时的清理）+ 单测。
3. 主进程：状态查询、添加、卸载、启动时自动更新（只在已装时）。
4. 设置界面：agy 那一块的状态和按钮；新建窗口和 `ffpane_open_window` 的提示。
5. 钩子：`call_mcp_tool` 自动批准。
6. 安装包卸载钩子。
7. 真窗口里端到端验证（见 §7），通过再发版。

## 7. 验证清单

1. 没装插件：agy 窗口能开，界面有提示，管理者开窗时返回里有提示；重启 FF-pane 后**仍然没装**。
2. 添加后：新开 agy 窗口，agent 能调 `ffpane_whoami`、写说明、汇报；三个权限档各一次；只读档能调。
3. 带令牌和管道的真实窗口里调用成功（探针里只验证了到达服务器）。
4. 过期更新：改 FF-pane 的安装位置或入口后，自动更新成功；有 agy 窗口开着时推迟，不留半成品。
5. 用户在 agy 里自己卸了：台账清掉，不补装。
6. 设置里卸载：插件、台账项都没了。
7. 卸载 FF-pane：插件被带走；升级覆盖安装不动它。
8. 旧版本装的插件，新版本能卸。
9. 管理者接任、软件重启后续接，agy 窗口里 ffpane 工具照常能用。
10. 用户自己在终端里开的 agy：不受影响（没有令牌，工具调用报错，不卡）。

## 8. 没验证、要留意的

- 用户自己在终端开 agy 时，插件的服务器会被拉起（一个 FF-pane 进程），调用才报错。要确认拉起代价可以接受，必要时让服务器在没有令牌时立即退出。
- 同一个 agy 会话里，插件服务器的**工具列表很长**（30 个），描述文件按需读取是否会让 agent 多花几步，需要真机观察。
- 钩子对 `call_mcp_tool` 的参数里服务器名的匹配方式（`ServerName` 带引号）需要照真机数据写。

## 9. 实现记录（2026-11-28，Tony 说开工后；分三次提交）

已做（均有单测，全量 3160 条左右通过）：

1. **台账与插件模块**（`apps/desktop/src/main/user-mods/ledger.ts`、`agy-plugin.ts`）：生成插件三个文件（`plugin.json`、`mcp_config.json`、归属标记 `ffpane-owner.json`），判断状态（没装 agy / 没添加 / 已添加最新或过期 / 用户禁用 / 同名别人的），添加、更新、卸载、自动更新。所有对外动作经注入的依赖。
   - 真 agy 的行为（2026-11-28 实测）决定了设计：重复 `agy plugin install <目录>` 是**整体替换**（旧文件会清掉），所以「更新」就是再装一次；用户在 agy 里**禁用**的状态在更新后保留；`agy plugin list --json` 有名字、启用状态、版本、路径。
   - 插件内容只取决于安装位置，不带 FF-pane 版本，免得每次升级都算「过期」。
2. **主进程接线**（`agy-plugin-main.ts`、`index.ts`、`contracts.ts`）：`agy-plugin:status / install / uninstall` 三个通道；启动后异步检查一次，**只更新已装且过期的**；没装的不补装；有 agy 窗口开着就推迟。兜底删目录前有护栏（必须正好是 `<插件目录>/ffpane-workbench` 且有归属标记）。
   - 真 agy 集成测试（`agy-plugin-real.test.ts`）把 agy 的用户目录指到临时目录，走完 添加 → 过期 → 有窗口时推迟 → 自动更新 → 卸载 → 卸载后启动不补装，并确认真实 `~/.gemini` 没动。
3. **设置界面**（`AgyPluginPanel.tsx`）：设置 → Provider →「本机已登录」→ agy 里显示状态和「添加 / 立即更新 / 卸载」；添加和卸载前都有确认，说明写了什么、怎么卸。新建 Gemini 窗口没添加时一行说明，不弹窗。
4. **窗口内说明和管理者提醒**：agy 窗口的说明文件里，按有没有插件写「怎么调」或「没有，别自己去找地址令牌」（`agy-plugin-note.ts`）；管理者用 `ffpane_open_window` 开 agy 窗口时，没添加会在返回里提醒。
5. **钩子自动批准收紧**：`call_mcp_tool` 的服务器名去引号后精确匹配 `ffpane-workbench` 或 `ffpane-workbench_ffpane-workbench`，原来的 `includes` 会放行名字里带这几个字的别人的服务器。真机里 `ServerName` 参数值是带引号的字符串。
6. **安装包卸载钩子**（`resources/installer.nsh`）：卸载 FF-pane 时，如果 `~\.gemini\config\plugins\ffpane-workbench\ffpane-owner.json` 里 `owner` 是 `ff-pane`，调 agy 卸载，失败或没装 agy 就兜底删这个目录；静默卸载也做，升级覆盖安装不做。
   - 判断命令 `findstr /R /C:"owner.*ff-pane"` 已实测：我们的标记返回 0，别人的、缺字段的、缺文件的都返回 1；单测钉住标记里 `"owner": "ff-pane"` 在同一行。
   - **没验证**：NSIS 脚本本身在真实卸载里的行为，要打安装包（编译会检查语法）并在测试机上卸一次。

## 10. 还没验证的

- ~~真实 FF-pane 窗口里，agy 拿到真令牌和管道后调通 `ffpane_whoami`~~ **已验证（2026-11-28）**，见 §11。
- 真实卸载流程（NSIS）。
- 带 agy 窗口开着时的自动更新推迟，在真窗口里的表现。
- §8 里的三项：没令牌时服务器进程的代价、工具列表很长时 agent 多花几步、钩子对 `ServerName` 的匹配（已精确匹配并有单测，待真机）。

## 11. 真窗口端到端验证（2026-11-28）

做法：临时 e2e（不提交），agy 的用户目录指到临时目录（USERPROFILE/HOME），所以真实 `~/.gemini` 不受影响；FF-pane 用开发构建；经 FF-pane 自己的 IPC `agy-plugin:install` 添加插件（等同用户点按钮），再新建一个真的 Gemini 窗口，开场白让它调 `ffpane_whoami`。

结果（agy 的对话转写）：
1. SessionStart 钩子把角色说明注入了（钩子被载入且生效）。
2. agent 自己读了描述文件 `~/.gemini/antigravity-cli/mcp/ffpane-workbench_ffpane-workbench/ffpane_whoami.json`，再用 `call_mcp_tool`（`ServerName` 是 `ffpane-workbench_ffpane-workbench`）调用。
3. **3 秒内拿到真实结果**：`{"windowId":"win-…","title":"Gemini 1","role":"none","permission":"edit","parent":null,"projectName":"Real Agy",…}`，说明真令牌和真管道都走通了。
4. 没有停在「Allow calling this tool?」上，钩子的自动批准生效。
5. agent 最后回答「窗口标题：Gemini 1，角色：none。」

踩到的坑（都是测试环境的，不是产品问题）：
- 把 agy 的用户目录换成**全新**的临时目录，agy 会先弹首次启动引导（选主题），卡住所有输入。完成标记在 `cache/onboarding.json`（`onboardingComplete: true`），不在 `settings.json`。预置这个文件即可跳过；真实用户的 agy 早就走过引导，不受影响。
- `workbench-runtime-phase` 徽章只在「等批准」时才渲染，平时没有，所以不能拿它判断忙/空闲。

还没验证：
- 真实卸载（NSIS）。要打安装包并在测试机上卸一次。
- 带 agy 窗口开着时自动更新推迟，在真窗口里的表现（单测和真 agy 集成测试里已验证推迟逻辑）。
- 三个权限档（只读、edit、edit-exec/yolo）各一次，本次只测了 `edit`。
- 管理者接任、软件重启续接后工具仍可用。
