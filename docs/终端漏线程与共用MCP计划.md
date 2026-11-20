# 终端漏线程与共用 MCP 计划（T11.19）

> 状态：Tony 2026-11-20 定做这两项，先写计划，另开新对话开发。开工前 Tony 先暂停团队的长任务（dev 模式下改主进程代码，FF-pane 会整个重启，CLI 开的后台进程会被一起结束）。
>
> 依据和现场数据见 [内存优化计划](./内存优化计划.md) §0（重新量）、§0.1e（漏线程）、§0.1f（为什么不换 Tauri）。本计划只管两件事：**第一部分**修 node-pty 漏线程，**第二部分**把每个窗口一个的工作台 MCP 小进程，换成主进程里共用的一个。两部分分开发版本，第一部分先做。
>
> 进度：第一部分 2026-11-20 做完，版本 1.0.37，验收见 [`验收记录/1.0.37-终端漏线程修复-验收办法.md`](./验收记录/1.0.37-终端漏线程修复-验收办法.md)。上游没修（§2.2 第 1 步的结论在验收办法里）。第二部分等 Tony 确认第一部分后开工。

## 1. 起因

Tony 说开到 10 个以上窗口，FF-pane 的内存他接受不了。2026-11-20 实测（9 个窗口，主进程已跑 35 小时）：

- 主进程私有内存 943MB，空白 Electron 主进程只有 69MB。拍了只记内存分布的快照，查明多出来的部分来自 **62 个 Node 工作线程**，每个约 11MB。开着的终端约 11 个，**其余约 51 个是已经结束的终端漏下的**。
- 每个 AI 窗口还另开一个 `electron.exe`（以 node 模式跑 `workbench-mcp.js`），私有 21MB，工作集最多 86MB。9 个窗口约 190MB，任务管理器里每开一个窗口就多一个「Electron」。

## 2. 第一部分：node-pty 每结束一个终端漏一个工作线程

### 2.1 原因（已查清、已复现）

- `@lydell/node-pty` 1.2.0-beta.15（`apps/desktop/package.json` 锁定版本）在 Windows 上给每个终端开一个 `worker_threads` 工作线程读输出（`node_modules/@lydell/node-pty-win32-x64/lib/windowsConoutConnection.js`）。这个线程有 4MB 全部提交的栈和自己的 V8 引擎，约 11MB。
- FF-pane 默认用 conpty.dll 模式（`main/terminal/factory.ts`，`useConptyDll: true`）。这个模式下（`windowsPtyAgent.js`）：
  - CLI 自己退出：`_$onProcessExit` 什么都不做，工作线程永远不结束；
  - `kill()`：要等之后再来一次输出（`_outSocket.on('data')`）才 `dispose()`，通常等不到。
- 复现脚本 `test-results/scratch/ptyleak/leak.cjs`（用 FF-pane 同一个 node-pty，跑 cmd.exe）：起始 12 个线程、19MB；20 个终端自己退出后 29 个、261MB；再 20 个后 49 个、477MB；再结束 20 个后 69 个、695MB。
- 验证过的修法 `test-results/scratch/ptyleak/fix.cjs`：终端退出约 1.5 秒后调 `pty._agent._conoutSocketWorker._worker.terminate()`。跑同样 40 个终端，线程数回到 9 个，内存 19 → 33MB。

### 2.2 怎么改

1. **先查上游。** 看 `@lydell/node-pty` 和 microsoft/node-pty 新版本有没有修这个问题。已经修了也先不升级：`factory.ts` 依赖 1.2.0-beta.15 的内部结构（`_completePtyConnection` 那个钩子，管 Job 圈禁），升级要重新核对那个钩子，风险比补一刀大。结论写进验收办法。
2. **在 `main/terminal/factory.ts` 里补，不散到业务代码：**
   - 包装里加一个 `releaseConoutWorker()`：从 `pty._agent._conoutSocketWorker._worker` 取工作线程，调 `terminate()`；只调一次（记标记）；内部结构认不出时记一次日志后跳过，不抛错。写法照现有 `_completePtyConnection` 钩子。
   - **时机：**终端退出事件送到之后（`onExit`，也就是 `exitDelivered()` 为真以后）再等 2 秒，给 node-pty 自己的 1 秒冲刷留余量，保证最后一屏输出不丢。`kill()` 之后同样等到退出事件送到，再等 2 秒；如果退出事件 5 秒还没来，也释放。
   - conpty.dll 模式和系统 conpty 两种模式都要释放：系统 conpty 模式在 CLI 自己退出时同样不 `dispose()`。
   - **不能动 1.0.15 修过的退出顺序**：退出时先等各终端的退出回调送到（`exitDelivered`），再拆环境。释放工作线程只是在这之后多做一步；退出流程里不要因为等这 2 秒拖慢关窗，退出时直接释放即可。
3. **补诊断：**
   - 5 分钟一行的 `[memory]` 日志补两项：主进程私有内存（`app.getAppMetrics()` 里主进程的 `memory.privateBytes`），以及「开过 / 已释放」的终端工作线程数。
   - 以后再漏，日志里一眼能看出。

### 2.3 测试和验收

- 单测：用假的 `_agent` 结构测 `releaseConoutWorker`，包括只调一次、结构认不出时不抛错、退出事件送到之前不释放。
- 实测脚本：把 `leak.cjs` 改成调 FF-pane 的 `createNodePtyFactory()`，开、结束 40 个终端（自己退出、被结束各一半）。线程数回到起始值 ±3，私有内存涨幅不超过 30MB。脚本放 `test-results/scratch/ptyleak/`。
- e2e：在现有的工作台终端测试里加一条，开关窗口 20 次后，主进程私有内存涨幅不超过 60MB。
- 退出不崩：全量 e2e 跑完，`apps/desktop/test-results/e2e-crash-dumps` 里没有新增主进程的 dump（搜狗输入法那种环境问题除外）。
- 现场验收：Tony 正常用一天，`[memory]` 日志里主进程私有内存不再随时间上涨，开 10 个窗口时在 300MB 以内。

## 3. 第二部分：工作台 MCP 改成主进程里共用一个

### 3.1 现状

- 每个 AI 窗口启动一个 `electron.exe`（`ELECTRON_RUN_AS_NODE=1` 跑 `out/main/workbench-mcp.js`，规格在 `main/workbench/mcp-server-spec.ts`）。它只做转发：从 stdio 收 MCP 请求，按 `FF_PANE_WINDOW_TOKEN` 和 `FF_PANE_WB_PIPE` 连主进程的控制通道（`main/workbench/control-channel.ts`），见 `mcp/workbench-server.ts`。
- 授权全在主进程：令牌对应哪个窗口、能用哪些工具。小进程本身不判断。
- 各运行时的接法在 `main/workbench/launch-cli.ts`：
  - Claude：`--mcp-config` 临时文件，加 `--strict-mcp-config`，令牌写成 `${FF_PANE_WINDOW_TOKEN}`，由 CLI 展开；
  - Codex：`-c mcp_servers.…` 转发，`tool_timeout_sec` 600；
  - Grok、Cursor：写进它们读的配置文件。
- 项目开了自配置工具时，Grok、Cursor 窗口还会多开一个 `config-mcp` 小进程（`configToolForFile`）。**这次不动它**，只在验收办法里记一笔。

### 3.2 怎么改

照 CC-Panes 的做法（它主程序里开一个 HTTP 的 MCP 服务，见 `test-results/ref/cc-pane` 的 `orchestrator_service.rs`、`claude.rs:307-321`、`codex.rs:399-413`）。不加新库：用 `node:http`，MCP 协议复用 `mcp/protocol.ts` 的 `handleMcpLine`，工具执行走控制通道现在的同一段分发代码，不复制一份授权逻辑。

1. **服务：**
   - 主进程开 MCP Streamable HTTP 服务，地址 `http://127.0.0.1:<随机端口>/mcp`，只监听本机回环地址；
   - 请求头的 `Host` 不是 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的一律拒绝；带了 `Origin` 的也拒绝（防 DNS 重绑定）；
   - 认证：`Authorization: Bearer <窗口令牌>`，和控制通道用同一套令牌。令牌无效回 401，文字照现有的「请重启该窗口」写；
   - 窗口关掉或重启时，令牌照现在的做法作废。
2. **各运行时的接法：**
   - Claude：`--mcp-config` 里写 `{"type":"http","url":"…","headers":{"Authorization":"Bearer ${FF_PANE_WINDOW_TOKEN}"}}`，仍然 `--strict-mcp-config`，令牌仍由 CLI 从进程环境展开，文件里不写明文。
   - Codex：`-c mcp_servers.<名>.url="…"`，加 `bearer_token_env_var="FF_PANE_WINDOW_TOKEN"`，`tool_timeout_sec` 照旧 600。先用本机 Codex（现在 0.166 / 0.171）确认这两个键名。
   - Cursor：它的 mcp.json 写 `url` 和 `headers`，先确认 cursor-agent 支持 HTTP 方式和环境变量展开。
   - Grok：先确认支持不支持。不支持就继续用小进程，见第 4 条。
3. **长调用：**
   - `ffpane_wait_events` 最长挂 540 秒，改模型、重启这类工具最长 90 秒（现在小进程里 `RELAUNCH_CALL_TIMEOUT_MS` 管这个）；
   - HTTP 上用 SSE 回复，每 15 秒发一次保活（注释行，或 MCP 的进度通知），免得被中间的空闲超时掐断；
   - 主进程这边按工具自己的时长放超时，规则照搬 `workbench-server.ts` 的 `createWorkbenchMcpOptions`；
   - **必须用真 CLI 实测**：Claude 和 Codex 各调一次挂满 9 分钟的 `ffpane_wait_events`，都能正常收到结果。Claude 如果对 HTTP 方式的 MCP 有单独的超时（比如 `MCP_TOOL_TIMEOUT`），就在开窗环境里设好。
4. **留退路：**
   - 每种运行时用哪种方式，集中在一张表里（`mcp-server-spec.ts` 或新的纯函数模块），默认 Claude、Codex 用 HTTP；
   - 某种 CLI 实测不行就在表里退回小进程，不改别处；
   - 开发和排查时可用环境变量 `FF_PANE_MCP_TRANSPORT=stdio` 全部退回旧方式；
   - `workbench-mcp.js` 继续打包，给退路和 Grok 用。
5. **主进程重启：** 端口会变。窗口续接时照常重新生成配置，所以不用固定端口。dev 模式下主进程重启本来就会结束所有 CLI。
6. **代码组织：** HTTP 服务单独一个文件（比如 `main/workbench/mcp-http.ts`）。协议处理、鉴权判断、保活节奏写成纯函数单测，不依赖 Electron。

### 3.3 测试和验收

- 单测：鉴权（没令牌、令牌错、令牌作废、Host / Origin 不对）；`initialize`、`tools/list`、`tools/call`；长调用期间有保活；各运行时生成的配置（Claude 的 json、Codex 的 `-c` 参数）。
- e2e：`workbench-mcp.spec.ts` 等现有测试用的是假 CLI，要改成既测 HTTP 也测退路。
- 真窗口实测：参考 `test-results/scratch/zz-real-*.spec.ts` 的做法，用真 Claude、真 Codex 和隔离的 `FF_PANE_DATA_ROOT`：
  - 调 `ffpane_list_windows`、`ffpane_send_message`、挂满 9 分钟的 `ffpane_wait_events`；
  - 管理者调 `ffpane_restart_window` 重启一个执行窗口，重启后新令牌能用、旧令牌被拒。
- 现场验收：Tony 开 10 个窗口，任务管理器里不再有 `workbench-mcp` 的 electron 进程，比改之前少约 200MB；团队照常收发消息，管理者照常被叫醒。

## 4. 不做

- 不换 Tauri，不重写主进程（理由见内存优化计划 §0.1f）。
- 不做空闲窗口休眠（Tony 2026-11-20：卡的时候十几个窗口都在干活，休眠帮不上）。
- 不动 `config-mcp` 小进程、Claude hooks、写入守卫。
- 不升级 node-pty（除非 §2.2 第 1 步查明有必要，并且先问 Tony）。

## 5. 开工前、交付时

- 开工前确认 Tony 已经暂停长任务。dev 模式下改主进程，FF-pane 会整个重启，CLI 开的后台进程（包括 Unity）会被一起结束。改界面文件会推到 Tony 正在用的界面上，这次应该不用改界面。
- 版本号接着 `docs/开发进度.md` 最新的往下排。两部分各一个版本，各写一份 `docs/验收记录/<版本>-…-验收办法.md`，在开发进度里各加一节。
- 按 Tony 的规矩：直接提交到 main，不推送。
