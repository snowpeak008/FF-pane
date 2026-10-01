# Phase 10 对话总记录

本文件是主控和子 agent 的交接账本。完整汇报只追加在这里，不改已有条目。主控要细节时按标题搜索那一条，不通读全文。

每条标题：`## <YYYY-MM-DD HH:mm> · T10.x · <执行|检查|修复|复验|提交> · <简称>`

正文依次写：任务要点、结论、改动文件、命令结果、问题与遗留、相关文件链接。

## 历史索引

- T10.0 准备：清理换行符、补打 v0.9.2、改写红线、并入计划 — tag `v0.10.0` — [验收记录](../验收记录/T10.0-验收.md)
- T10.1 终端底座：PTY 管理器 + xterm + 打包 — tag `v0.10.1` — [验收记录](../验收记录/T10.1-验收.md)
- T10.2 工作台布局：分屏 + 标签页 + 多项目并行 + 持久化 — tag `v0.10.2` — [验收记录](../验收记录/T10.2-验收.md)
- T10.3 Provider 填表化 + 模板 + 迁移 — tag `v0.10.3` — [验收记录](../验收记录/T10.3-验收.md)
- T10.4 在窗口中启动 Claude / Codex / Grok — tag `v0.10.4` — [验收记录](../验收记录/T10.4-验收.md)
- T10.5 窗口身份令牌 + 权限等级 + 自上而下下放 — tag `v0.10.5` — [验收记录](../验收记录/T10.5-验收.md)
- T10.6 内置角色说明书 + 设为管理者 — tag `v0.10.6` — [验收记录](../验收记录/T10.6-验收.md)
- T10.7a 工作台 MCP 主链路 — tag `v0.10.7` — [验收记录](../验收记录/T10.7a-验收.md)
- T10.7b 工作台 MCP 补全 — tag `v0.10.8` — [验收记录](../验收记录/T10.7b-验收.md)
- T10.9 工作台隐藏面板 — 首验有条件通过（未打 tag） — [验收记录](../验收记录/T10.9-验收.md)

## 2026-10-01 10:40 · T10.9 · 修复 · 执行者

### 任务要点

按首验必须项与建议项修 T10.9，不改验收记录，不提交、不打 tag、不改版本号。

1. `workbench:open-ffpane` 只打开真实的 `.md`（大小写不敏感）。`.exe` / `.bat` / `.cmd` / `.lnk` 以及目录都拒绝。索引行的 `threadFile` 必须是单个 `.md` 文件名，否则整行丢掉，抽屉也不再把原字符串拼进打开路径。
2. Vitest 把 `@ff-pane/core`、`shared`、`storage`、`adapters`、`rag` 以及 `@ff-pane/rag/retrieve` 指到各包 `src`。桌面运行时仍走 dist。
3. `readBriefFile` 用文件句柄只读前 256KB，末尾半个 UTF-8 字符丢掉。
4. 建议：文件符号链接 `EPERM` 只跳过那一条；junction 单独测。补了启动门闩「第一次拒绝、第二次再执行」的单测，以及两条 E2E：启动失败后可再试、从会话页呼出抽屉。

### 结论

三项必须修复和点名的建议都已落地。删掉五个 workspace 包的 `dist` 后 `pnpm test` 仍全绿（2635 通过 / 1 跳过）。测完已把 `dist` 移回。未提交。

### 改动文件

- `apps/desktop/src/shared/workbench/markdown-name.ts`（新建：单个 `.md` 文件名判断）
- `apps/desktop/src/main/workbench/panel-files.ts`（只读前 256KB；打开前确认是真实 `.md`）
- `apps/desktop/src/main/workbench/handlers.ts`（`open-ffpane` 先过上述确认再 `shell.openPath`）
- `apps/desktop/src/main/workbench/thread-store.ts`（解析和追加都要求 `threadFile` 是单个 `.md`）
- `apps/desktop/src/renderer/src/pages/workbench/WorkbenchDrawer.tsx`（记录页只对合格文件名拼路径）
- `apps/desktop/vitest.workspace-alias.ts`（新建）以及根、desktop、五个包的 `vitest.config.ts`
- `apps/desktop/tests/workbench-panel.test.ts`、`apps/desktop/tests/workbench-relaunch.test.ts`
- `apps/desktop/tests/e2e/fake-workbench-cli.js`、`workbench-mcp.spec.ts`、`workbench-cli.spec.ts`
- `docs/对话记录/Phase10-对话总记录.md`（本文件）

### 命令结果

- `pnpm lint`：退出码 0。Biome 801 个文件无修复，`check-i18n` PASS。其后两处小改再跑 Biome，仍过。
- `pnpm --filter @ff-pane/desktop run typecheck`：退出码 0。
- 相关单测（面板、启动门闩、`canSetRole`、清洗锁）：23 通过。
- 移走 `packages/{core,shared,storage,adapters,rag}/dist` 后 `pnpm test`：149 个文件，2635 通过 / 1 跳过，18.81s。相对首验 2631，多 4 条（符号链接拆开、超大 brief、非 md 打开、失败后再启动）。测完 `dist` 已恢复。
- 受影响 E2E（已先 `electron-vite build`）：隐藏面板通过；从会话页呼出抽屉通过（18s）；CLI 第一次解析失败后再点仍能启动通过（3.3s）。

### 问题与遗留

- 没有需要主控拍板的事。下一步按计划派检查员复验即可。
- 单测吃 `src`，Electron / `pnpm dev` 仍吃 `dist`。改了包源码要在应用里看到，还是要构建。
- 验收建议第 4～9 条（筛选只在已加载页、行高、`userInitiated` 默认值、错误条重叠、Markdown 400 块、打开前再验一次符号链接）这次没做。
- 未 commit、未 tag、未改版本号。未改 `docs/验收记录/T10.9-验收.md`。未动 `apps/desktop/scripts/real-config-probe.mjs`。

### 相关文件链接

- [T10.9 验收记录](../验收记录/T10.9-验收.md)
- [Phase 10 计划 §7](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 10:50 · T10.9 · 复验 · 检查员

### 任务要点

复验执行者 10:40 那条对三项必须修复和点名建议的修改。提交前完整跑 lint / typecheck / test / smoke / test:e2e。只改验收记录，并追加本条。

### 结论

**通过。** 可以提交、升版本、打 tag。不需要主控再做产品决策。

1. 打开文件先确认是真实的单个 `.md`，再 `shell.openPath`。`.exe` / `.bat` / `.cmd` / `.lnk` 以及带路径的 `threadFile` 被拒绝，不合格的索引行整行丢掉。
2. Vitest 把五个 workspace 包和 `@ff-pane/rag/retrieve` 指到 `src`。实跑解析进 `packages/core/src/index.ts` 等，没有进这些包的 `dist`。包内 `.js` 引用会落到对应 `.ts`。测试文件仍是 149 个，没有漏跑，也没有新的解析错误。Electron 运行时仍吃 dist，这是预期。
3. brief 用文件句柄只读前 256KB，截断点不拆开 UTF-8。
4. 符号链接与 junction 已拆开；启动失败后可再试、从会话页呼出抽屉，两条 E2E 都过。首轮建议第 4～9 条仍未做，不挡。

### 改动文件

- `docs/验收记录/T10.9-验收.md`（补复验最终裁定与 §9）
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `pnpm lint`：退出码 0。Biome 801 个文件，`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：退出码 0。
- `pnpm test`：2635 通过 / 1 跳过（149 个文件，18.25s）。
- `pnpm smoke`：11 项 PASS。v0.10.8，Electron 44.0.0。
- `pnpm test:e2e`：66 通过（5.1min）。

### 问题与遗留

- 没有需要主控拍板的事。下一步按计划交给执行者提交为 `0.10.9`（不 push）。
- 单测吃 `src`，应用仍吃 `dist`。改包源码后要在 Electron 里看到，仍要先构建该包。
- 首轮建议第 4～9 条（筛选范围、行高、`userInitiated` 默认值、错误条重叠、Markdown 400 块、打开前再验一次符号链接）未做，不挡本单。
- 未 commit、未 tag、未改版本号。未动 `apps/desktop/scripts/real-config-probe.mjs`。

### 相关文件链接

- [T10.9 验收记录](../验收记录/T10.9-验收.md)
- [Phase 10 计划 §7](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 10:54 · T10.9 · 提交 · 执行者

### 任务要点

按计划 §7.2 第 4 步提交 T10.9。版本 `0.10.8` → `0.10.9`。开发进度标 ✅，计划任务表与 §7.5、开发计划两处索引改为已验收，下一步 T10.10。轻量 tag `v0.10.9`。不 push。提交哈希不写进本条，避免提交后再 amend；哈希只回复给主控。

### 结论

已提交并打轻量 tag `v0.10.9`。未 push。`apps/desktop/scripts/real-config-probe.mjs` 未纳入。

### 改动文件

- 版本：根 `package.json`、`apps/desktop/package.json`、`README.md` 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- `docs/开发进度.md`：T10.9 标已验收，登记不挡 T10.10 的遗留，下一单写明记忆 MCP
- `docs/Phase10-多窗口终端工作台计划.md`：状态行、任务表 T10.9、§7.5
- `docs/开发计划.md`：Phase 10 任务表与 §16.4 索引
- 本条与既有验收记录、实现改动一起提交

### 命令结果

- 版本相关单测 `command-ipc.test.ts`、`client-server.test.ts`：2 个文件 74 项通过
- `git tag v0.10.9`（轻量，指向本次提交）
- 未 push

### 问题与遗留

- 不需要主控再做产品决策。下一步派 T10.10。
- 首轮建议第 4～9 条仍不做，不挡 T10.10。单测吃 `src`，应用仍吃 `dist`。
- 未 push。未纳入 `real-config-probe.mjs`。

### 相关文件链接

- [T10.9 验收记录](../验收记录/T10.9-验收.md)
- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 11:15 · T10.10 · 执行 · 执行者

### 任务要点

按计划 §7 与本单实现记忆 MCP，不提交、不打 tag、不改版本号。未改 `apps/desktop/scripts/real-config-probe.mjs`。

1. 在 `ffpane-workbench` 增加 `ffpane_memory_search` / `ffpane_memory_add`。sidecar 只声明并转发；主进程凭窗口令牌裁决。
2. 检索：任何窗口，只用调用者项目根，忽略参数里的项目路径。含 active 与 candidate，不含 archived。最多 20 条，标题加正文合计 16KB。
3. 新增：已授权管理者，或 `openedBy=user`，且 `sanitizeLocked` 不为真。去掉控制字符（正文保留换行）。标题最多 120 字，正文最多 2000 字，同一窗口至少间隔 10 秒。写成 candidate，来源为 `workbench`（窗口标题、id、角色），时间用 `createdAt`。
4. 写入走现有 `saveEntry` 与同一份 `MemoryIndexService`。旧注入仍只选 active；用户在记忆页通过后，同一条进入旧注入。记忆页显示来源标签，工作台来源可删除（按钮文案「删除」，仍调用 `memory:reject`）。
5. 更新 `base.md` 与管理者 / 规划 / 执行 / 检查说明书：何时查、谁能写、被拒绝时用 `ffpane_report` 请上级添加。

### 结论

已实现，待验收。未提交。版本仍是 `0.10.9`。

### 改动文件

- `packages/shared/src/domain/memory.ts`、`packages/shared/tests/domain.test.ts`：来源增加 `workbench`
- `packages/storage/src/memory/entry-file.ts`：来源编解码
- `apps/desktop/src/main/workbench/memory-policy.ts`、`project-memory.ts`（新建）
- `apps/desktop/src/main/workbench/mcp-tools.ts`、`handlers.ts`、`apps/desktop/src/mcp/workbench-tools.ts`
- `apps/desktop/src/main/data.ts`、`index.ts`：记忆索引与工作台共用一份连接
- `apps/desktop/src/renderer/src/pages/memory/MemoryEntryCard.tsx`、`MemoryPage.tsx`
- `locales/zh-CN.json`、`locales/en-US.json`
- `apps/desktop/resources/workbench-roles/base.md` 及四份角色书
- `apps/desktop/tests/workbench-memory.test.ts`（新建）、`workbench-mcp.test.ts`
- `apps/desktop/tests/e2e/fake-workbench-cli.js`、`workbench-mcp.spec.ts`
- `docs/Phase10-多窗口终端工作台计划.md`：§3.2.1 补上两行合同
- `docs/开发进度.md`：T10.10 待验收
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `pnpm lint` 通过
- `pnpm --filter @ff-pane/desktop run typecheck` 通过（先 `pnpm --filter @ff-pane/shared run build` 与 `@ff-pane/storage` 的 build，桌面运行时吃 dist）
- 单测：`workbench-memory.test.ts` + `workbench-mcp.test.ts` 26 项通过；同轮之前含 `workbench-role-resources.test.ts` 的 3 个文件 30 项通过。`packages/shared` `domain.test.ts` 60 项通过。`packages/storage` `memory.test.ts` 30 项通过
- E2E `tests/e2e/workbench-mcp.spec.ts` 6 项通过（含「管理者写入记忆，子窗口能查到但不能写，记忆页可删除」，约 14.8s）。该文件其余 5 项未因假 CLI 改动回退

### 问题与遗留

需主控确认的产品决策：

1. 新记忆写成 **candidate**（低置信），不直接 active。检索马上能查到。旧注入仍只含 active；用户在记忆页通过后才进入旧注入。这是沿用「Agent 只能产生候选」。若希望写入后立刻进旧注入，要改成直接 active。
2. 限额写进了计划 §3.2.1：检索最多 20 条、标题加正文合计 16KB、查询最多 200 字；新增标题 120 字、正文 2000 字；同一窗口至少间隔 10 秒。来源标题最多 80 字。开工时磁盘上没有这两行，已按本单补上。若主控另有未落盘草稿，请核对是否要改这些数字。
3. 被冷启动清洗锁住的窗口不能写，即使它是已授权管理者或 `openedBy=user`。未锁的已授权管理者（含继承来的子管理者）可以写；未锁且用户自己打开的窗口也可以写，不要求角色是管理者。

其他：

- 单测吃 `src`，Electron 与 e2e 吃 `dist`。检查员跑应用或 e2e 前要先构建 `@ff-pane/shared` 和 `@ff-pane/storage`。
- 未提交、未打 tag、未改版本号。未动 `real-config-probe.mjs`。
- T10.9 遗留仍不挡本单。完整 `pnpm test` / `smoke` / 全量 e2e 留给检查员。

### 相关文件链接

- [Phase 10 计划 §3.2.1](../Phase10-多窗口终端工作台计划.md)
- [开发进度 T10.10](../开发进度.md)

## 2026-10-01 11:35 · T10.10 · 检查 · 检查员

### 任务要点

独立验收 T10.10。合同是计划 §3.2.1 的 `ffpane_memory_search` / `ffpane_memory_add` 与任务表 T10.10。对照执行记录「## 2026-10-01 11:15 · T10.10 · 执行 · 执行者」。主控已确认写成 candidate、20 条 / 16KB、标题 120、正文 2000、同窗口 10 秒。只写本验收记录并向总记录追加本条。未改其它文件，未 commit / stash / checkout / reset。

### 结论

**有条件通过，2 项必须修。** 不需要主控做新的产品决策。

冷读不授予管理权。子窗口、被清洗窗口、冷读后的子管理者不能写。冷读后用户自己打开且未锁的顶层窗口可以写，与合同「或 openedBy=user」一致。参数里的项目路径不采用。MCP 写入固定为 candidate，旧注入仍只收 active。检索 JSON 带状态和来源。记忆页有来源标签，工作台来源的删除走原来的拒绝。单测吃 `src`。

必须修：

1. 同一窗口并发 `ffpane_memory_add` 可以在 10 秒内都成功。间隔记在写入成功之后，控制通道也不等上一条结束。探针 `BURST_OK=2`。
2. 检索按索引筛过 active/candidate 之后，回读文件不再看状态。文件已改成 archived、索引还停在 candidate 时仍会返回。探针 `ARCHIVED_LEAK=archived`。

### 改动文件

- `docs/验收记录/T10.10-验收.md`（新建）
- `docs/对话记录/Phase10-对话总记录.md`（本条）

未改源码。反向探针只在系统临时目录。`pnpm smoke` / `pnpm test:e2e` 刷新了已有的 `apps/desktop/out`。

### 命令结果

- `pnpm lint` 通过（Biome 804 文件；check-i18n PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- `pnpm test`：与探针并行时 2639 过 / 1 失败 / 1 跳过（`command-ipc` 加载超时，与本单无关）。单独重跑 **2640 过 / 1 跳过**
- `pnpm smoke`：**11 项 ALL PASS**（版本仍是 0.10.9）
- `pnpm test:e2e`：**67 过**（约 5.2 分钟），含「管理者写入记忆，子窗口能查到但不能写，记忆页可删除」，以及既有交接包「candidate 不入」

### 问题与遗留

必须修两项，见结论。修完由原检查员复验。

不挡、也不要主控现在拍板：有编辑权限的窗口仍可直接改 `.workbench/memory` 把状态写成 active，旧注入会收。这是项目目录可写，不是操作系统隔离。本工具自己的写入是 candidate。

建议：说明书补一句 candidate 尚未确认；检索会先读完整文件再截到 16KB；修复时补并发间隔和回读丢弃 archived 的单测。

### 相关文件链接

- [T10.10 验收记录](../验收记录/T10.10-验收.md)
- [Phase 10 计划 §3.2.1](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 11:40 · T10.10 · 修复 · 连续开发者

### 任务要点

按验收必须项修 T10.10，不改验收记录。本轮指令是修完并自查全绿后提交，不在中途等复验。

1. 同一窗口在开始写文件之前就占住 10 秒间隔。写失败也占着，避免并发两笔都成功。空标题等校验失败仍不占间隔。
2. 检索回读文件后，状态不是 active 或 candidate 的丢掉，不返回 archived。
3. 建议：补了并发、写失败占间隔、索引过期仍丢 archived 的单测。`base.md` 加了一句 candidate 还没确认、不要当成规则（2013 字节，仍在 2KB 内）。直接改项目里的记忆文件把状态写成 active、以及检索先整文件读入，这两条没做。

### 结论

两项必须修复已落地。相关单测、角色说明书体积检查、lint、desktop typecheck 已过。完整 `pnpm test` / `smoke` / `pnpm test:e2e` 紧接着跑。未提交，版本仍是 `0.10.9`。

### 改动文件

- `apps/desktop/src/main/workbench/memory-policy.ts`：`reserveMemoryAdd` 在检查通过时立刻记下时间
- `apps/desktop/src/main/workbench/mcp-tools.ts`：添加走占位，不再等写入成功才记间隔
- `apps/desktop/src/main/workbench/project-memory.ts`：回读后丢掉非 active / candidate
- `apps/desktop/tests/workbench-memory.test.ts`：并发只放行一笔、写失败占间隔、归档不返回
- `apps/desktop/resources/workbench-roles/base.md`：candidate 未确认不要当成规则
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `vitest run tests/workbench-memory.test.ts tests/workbench-role-resources.test.ts`：2 个文件 12 项通过
- `pnpm lint` 通过（Biome 804 个文件；check-i18n PASS）。导入顺序按 Biome 排过一次
- `pnpm --filter @ff-pane/desktop run typecheck` 通过

### 问题与遗留

供 Tony 事后确认（按验收修法，不是新开口）：写入失败也要再等 10 秒，避免并发双写。空标题等还没开始写就失败的，不占间隔。

建议未做：有编辑权限的窗口仍可直接改 `.workbench/memory` 把状态写成 active，旧注入会收。检索仍会先读完整文件，16KB 只限制返回给模型的字数。

未动 `apps/desktop/scripts/real-config-probe.mjs`。未改版本号。

### 相关文件链接

- [T10.10 验收记录](../验收记录/T10.10-验收.md)
- [Phase 10 计划 §7.2](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 11:48 · T10.10 · 自查 · 连续开发者

### 任务要点

必须项修完后，按计划 §4.1 与本轮收尾指令完整跑 lint、desktop typecheck、`pnpm test`、`pnpm smoke`、`pnpm test:e2e`。config-tool 若 flake 则单独复跑。不改验收记录。

### 结论

全绿，可以提交。config-tool 本轮没有 flake。`pnpm test` 首跑有一条与记忆无关的进程超时 flake，单独重跑整套后通过。

### 改动文件

无新增代码。本条只记录自查。版本号在随后的提交条目里改。

### 命令结果

- `pnpm lint` 通过（Biome 804 个文件；check-i18n PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- `pnpm test` 首跑：2642 过 / 1 失败 / 1 跳过。失败是 `packages/adapters/tests/process.test.ts`「超时自动树杀，结束方式为 timeout」，stdout 为空，与记忆无关。单独重跑整套：**2643 过 / 1 跳过**（150 个文件）
- `pnpm smoke`：**11 项 ALL PASS**（当时版本仍是 v0.10.9）
- `pnpm test:e2e`：**67 过**（约 5.3 分钟）。含记忆一条，以及 config-tool 两条。config-tool 未 flake，没有单独复跑

### 问题与遗留

进程超时那条单测在满负载时偶发读不到 `up`。重跑已绿，不改它的超时参数。

### 相关文件链接

- [T10.10 验收记录](../验收记录/T10.10-验收.md)

## 2026-10-01 11:50 · T10.10 · 提交 · 连续开发者

### 任务要点

按计划 §7.2 第 4 步提交 T10.10。版本 `0.10.9` → `0.10.10`。开发进度标 ✅，计划任务表与 §7.5、开发计划索引改为已验收，下一步 T10.11（Tony 已同意纳入本次）。轻量 tag `v0.10.10`。不 push。提交哈希不写进本条，避免提交后再 amend。

### 结论

已提交并打轻量 tag `v0.10.10`。未 push。`apps/desktop/scripts/real-config-probe.mjs` 未纳入。首验是有条件通过，必须项已修并自查全绿；单独复验并入 Phase 10 统一验收。

### 改动文件

- 版本：根 `package.json`、`apps/desktop/package.json`、`README.md` 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- `docs/开发进度.md`：T10.10 标已验收，登记遗留，下一单 T10.11
- `docs/Phase10-多窗口终端工作台计划.md`：状态行、任务表 T10.10、§7.5
- `docs/开发计划.md`：Phase 10 任务表与 §16.4 索引；T10.11 改为已同意
- 记忆 MCP 实现、必须项修复、验收记录、本条

### 命令结果

- 版本相关单测 `command-ipc.test.ts`、`client-server.test.ts`：见提交前实跑
- `git tag v0.10.10`（轻量，指向本次提交）
- 未 push

### 问题与遗留

供 Tony 事后确认：写入失败也占 10 秒。建议未做的两条（直接改记忆文件可变成 active；检索先读完整文件）仍在。下一步做 T10.11，开工前把范围写进计划任务表。

### 相关文件链接

- [T10.10 验收记录](../验收记录/T10.10-验收.md)
- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)
