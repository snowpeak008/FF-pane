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

## 2026-10-01 12:26 · T10.11 · 下线旧后台会话 · 连续开发者

### 任务要点

按 Tony 已同意的范围下线旧后台会话。先把范围写进计划任务表，再改代码。不确定是否可删的保留，并记在本条。

### 结论

旧页面、旧命令、只服务旧流程的编排已删除。启动进入工作台。侧栏剩项目、工作台、记忆、知识库，设置仍在底部。旧磁盘数据不删不迁。工作台、记忆、知识库、Provider 仍在。

### 改动文件

删除：会话 / 计划 / 任务 / 记录页面与路由；命令面板旧版入口；`session` 下的 orchestrator、settlement、task-settled、repair、interrupted、event-map、registry、barrel；对应单测与只覆盖旧流程的 E2E。

保留并仍被工作台用到：npm shim、进程环境清洗、Job Object、provider 注入、Profile、`session/env.ts`、`session/knowledge-tool.ts`、`session/quit.ts`、适配器包。

保留但界面不再调用：领域与 storage 的 Plan / Task / Run / Session 类型；`data.ts` 里的 plans / tasks / runs / sessions 查询通道；配置 MCP 实现、`session/config-tool.ts`、`session/config-draft-hub.ts`、设置页开关。退出时只 flush 工作台布局，不再等待旧编排器。

产品文档：`README.md`、`docs/技术选型.md`、`docs/项目设计计划-v1.0.md` 已改成现行形态。历史设计章节留着。

### 供 Tony 事后确认

1. 项目卡片不再显示计划版本、进行中任务数、最后活动。只留路径、登记时间，以及数据目录缺失警告。
2. B 栏不再显示任务落定圆点。点项目进入工作台。
3. 侧栏快捷键改为 Ctrl+1~4：项目、工作台、记忆、知识库。设置仍是 Ctrl+,。
4. 知识库去掉「发送到当前会话」，只留复制引用。
5. 配置 MCP 开关还在设置页，但不再注入任何窗口。没有把它接到工作台。
6. 习惯建议桥随会话页删除。记忆页里的习惯管理保留。
7. 直接打开旧地址（例如 `#/session`）会落到「找不到页面」，不会再读旧数据。

### 相关文件链接

- [Phase 10 计划 T10.11](../Phase10-多窗口终端工作台计划.md)
- [开发进度](../开发进度.md)

## 2026-10-01 12:28 · T10.11 · 自查 · 连续开发者

### 任务要点

完整跑 lint、desktop typecheck、`pnpm test`、`pnpm smoke`、`pnpm test:e2e`，并 `electron-builder --dir` 后用打包产物启动。删除旧流程测试是允许的。工作台、记忆、知识库、Provider 的测试文件仍在套件里。

### 结论

全绿。打包目录能启动，`--smoke` 通过。产物不提交。

### 命令结果

- `pnpm lint` 通过（Biome；check-i18n PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- `pnpm test`：**2384 过 / 1 跳过**（135 个文件）。相对 T10.10 的 2643，少掉的是已删除的旧流程测试
- `pnpm smoke`：11 项 ALL PASS（当时版本 v0.10.10）
- `pnpm test:e2e`：首轮 40 过 / 5 失败。失败是默认页已改为工作台，以及项目卡片不再报旧计划。修测试后整套 **45 过**（约 4.5 分钟）。config-tool 未 flake
- `pnpm exec electron-builder --dir`：成功，输出 `apps/desktop/release/win-unpacked/`
- 打包产物 `FF-pane.exe --smoke`（`FF_PANE_DATA_ROOT` 指向临时目录）：ALL PASS，应用信息为 **FF-pane v0.10.11**

### 问题与遗留

打包日志里 pdfjs 仍提示缺 `@napi-rs/canvas`，与本次删除无关，smoke 仍过。其它平台的可选原生包未打进 Windows 目录，属 electron-builder 的既有提示。

### 相关文件链接

- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 12:30 · T10.11 · 提交 · 连续开发者

### 任务要点

版本 `0.10.10` → `0.10.11`。开发进度标已实现，计划任务表与 §7.5、开发计划索引同步。轻量 tag `v0.10.11` 打在收尾记录提交上（见下一条）。不 push。本条不写哈希，避免提交后再 amend。

### 结论

代码与本条一并提交。tag 在写入「开发完成」条目的下一笔提交上。未 push。`apps/desktop/scripts/real-config-probe.mjs` 未纳入。`apps/desktop/release/` 不提交。

### 改动文件

- 版本：根 `package.json`、`apps/desktop/package.json`、`README.md` 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- 旧流程下线、测试与文案、三份产品文档
- `docs/开发进度.md`、`docs/Phase10-多窗口终端工作台计划.md`、`docs/开发计划.md`、本条

### 命令结果

- 版本相关单测 `command-ipc.test.ts`、`client-server.test.ts`、`project-summary.test.ts`：76 过
- 未 push

### 问题与遗留

供 Tony 确认的七条见上一条「下线旧后台会话」。配置 MCP 开关目前没有运行时效果。

### 相关文件链接

- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)
- [开发进度](../开发进度.md)

## 2026-10-01 12:32 · Phase 10 · 开发完成 · 连续开发者

### 任务要点

T10.10 与 T10.11 都已做完。本条列出提交与 tag、待 Tony 确认的决定、遗留风险、建议的统一验收重点。

### 提交与 tag

- T10.10：`9626fcbe5a992b8f32447f66727bfcb86a203d1f`，轻量 tag `v0.10.10`
- T10.11 代码：`bb391fa67fc348f93a2d6e0caf68d3413bec357d`（`feat: T10.11 下线旧后台会话，启动进入工作台`）
- 轻量 tag `v0.10.11` 打在写入本条的提交上。未 push

### 待 Tony 确认

T10.10（验收时已按最简单方案做，建议项未做）：

1. 写入失败也占 10 秒。空标题等校验失败不占间隔。
2. 有编辑权限的窗口仍可直接改 `.workbench/memory`，把状态写成 active，旧注入会收。
3. 检索先读完整文件，16KB 只限制返回给模型的字数。

T10.11：

1. 项目卡片不再显示计划版本、进行中任务数、最后活动。只留路径、登记时间，以及数据目录缺失警告。
2. B 栏不再显示任务落定圆点。点项目进入工作台。
3. 侧栏快捷键改为 Ctrl+1~4：项目、工作台、记忆、知识库。设置仍是 Ctrl+,。
4. 知识库去掉「发送到当前会话」，只留复制引用。
5. 配置 MCP 开关还在设置页，但不再注入任何窗口。没有把它接到工作台。
6. 习惯建议桥随会话页删除。记忆页里的习惯管理保留。
7. 直接打开旧地址（例如 `#/session`）会落到「找不到页面」。

不确定所以保留：领域与 storage 的 Plan / Task / Run / Session 类型；`data.ts` 里的旧查询通道（界面和启动不调用）；配置 MCP 实现与设置开关；适配器包；退出协调器（只 flush 工作台布局）。

### 遗留风险

- 权限摘要多重集可能被减穿。
- Codex 首轮前手动发送仍有残余。
- 工作台 Codex 窗口会暂时替换用户自定义 notify。
- 同目录极短时间双开 Codex，认领可能超时。
- 配置 MCP 开关打开后没有运行时效果。
- 若有外部调用仍可经 IPC 读到旧计划 / 任务 / 会话文件。应用自己的界面和启动不会去读。
- 单测吃 `src`，Electron 吃 `dist`。
- 适配器「超时自动树杀」单测在满负载时偶发读不到 `up`。本轮整套一次通过。
- 打包时 pdfjs 仍提示缺 `@napi-rs/canvas`，smoke 仍过。

### 建议的统一验收重点

1. 冷启动落在工作台；没选项目时是空态，选了项目能开终端。
2. 侧栏只有项目、工作台、记忆、知识库，设置在底部。命令面板里没有「旧版」页面。
3. 工作台分屏、角色、MCP 开窗口 / 汇报 / 记忆检索与写入、隐藏面板抽屉。
4. 记忆页审核、知识库收录与检索、Provider 与 Profile 保存。
5. 旧项目目录里已有的计划、任务、会话文件还在，界面不展示它们。
6. 配置 MCP 开关能保存，但当前不会进任何窗口。
7. 打包目录 `FF-pane.exe` 能启动（本轮 `--smoke` 已过，产物未提交）。

### 相关文件链接

- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)
- [开发进度](../开发进度.md)
- [T10.10 验收记录](../验收记录/T10.10-验收.md)

## 2026-10-01 12:55 · Phase 10 · 统一验收 · 检查员

### 任务要点

独立验收 `v0.10.9`..`v0.10.11`（T10.10 记忆 MCP 及其修复、T10.11 下线旧流程）。只写本验收记录并向总记录追加本条。未改其它文件，未 commit / stash / checkout / reset。打包写在系统临时目录，冒烟后已删除。未读未改 `~/.aiworkbench`，未改 `~/.claude` / `~/.codex`。

### 结论

**有条件通过，必须修复 1 项。** 需要主控把这一项交回去修。待 Tony 确认的决定在验收记录里，本条下面有建议。

T10.10 首验两项已真正解决：同一窗口在写文件前占住 10 秒（写失败也占，空标题不占）；检索回读后丢掉 archived。单测走 `executeWorkbenchTool`，8 项通过。

T10.11 没有误删工作台 / 记忆 / 知识库 / Provider / Profile / 密钥 / 设置仍依赖的代码。启动进工作台，侧栏只剩四页加底部设置。旧磁盘数据没有删除或迁移逻辑。安全原则没有被这三笔提交改坏。工作台、记忆、知识库、Provider 的测试文件相对 v0.10.9 没有减少，并多了记忆单测。

必须修复：设置页「工作台自配置工具」的 subtitle / hint / enabledNote（中英）仍说打开后会注册给 Agent、写入走确认对话框、调用记入执行记录。`configToolEnabled` 只在设置页和项目设置里读写，工作台启动不看它；确认对话框和执行记录页已删。开关可以留着，文案必须改成「会保存，当前不会进入任何窗口」。

### 改动文件

- `docs/验收记录/Phase10-统一验收.md`（新建）
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `pnpm lint` 通过（Biome 737 个文件；check-i18n PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- 记忆单测 8 过
- `pnpm test` 第三次整套：**2384 过 / 1 跳过**（135 个文件）。前两次在负载下有命令面板超时、适配器树杀 flake、PTY 清理 EPERM；相关文件相对 v0.10.9 无改动，单独重跑 PTY 通过
- `pnpm smoke`：**11 项 ALL PASS**（FF-pane v0.10.11，含 PTY、hook、角色说明书、workbench-mcp）
- `pnpm test:e2e`：**45 过**（约 5.1 分钟）
- `electron-builder --dir` 输出到 `%TEMP%\ffpane-p10-accept-pack`。解包目录里 PTY 的 conpty / OpenConsole、`resources\workbench-hook.mjs`、asar 内 `workbench-mcp.js` 都在。`FF-pane.exe --smoke`（数据根在临时目录）**ALL PASS**，v0.10.11。临时目录已删。pdfjs 缺 canvas 的警告不记失败

### 问题与遗留

必须修复 1 项，见结论。

建议不挡：删掉已下线页面的无用语言包（`session.*`、`nav.session/plan/tasks/runs`、`knowledge.sendToSession` 等）；README「不再读取」改成「界面和启动不读，查询通道还在」。直接改记忆文件仍可变成 active；检索仍先读完整文件。

待 Tony 确认（建议都写在验收记录）：写入失败也占 10 秒，建议同意。手改记忆文件、检索先读整文件，建议先维持。项目卡片和 B 栏去掉旧计划/任务信息，建议同意。快捷键 Ctrl+1~4，建议同意（Ctrl+3 从会话变成记忆）。知识库只留复制引用，建议同意。配置开关先留着但文案必须说当前无效。习惯桥删除、习惯管理留在记忆页，建议同意。旧地址进找不到页面，建议同意。

### 相关文件链接

- [Phase 10 统一验收](../验收记录/Phase10-统一验收.md)
- [T10.10 验收记录](../验收记录/T10.10-验收.md)
- [Phase 10 计划 §7](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 13:04 · Phase10 统一验收 · 修复 · 自配置开关文案

### 任务要点

把设置页「工作台自配置工具」里仍把「注册给 Agent / 确认对话框 / 记入执行记录 / 提交草案经确认才保存」写成当前能力的说明，改成现在的实话，中英文同步。实话：开关会保存设置，但当前不会进入任何工作台窗口、不会注册给 Agent，也没有确认对话框和执行记录。开关和实现保留。未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude` / `~/.codex`。

### 结论

`settings.configTool.subtitle`、`hint`、`enabledNote`，以及同区块仍把「确认后才保存 / 记入执行记录」写成当前能力的 `safetyNote`，中英都已改成上述实话。单测和 e2e 没有断言旧文案，测试未改。不需要主控决策。

### 改动文件

- `locales/zh-CN.json`
- `locales/en-US.json`
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `pnpm lint` 通过（Biome 737 个文件，无修正；`check-i18n` PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- grep：`apps/desktop/tests` 没有断言旧的 configTool 说明文案
- `pnpm exec vitest run apps/desktop/tests/locales-parity.test.ts`：2 过

### 问题与遗留

无。开关与配置工具实现未删。已下线页面语言包里仍有「未经确认不会保存」一类句子（如 `session.configDraft`），验收记为建议，不在本步。

### 相关文件链接

- [Phase 10 统一验收](../验收记录/Phase10-统一验收.md)
- [设置页自配置区块](../../apps/desktop/src/renderer/src/pages/settings/ConfigToolSection.tsx)
- [中文语言包](../../locales/zh-CN.json)
- [英文语言包](../../locales/en-US.json)

## 2026-10-01 13:13 · Phase10 统一验收 · 复验 · 自配置开关文案

### 任务要点

独立复验设置页「工作台自配置工具」文案修复。用 git diff 核对未提交改动；反向核对 `ConfigToolSection` 用到的键、开关和实现是否还在；完整跑 lint、desktop typecheck、test、smoke、test:e2e。只追加验收记录和本总记录。未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude` / `~/.codex`。未运行消耗 AI 额度的命令。

### 结论

通过。`settings.configTool.subtitle`、`safetyNote`、`hint`、`enabledNote` 中英文都如实写成：开关会保存；当前不进任何工作台窗口、不注册给 Agent；没有确认对话框，调用不记入执行记录。渲染层 8 个键都被这两份语言包覆盖，没有仍在显示的旧句子。开关和 `configToolEnabled` 写入还在。五条命令首跑全过，已知偶发没有出现，没有单独重跑。不需要主控决策。

### 改动文件

- `docs/验收记录/Phase10-统一验收.md`（末尾追加「复验（必须项）」，旧内容未改）
- `docs/对话记录/Phase10-对话总记录.md`（本条）

核对过、本步未改：`locales/zh-CN.json`、`locales/en-US.json`（修复者未提交改动，各 4 句）。

### 命令结果

- `pnpm lint` 通过（Biome 737 个文件，无修正；`check-i18n` PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- `pnpm test`：2384 过 / 1 跳过（135 个文件，约 20 秒）
- `pnpm smoke`：11 项 ALL PASS（FF-pane v0.10.11；pdfjs 缺 canvas 的警告在 PASS 之前，不记失败）
- `pnpm test:e2e`：45 过（约 4.8 分钟），含设置页开关可打开并保持选中

### 问题与遗留

无。必须项关闭。已下线页面语言包里的旧句子（如 `session.configDraft`、`runs.configTool`）仍在语言包中，原验收记为建议，设置页不显示它们，本步未改。开关要不要以后接到工作台，仍是验收原文「待你确认的决定」里的产品选择，不挡这次通过。

### 相关文件链接

- [Phase 10 统一验收](../验收记录/Phase10-统一验收.md)
- [设置页自配置区块](../../apps/desktop/src/renderer/src/pages/settings/ConfigToolSection.tsx)
- [中文语言包](../../locales/zh-CN.json)
- [英文语言包](../../locales/en-US.json)

## 2026-10-01 13:18 · Phase10 统一验收 · 提交 · v0.10.12

### 任务要点

按计划 §7.2 第 4 步提交统一验收。版本 `0.10.11` → `0.10.12`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 Phase 10 统一验收通过（含自配置开关文案必须项），并把建议（非阻断）与【待你确认的决定】写成移交事项。计划 §7.5 同步为已通过、当前版本 0.10.12。轻量 tag `v0.10.12`，不 push。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude` / `~/.codex`。

### 结论

已提交并打轻量 tag `v0.10.12`，未 push。文案修复、复验记录、版本号和进度文档在同一笔提交。不需要主控决策。移交事项等 Tony 确认。

### 改动文件

暂存并提交：

- `package.json`
- `apps/desktop/package.json`
- `README.md`
- `apps/desktop/tests/client-server.test.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `locales/zh-CN.json`
- `locales/en-US.json`
- `docs/开发进度.md`
- `docs/开发计划.md`（索引状态改为统一验收通过；实现 tag 仍是 `v0.10.11`）
- `docs/Phase10-多窗口终端工作台计划.md`
- `docs/验收记录/Phase10-统一验收.md`
- `docs/对话记录/Phase10-对话总记录.md`（本条，以及此前未提交的修复与复验条目）

未暂存：`apps/desktop/scripts/real-config-probe.mjs`。没有加入 `apps/desktop/out` 或其它构建产物。

### 命令结果

- `pnpm lint` 通过（Biome 737 个文件，无修正；`check-i18n` PASS）
- `pnpm --filter @ff-pane/desktop run typecheck` 通过
- `pnpm exec vitest run apps/desktop/tests/command-ipc.test.ts apps/desktop/tests/client-server.test.ts`：2 个文件，73 过
- 提交信息：`fix: Phase 10 统一验收 自配置开关文案改为实话`
- 轻量 tag `v0.10.12`，未 push
- 提交哈希：`03466dafaf1c59a783bbfb776a47a450df8d9c42`

### 问题与遗留

移交事项已写入 `docs/开发进度.md`，本提交没有顺手做那些建议。验收记录、总记录旧条目、T10.11 自查段落里的 `0.10.11` 是当时的事实，没有改成 0.10.12。上面的提交哈希是 tag `v0.10.12` 所指的那一笔；这一行是后补的，所以 tag 里的本条仍写着占位，工作区这一笔把它换成了真实哈希。

### 相关文件链接

- [Phase 10 统一验收](../验收记录/Phase10-统一验收.md)
- [开发进度](../开发进度.md)
- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 13:42 · Phase10 · T10.12 · 调研 · 项目配置现状

### 任务要点

只读调查 T10.12（计划 §8，并遵守 §7.3、§7.4）。查清：开窗口如何选来源、Provider / Profile / 连法能否复用、项目数据能否挂配置 id、思考强度如何下发。不改代码、不提交、不读写 `~/.aiworkbench`、不打开 `~/.claude` / `~/.codex`、不跑消耗额度的命令、不碰 `apps/desktop/scripts/real-config-probe.mjs`。

### 结论

#### 1. 现在开窗口怎么选来源

工作台启动 Claude / Codex **必须带一条已有档案（Profile）的 id**。主进程按这个 id 读档案，再读它指向的来源（Provider），用档案上的连法决定走本机登录还是中转。没有「不选来源、直接用本机登录」的入口。

- 请求合同里 `profileId` 必填：`apps/desktop/src/shared-ipc/contracts.ts:246-250`。
- 启动体：`apps/desktop/src/main/workbench/launch-cli.ts:267-325`。读档案 → 读来源 → 模型取档案 `model`，空则用来源的 `defaultModelId` → 思考强度只读档案 `reasoningEffort` → `resolveConnectionMode(档案.connectionMode, 来源.templateId)`。连法不是 `local_cli` 且来源有密钥引用时，才取出密钥。
- 本机登录真正生效的地方：`apps/desktop/src/main/session/env.ts:154-156`（`local_cli` 注入的环境变量是空表）；`packages/core/src/provider-injection/resolve.ts:182-198`（`local-login` 模板对 Claude / Codex 的环境变量和配置覆盖都是空的）。也就是不塞密钥、不塞网址，让 CLI 用它自己的登录。
- 选「本机 CLI」保存档案时，会自动绑上（没有就新建）一条名叫「本地 CLI」的 `local-login` 来源：`apps/desktop/src/main/connection-mode.ts:57-84`。用户不用手填网址。

界面上开一个 AI 窗口，对话框一次里要定这些（`apps/desktop/src/renderer/src/pages/workbench/NewWindowDialog.tsx`）：

1. 种类：终端 / Claude / Codex（约 155-178 行）。
2. 档案下拉（约 207-221 行）。打开时预填本机浏览器记下的上次档案，没有就用第一条同 CLI 档案（33、51-65、110-115 行）。没有空选项。一条档案都没有时，确认按钮禁用，只能去设置（142-148、190-204 行）。
3. 权限四档；选「全放开」还要再勾确认（约 223-260 行）。
4. 角色：管理者 / 写计划 / 工作者 / 检查员 / 普通（约 262-280 行）。
5. 开场白可空（约 282-294 行）。

PowerShell 窗口不选档案。档案上的「默认角色」和「权限预设」**不参与**这次启动；窗口角色和权限以对话框和主进程权限表为准。

管理者用 MCP `ffpane_open_window` 开子窗口：

- 工具声明里 `profileId` 可省略：`apps/desktop/src/mcp/workbench-tools.ts:80-107`。必填仍是 cli、role、permission、title。
- 传入后：`apps/desktop/src/main/workbench/mcp-tools.ts:336-364` → `apps/desktop/src/main/workbench/open-child.ts:167-214`。
- 解析规则：`apps/desktop/src/main/workbench/handlers.ts:756-772`。传了 id 就用那条（还得对得上这个 CLI）；不传则用**本进程内存**里该 CLI 最近一次启动成功的档案（265、404-405 行，只活在这次应用运行里）；再没有就用档案列表里第一条同 CLI 的。一条都没有就报错。
- 这不是「本机登录」。最近那条或第一条完全可能是中转。对话框记在浏览器里的上次选择，MCP 不读。应用一重启，内存里的「最近一次」就没了。

#### 2. 现有数据能不能拼出「每个 CLI 一条路」

能复用的是「一条路」的零件，不能把现有档案原样当成一张配置。档案是「一个 CLI + 一个来源 + 可选模型 + 可选思考强度」，还捆着角色、权限、输出语言。Tony 要的配置是「一张表：Claude 一条路、Codex 一条路」。

| 东西 | 存在哪 | 关键字段 |
| --- | --- | --- |
| 来源 Provider | 全局数据根 `providers.json`（version 2）。路径 `packages/storage/src/fs/layout.ts:44-45`，结构 `packages/shared/src/domain/provider.ts:96-119` | `templateId`、`baseUrl`、`apiKeyRef`（只是引用）、`models`、`defaultModelId`、`extraEnv`、`options` |
| 本机登录模板 | `packages/shared/src/domain/provider-templates.ts:124-130` | id `local-login`；网址和密钥在表单里隐藏；Claude 和 Codex 都能用 |
| 其它模板 | 同文件 79-123 行 | Anthropic 官方 / 兼容、OpenAI 官方 / 兼容。兼容中转要网址和密钥 |
| 档案 Profile | 全局 `profiles.json`（version 1）。`packages/storage/src/profiles/store.ts:27-33`，结构 `packages/shared/src/domain/profile.ts:125-170` | `runtime`、`providerId`、`model?`、`reasoningEffort?`、`connectionMode?`，外加 `defaultRole`、`permissionPreset`、`outputLanguage`、`genericExec` |
| 连法 | `packages/shared/src/domain/profile.ts:215-263` | 只有 `local_cli`（本机登录）和 `relay`（中转）。档案没写时，`local-login` / 旧 `cli_login` 推断为本机，其余推断为中转 |
| 思考强度档 | 同文件 176-201、315-330 行 | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。空 = 不下发。Claude 与 Codex 在白名单里 |
| 旧自定义角色 | 全局 `roles.json`。`profile.ts:68-81`，路径 `layout.ts:48-49` | 名称 + 提示词 + 权限预设。这是旧会话用的，和工作台窗口角色不是一套 |
| 工作台角色说明书 | 安装包里的 md + 数据根 `workbench-role-overrides/`。`apps/desktop/src/main/workbench/role-resources.ts:26-28` | 管理者 / 写计划 / 工作者 / 检查员 / 普通。`packages/shared/src/domain/workbench-role.ts:7` |

设置里已经有对应表单，可当新配置界面的参考，不要整页搬过来：连法、CLI、来源、模型（本机登录可留空 = CLI 默认）、思考强度（可留空）在 `apps/desktop/src/renderer/src/pages/settings/profiles/ProfileEditorDialog.tsx:221-439`。来源填表在 `ProvidersSection` / `ProviderEditorDialog`。

建议直接复用：来源存储和 `local-login`、连法判断、`resolveRuntimeEnv` / `resolveRuntimeConfigOverrides`、`buildInteractiveClaudeArgs` / `buildInteractiveCodexArgs`、思考强度档和 `resolveDispatchedReasoningEffort`。不要把档案 id 当成配置 id。工作台启动本来就不用档案上的角色和权限。

#### 3. 项目数据能不能挂「绑定配置 id」

能挂，而且现在两处都还没有这个字段。

- 项目登记（全局 `projects.json`）只有 id、名称、根路径、登记时间：`packages/shared/src/domain/project.ts:65-74`。新建只写这四项：`packages/storage/src/projects/registry.ts:130-142`。注册表没有「改某一项」的接口。
- 领域类型 `Project` 里有角色绑定 `roleBindings`（`project.ts:17-54`），注释说该写进项目目录的 `project.json`。当前新建项目**不写**这份完整项目对象。
- 真正在写的项目设置是 `packages/storage/src/projects/settings.ts:28-57`：知识库开关、自配置工具开关、检查员开关、检查员档案 id。文件在 `<项目根>/.workbench/project.json`（`layout.ts:77-78`）。更新时未知字段会原样保留（`settings.ts:142-149`），所以加一个可选 `configId` 不会冲掉别的键。缺文件就当全是默认，适合「没绑定 = 跟着默认配置」。
- 建项目对话框只有选目录和起名：`apps/desktop/src/renderer/src/pages/projects/CreateProjectDialog.tsx:111-145`。请求也只有这两项：`contracts.ts:475-480`。主进程建目录并登记：`apps/desktop/src/main/data.ts:319-324`。

建议把绑定放在 `project.json` 的 `configId`（可空）。空着就用那张默认配置。配置本体放全局新文件（与 `profiles.json` 同级），不要塞进注册表，注册表现在没有更新接口，也不该变成第二份项目设置。

#### 4. 思考强度和模型怎么下到窗口；会不会改用户全局 CLI 设置

下发方式是**本次启动的参数（Codex 再加本次进程的 `-c` 覆盖）**，外加中转时的环境变量。不写用户的 `~/.claude` 或 `~/.codex` 全局设置。

工作台每次启动从档案现读（`launch-cli.ts:300-332`）：

- 模型：Claude `--model`（`cli-args.ts:88-90`）；Codex `-m`（`cli-args.ts:135-137`）。空则两个都不传，用 CLI 自己的默认。
- 思考强度：Claude `--effort`（`cli-args.ts:91-93`）。Codex 不走独立参数，而是 `-c model_reasoning_effort="档位"`（`env.ts:134-136` 写入覆盖表，`cli-args.ts:138-140` 拼成 `-c`）。空则都不传。
- 中转：密钥和网址进**这个子进程**的环境变量；Codex 还有本次 `-c` 的 `model_provider` / `model_providers...`。本机登录环境变量为空。
- 另外会剥掉子进程里名字像密钥的环境变量，再叠加上面要注入的：`packages/adapters/src/process/env.ts:88-105`，启动处 `launch-cli.ts:490` 固定打开这层清洗。本机登录因此更不会把父进程里的密钥传进去。

运行中的窗口**不能**改思考强度，界面上也没有这个控件。窗口布局里没有思考强度字段：`packages/shared/src/domain/workbench.ts:69-107`。权限可以改，但提示要重启才进 CLI（`WindowPane.tsx:462`）。重启 / 续接仍用窗口上记下的 `profileId`（`WindowPane.tsx:564-576`），再走同一套启动，所以会重新读那条档案。用户若先去设置改了这条档案的模型或思考强度，再点重启或续接，新值会带上；正在跑的那次进程不会变。

工作台 MCP（`workbench-tools.ts:11-25`）没有设置思考强度的工具。`ffpane_open_window` 也不能传模型和思考强度。另有一套旧的「自配置」草案工具能在档案草案里带 `reasoningEffort`（`apps/desktop/src/mcp/config-tool.ts:83、258`），统一验收已写明：那个开关会保存，但**不会进入任何工作台窗口**。旧会话接口 `session:start` 仍有思考强度覆盖字段（`contracts.ts:1248-1252`），工作台开窗口不走它。

只读代码判断，**没有**把全局设置写进用户 `~/.claude` 或 `~/.codex` 的实现：

- Claude 的 MCP 配置写在系统临时目录：`apps/desktop/src/main/workbench/mcp-temp.ts:1-3、38-45`。适配器同样声明不改 `~/.claude.json`：`packages/adapters/src/claude-code/mcp-file.ts:7`。
- Claude 的 `--settings` 是临时目录里一份只含观察用 hooks 的文件：`hook-launch.ts:77-85`。注释写明与用户设置合并，且只给这次进程。角色提示也写临时目录：`role-manuals.ts:147-158`。
- Codex 的模型、思考强度、来源、MCP、notify 都是本次 `-c`。`packages/adapters/src/codex/command.ts:79` 写明不碰 `~/.codex/config.toml`。notify 这条会盖过用户配置里的 notify，但只对本次进程（`cli-args.ts:60-64`），这是已登记的残余风险，不是写文件。
- 会话认领只读扫描 `CODEX_HOME` 或 `~/.codex/sessions`：`codex-claim.ts:2、68-74`。
- iFlow 会写它自己的受管 settings，与 Claude / Codex 无关。

CLI 进程自己运行时可能往它的会话目录写会话记录。那是 CLI 的行为，本仓库启动代码没有写全局设置文件。本次调查没有打开这两个目录。

#### 5. T10.12 建议方案

**数据结构（新，不把档案改名充数）**

- 全局新文件，例如数据根下 `configs.json`：一张配置 = 名称 + 是否默认 + 可用项目范围 + Claude 一路 + Codex 一路。
- 每一路：`connectionMode`（`local_cli` 或 `relay`）、中转时的 `providerId`、可选 `model`、可选 `reasoningEffort`。本机登录不填模型和思考强度 = 用 CLI 自己的默认，并且不改用户的 CLI 设置。
- 范围：不填 = 所有项目都能用（决定 5）。收窄后，名单外的项目看不到、也不能绑。
- 全局恰好一张 `isDefault`。改默认配置时，不改各项目文件；没写 `configId` 的项目下次新开或重启就跟着新默认（决定 4）。
- 项目绑定：`project.json` 增加可选 `configId`。现有三个开关照旧。
- 窗口若被管理者改过思考强度：记在该窗口的布局字段上（例如 `reasoningEffortOverride`），只在下次启动 / 重启 / 续接时盖过配置里的档位。优先级：窗口覆盖 → 配置里这一路的档位 → 都不填则不传参数。

**界面**

- 设置里新增「配置」：列表、新建、编辑两路、设默认、收窄到哪些项目。中转路继续选现有来源；本机登录不用选来源。
- 建项目对话框可先不动选择（一律跟着默认），或加一个可空的配置下拉。项目上要有地方改绑定（项目卡片或工作台标题栏）。
- 新开窗口对话框去掉档案下拉。剩下：启动 Claude 还是 Codex、权限、角色、可选开场白。启动时用「项目绑定的配置，没有就用默认」里对应那一路。
- 已开窗口不热改路（决定 1、2）。改项目配置后，只影响之后新开和重启。因此重启不能再死拿窗口上的旧 `profileId`。

**MCP**

- `ffpane_open_window` 去掉或忽略 `profileId`。按调用者所在项目的配置选路；这一路没配、或这张配置对该项目不可见，就明确失败。
- 新增一个工具（建议名 `ffpane_set_reasoning_effort`）：管理者可改自己，也可改自己后代里的写计划、工作者。只写入窗口布局，并说明要重启或续接才生效。不要写 CLI 全局设置，不要往 PTY 里写自由文本。
- 工作台 MCP 工具清单（计划 §3.2.1）要一起改。

**旧数据**

- 不删 `profiles.json`、`providers.json`、`roles.json`。来源继续给中转路用。
- 首次使用新配置时，若还没有默认配置，自动造一张：两边都是本机登录、模型和思考强度都空、所有项目可用。
- 不要自动把旧档案合并进来。一个 CLI 可能有多条档案，程序分不清哪条该当默认。
- 已开窗口布局里的 `profileId` 先留着。重启改走项目配置后，这个字段不再当启动依据。
- 对话框的「上次档案」和主进程内存里的「最近档案」在新流程里退役。

**风险**

- 重启 / 续接今天绑死 `profileId`（`WindowPane.tsx:564`）。不改这里，决定 2 的「重启用新配置」不会发生。
- 子窗口今天会继承管理者当时用的档案，不一定等于项目配置。
- Codex 本次 `-c notify` 仍盖过用户自己的 notify（已有残余，不是本次要写文件）。
- 剥密钥环境变量后，本机登录只应依赖 CLI 自己的登录文件；不要再额外设 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，否则会把用户登录藏起来。
- 收窄范围时，可能已经有项目绑着这张配置。
- 自配置草案工具仍能改档案，容易和「配置」混名。工作台不要接它。
- 权限和角色仍是每个窗口自己的，不要塞进配置。

**是否拆开**

建议拆。

- **T10.12a**：配置文件、设置页、项目绑定、开窗口和 `ffpane_open_window` 改走配置、重启改读配置、自动一张默认「两边本机登录」。不含管理者改思考强度。
- **T10.12b**：窗口级思考强度覆盖、管理者界面、新 MCP 工具、重启 / 续接时下发。a 做完后窗口仍只能用配置里写死的档位（或留空）。

**需要 Tony 决定的新问题（大白话）**

1. 设置里现在的「档案」还要不要给人看？建议：工作台改走新配置后先藏起来，磁盘上的旧档案先留着。API 来源那一栏要留，因为中转还得用它。
2. 一张配置里，Claude 和 Codex 是不是都必须选一条路？还是可以只配一个，另一个先不能开？
3. 管理者改了思考强度之后，是等那个人自己点重启或续接才生效，还是改完就自动重启那个窗口？
4. 除了已确认的「自己、写计划、工作者」，管理者能不能改检查员、普通窗口，以及另一个管理者？
5. 新建项目时要不要当场选配置，还是一律先跟着默认、以后再改？
6. 把某张配置收窄到指定项目时，如果已有项目绑着它、但不在名单里：自动改回默认，还是不许收窄并提示？
7. 窗口上要不要显示「现在走哪条路、哪个模型、哪档思考」？换路仍然不行。
8. 默认那张配置能不能删？删了以后，没单独绑定的项目怎么办？
9. 模型是手打名字，还是从已经探测到的列表里选？本机登录留空就用 CLI 自己的默认，这一点已确认。

### 改动文件

- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- 未跑 lint / typecheck / 测试。未启动应用，未调用模型。
- 仅 `Get-Date -Format "yyyy-MM-dd HH:mm"` → `2026-10-01 13:42`，用于本条标题。

### 问题与遗留

上面 9 个问题需要 Tony 定。在此之前不写实现任务说明。调查没有改代码、没有提交、没有读用户数据目录。

### 相关文件链接

- [Phase 10 计划 §8、§7.3、§7.4](../Phase10-多窗口终端工作台计划.md)
- 启动：`apps/desktop/src/main/workbench/launch-cli.ts`、`cli-args.ts`、`apps/desktop/src/main/session/env.ts`
- 对话框：`apps/desktop/src/renderer/src/pages/workbench/NewWindowDialog.tsx`
- MCP：`apps/desktop/src/mcp/workbench-tools.ts`、`apps/desktop/src/main/workbench/mcp-tools.ts`、`open-child.ts`
- 档案 / 来源 / 连法：`packages/shared/src/domain/profile.ts`、`provider.ts`、`provider-templates.ts`
- 项目：`packages/storage/src/projects/registry.ts`、`settings.ts`、`apps/desktop/src/renderer/src/pages/projects/CreateProjectDialog.tsx`

## 2026-10-01 14:03 · Phase10 · T10.12-0 · 调研 · 串联审计

### 任务要点

只读审计现存功能是否还连在工作台主流程上（计划 §9、§8，并遵守 §7.3、§7.4）。对照计划第 8、9 节与统一验收第 2、5 节。不改代码、不提交、不读写 `~/.aiworkbench`、不打开 `~/.claude` / `~/.codex`、不跑消耗额度的命令、不碰 `apps/desktop/scripts/real-config-probe.mjs`。

编辑器搜索索引里还能命中已删文件（`session/index.ts`、`orchestrator.ts`、任务页、会话页）。下面的结论以磁盘为准：这些路径 `Test-Path` 为 MISSING。`apps/desktop/src/main/session/` 只剩 `env.ts`、`knowledge-tool.ts`、`quit.ts`、`config-tool.ts`、`config-draft-hub.ts`。

### 结论

#### 1. 设置页每个区块

页面顺序在 `apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx:31-53`。

| 区块 | 保存什么 | 工作台现在读不读 | 建议 |
| --- | --- | --- | --- |
| 外观 | 本机 `localStorage` 键 `ffpane.ui-theme`（`theme/dom.ts:13`） | 读。整页主题，终端配色也跟着（`TerminalView.tsx` 使用 `useTheme`） | 保持不动 |
| 界面语言 | 本机语言设置，立即换界面（`LanguageSection.tsx:32-34`） | 读。整个界面 | 保持不动 |
| AI 输出语言 | 全局 `config.json` 的 `aiOutputLanguage`（`LanguageSection.tsx:37-38`） | 不读。生产代码里只有设置页在写。旧的提示组装 `assemblePrompt` 只剩测试在调 | T10.13 隐藏。见问题 3 |
| 上下文阈值 | `contextWarnPercent`（`ContextWarnSection.tsx:26-27`） | 不读。横幅随会话页删除。E2E 只守「设置项能保存」（`context-warn.spec.ts:1-2`） | T10.13 隐藏。见问题 4 |
| 工作台窗口上限 | `maxWorkbenchWindows`（`WorkbenchLimitSection.tsx:23`） | 读。主进程强制（`main/index.ts:245`、`handlers.ts:158`），工作台页也读（`WorkbenchPage.tsx:54`） | 保持不动 |
| 工作台默认权限 | `defaultWorkbenchPermission`（`WorkbenchDefaultPermissionSection.tsx:28-29`） | 读。新开窗口的初始档（`NewWindowDialog.tsx:77-78`） | 保持不动 |
| 工作台角色说明书 | 数据根下的覆盖稿（`WorkbenchRoleManualsSection.tsx:35`） | 读。启动时写进该窗口的角色提示（`handlers.ts:380-395`，`launch-cli.ts:361-364`） | 保持不动 |
| API 来源 | `providers.json` | 读。开 Claude / Codex 窗口要用来源和连法（`launch-cli.ts:279-332`） | 保持不动。中转路继续用它 |
| 档案 | `profiles.json` | 读。现在开 AI 窗口必须有档案 id（`launch-cli.ts:267-276`） | T10.12a 隐藏页面，并在同一批改成按配置启动。不能先藏页面、启动却还要档案 |
| 自定义角色 | `roles.json`（`RolesSection.tsx:22-50`） | 不进工作台。只给档案的「默认角色」下拉用（`ProfileEditorDialog.tsx:83-84`）。窗口角色是另一套说明书 | T10.12a 和档案一起藏。见问题 1 |
| 默认权限预设 | `defaultPermissionPreset`（`DefaultPermissionSection.tsx:35`） | 不进工作台。只给新建档案预填（`ProfileEditorDialog.tsx:88`）。自配置草案代码会补这个值（`mcp/config-tool.ts:500`），但该工具没有挂上窗口 | T10.12a 和档案一起藏。见问题 2。工作台用的是上面那项「工作台默认权限」 |
| 知识库工具接入 | 全局 `knowledgeTool`：命令、参数、环境、注册名（`KnowledgeToolSection.tsx:78-89`） | 读，但是条件读。项目开关打开时，启动才拿这份覆盖去挂知识库 MCP（`handlers.ts:371-373`，`launch-cli.ts:228-247`） | 保持不动 |
| 自配置工具开关 | 项目 `configToolEnabled`（`ConfigToolSection.tsx:31-33`） | 不读。开关会保存，启动不看它 | 先留着（说明已是实话）。去留见问题 7 |

#### 2. 项目 `.workbench/project.json` 的字段

本层认识的字段在 `packages/storage/src/projects/settings.ts:28-56`。未知键写回时保留（同文件 `142-149`），所以 T10.12a 加 `configId` 不会冲掉它们。

| 字段 | 谁在写 | 谁在读 | 工作台里对应什么 | 建议 |
| --- | --- | --- | --- | --- |
| `knowledgeToolEnabled` | 知识库页开关（`AgentToolPanel.tsx:33-35`） | 启动前判断（`handlers.ts:362-366`） | 打开才给该窗口挂上只读 `knowledge_search` | 保持不动 |
| `configToolEnabled` | 设置页自配置开关 | 没有运行时读者 | 没有。不会注册给 Agent | T10.14 再定，见问题 7 |
| `reviewerEnabled` | 没有界面。旧任务页已删。只剩 IPC 能写 | 没有读者 | 没有。工作台的「检查员」是开窗口时选的角色，不看这个开关 | 保持字段在磁盘上，程序继续不读。见问题 5 |
| `reviewerProfileId` | 同上，没有界面 | 没有读者 | 没有。它指向一条档案，不是窗口角色 | 不要迁进新配置，也不要在 T10.12a 做档案选择器 |

领域类型 `Project` 上还有 `roleBindings`、`outputLanguage`、`permissionPolicy`（`packages/shared/src/domain/project.ts:17-47`）。项目设置层不写这些键，工作台也不读。保持类型即可，不必在 T10.12a 填上。

#### 3. 记忆、习惯、知识库：窗口启动时接上什么

启动一个 Claude / Codex 窗口时，会放进这个进程的只有：

- 工作台 MCP（开窗口、汇报、记忆工具等），始终挂上（`launch-cli.ts:334-337`）。
- 角色说明书，按该窗口角色写入临时提示（见第 1 节）。
- 知识库 MCP：仅当该项目 `knowledgeToolEnabled` 为真（`launch-cli.ts:228-247`）。正文不预先塞进提示，模型自己调 `knowledge_search`。
- 来源环境变量和本次启动参数（模型、思考强度）。本机登录不塞密钥。

不会放进去的：

- 习惯。编译函数 `compileHabitProfile`（`packages/core/src/habit/compile.ts:42`）没有生产调用方，只有测试。
- AI 输出语言。
- 项目记忆正文。记忆不在开场提示里。
- 自配置 MCP。
- 旧自定义角色的提示词。
- 检查员档案。

记忆现在的接法是工具，不是注入：

- `ffpane_memory_search` 只查本项目，带回「已生效」和「待审核」，归档不回（`project-memory.ts:10-11`）。
- `ffpane_memory_add` 新写的一律是待审核（`mcp-tools.ts:800-805`）。角色说明书让管理者用这个工具（`resources/workbench-roles/base.md:14-15`、`manager.md:13`）。
- 记忆页仍可列出、通过、改、拒绝（`memory:list` / `approve` / `update` / `reject`）。

记忆候选还有没有来源：有一个活的，一个死的。

- 活的：窗口工具 `ffpane_memory_add`。这就是现在的候选来源。
- 死的：任务验收派生（`data.ts:544-572` 的 `tasks:accept`）。渲染层没有调用方。旧会话编排已不在磁盘上。

习惯建议还有没有来源：自动建议没有。记忆页仍可手写习惯、停用、删除（`HabitsPanel.tsx` 走 `habits:*`）。「反复纠正就生成候选」的 `observeCorrection`（`packages/core/src/habit/observe.ts:86`）没有生产调用方。

知识库页本身（导入、检索、复制引用、项目级开关）还连着。注释仍写「发送到当前会话」（`KnowledgePage.tsx:22`，`HitCard.tsx:26`），按钮已经没了。

#### 4. 主进程通道和领域类型

preload 只暴露通用 `invoke` / `subscribe`（`preload/index.ts:10`），不单独列通道。有没有人用，看渲染层和主进程里的调用，不看契约表上有没有名字。

渲染层没有任何调用、主进程也只在 handler 里实现的通道：

- `plans:list`（`data.ts:757`）、`plans:approve`（`data.ts:759`）
- `tasks:list`（`data.ts:531`）、`tasks:accept`（`data.ts:544`）、`tasks:cancel`（`data.ts:575`）、`tasks:set-reasoning-effort`（`data.ts:586`）
- `runs:list`（`data.ts:607`）
- `sessions:list`（`data.ts:722`）
- `handoff:generate`（`data.ts:727`）
- `workbench:remove-layout`（`data.ts:495`）。删项目走的是直接 `removeProject`（`data.ts:329`），不走这条通道

契约里有名字、主进程没有 handler、渲染层也不调用：

- `sessions:latest`、`sessions:transcript`、`sessions:active-turns`（`contracts.ts:1687-1697`）
- 事件 `tasks:settled`（`contracts.ts:1789`）

这些通道的建议：T10.13 删掉通道和契约。磁盘上的旧计划 / 任务 / 会话文件不删。

`Plan` / `Task` / `Run` / `Session` 类型还被谁用：不只是这些通道。存储层仍按这个形状读写旧文件（`packages/storage/src/records/plan.ts`、`task.ts`、`run.ts`、`sessions/store.ts`），core 里的计划 / 任务 / 交接模块也还引用它们。项目摘要的类型里仍留着四路读取（`project-summary.ts:41-45`），但汇总函数已经不再调用（`project-summary.ts:88-94`）；`data.ts:262-294` 仍把这四路函数装进对象，属于死接线。

建议：删通道，保留领域类型和存储读写。类型并不是「只被旧通道用」，删类型会连旧文件的读写代码一起拆掉，超出这次清理。任务状态徽章表 `TASK_STATUS_BADGE` 只剩测试在对（`badge.variants.ts:80-83`），可随旧文案一起删。

另外，`useRoleProfile` / `useDiscussionProfiles`（`hooks/useRoleProfile.ts:19-40`）没有任何引用。T10.13 删文件。

记忆、习惯、知识库、来源、档案、角色、工作台、终端这些通道都还有界面调用方，保持不动。

#### 5. 自配置工具在「配置取代档案」之后

现状：

- 设置开关只写 `configToolEnabled`，启动不读（见第 1、2 节）。
- 草案中枢 `createConfigDraftHub`（`config-draft-hub.ts:101`）只被测试调用，主进程启动不创建它。
- 工具改的是来源和档案（`mcp/config-tool.ts` 的 `config_draft_provider` / `config_draft_profile`），不是未来的「配置」。
- sidecar 仍会打进安装包（统一验收已核对 `config-mcp.js`），E2E 直接拉起这个脚本，不经过窗口。

T10.12a 不要改这套工具，也不要把它接进新配置。档案页藏起来之后，它更没有界面落点。去留见问题 7。

#### 6. 界面上 Claude、Codex 以外的 CLI 选项

工作台新开窗口只有终端 / Claude / Codex（`NewWindowDialog.tsx:160-165`）。`ffpane_open_window` 的 `cli` 也只有 `claude` 和 `codex`（`workbench-tools.ts:86`）。来源模板的适用 CLI 只有这两家（`provider-templates.ts:15`）。

还会出现的其它选项：

| 名字 | 出现在哪 |
| --- | --- |
| Gemini（`gemini-cli`） | 档案运行时下拉（`ProfileEditorDialog.tsx:50`）；来源「本机登录」探测运行时下拉（`contracts.ts:650`，界面 `ProviderEditorDialog.tsx:134-137`） |
| Grok（`grok-build`） | 同上，档案第 52 行；探测下拉 `contracts.ts:652` |
| OpenCode（`opencode`） | 档案第 51 行；探测下拉 `contracts.ts:651`。思考强度档也单独提它（`ProfileEditorDialog.tsx:164`） |
| Qwen（`qwen-code`） | 只有档案运行时下拉（`ProfileEditorDialog.tsx:54`） |
| iFlow（`iflow`） | 只有档案下拉（第 55 行） |
| Aider（`aider`） | 只有档案下拉（第 53 行） |
| 通用命令（`generic-exec`） | 只有档案下拉（第 56 行） |

选了这些档案也开不了工作台窗口：启动只接受 Claude / Codex（`launch-cli.ts:271-276`）。

T10.12a 的新配置界面只做 Claude 和 Codex 两路，不要把 `RUNTIME_OPTIONS` 抄进去。档案页藏起来后，Qwen / iFlow / Aider / 通用命令会一起从界面消失。来源页还在，所以 Gemini / OpenCode / Grok 仍会出现在「本机登录」探测下拉里，这件事按已确认的决定放到 T10.13 隐藏，代码保留。

#### 7. 藏起档案之后，谁会受影响

今天还依赖档案、T10.12a 必须在同一批改掉的：

- 新开窗口对话框的档案下拉，没有档案就不能开 AI 窗口（`NewWindowDialog.tsx:142-148`、`207-218`）。
- 重启 / 续接仍拿窗口上的 `profileId`（`WindowPane.tsx:564-567`）。窗口标题旁会显示档案名（`WindowPane.tsx:72-76`）。
- 管理者开子窗口：可传 `profileId`，不传就用本次运行里最近一条或第一条同 CLI 档案（`handlers.ts:756-772`，工具声明 `workbench-tools.ts:87-89`）。
- 启动真正用到的档案字段只有：运行时、来源 id、模型、思考强度、连法（`launch-cli.ts:267-332`）。档案上的默认角色、权限预设、输出语言不参与这次启动。

藏起档案页、但启动仍要档案：已有档案的项目还能开窗口，不能再新建或修改档案。所以隐藏必须和「改读配置」同一批做。

藏起之后就没有界面消费者、建议一起藏的：

- 自定义角色区（只服务于档案默认角色）。
- 默认权限预设（只预填新建档案）。
- `useRoleLabel` 只被档案列表使用（`ProfilesSection.tsx:24`）。

不要跟着藏、也不要改成读档案的：

- API 来源页。
- 工作台窗口上限、工作台默认权限、角色说明书。
- 知识库开关和知识库接入设置。
- 检查员档案 id：本来就没人读，不要在新配置里做「检查员用哪条档案」。

浏览器里的「上次档案」（`NewWindowDialog.tsx:33`）和主进程内存里的「最近档案」（`handlers.ts:265`、`404-405`）按 §8 在 T10.12a 退役。

#### 8. 其它断头

- 项目摘要仍装了计划 / 任务 / Run / 会话四路读取，汇总时不用（见第 4 节）。卡片上的数字保持 0。T10.13 删掉这四路死接线。
- 知识库页注释和 `HitCard` 注释仍写发送到会话（见第 3 节）。T10.13 改掉，并删已下线页面的语言包（验收第 5 节已列清单）。
- 导航注释仍写「七个页面」（`layout/nav.ts:13-16`）。实际侧栏是项目、工作台、记忆、知识库。T10.13 改注释即可。
- 习惯「停用后不参与提示组装」写在通道注释里（`contracts.ts:1670`），组装已经没有生产调用方。手写习惯管理可以留着，等第 6 个问题决定要不要接回提示。
- 自配置 sidecar、草案中枢、`session/config-tool.ts` 是一套没有挂到窗口的实现。不要在 T10.12a 删，免得和问题 7 的决定打架。

### 分类清单

**T10.12a 先处理（和档案绑在一起，不先做会让新界面或隐藏步骤做错）**

1. 隐藏档案页，并且同一批把开窗口、`ffpane_open_window`、重启 / 续接改成读项目配置。不要单独先藏档案。
2. 新配置界面只列 Claude、Codex。不要复用档案那份九项运行时下拉。
3. 建议同时藏「自定义角色」和「默认权限预设」（等 Tony 点头，见问题 1、2）。磁盘上的 `roles.json`、`profiles.json` 不删。
4. 不要读、不要迁移 `reviewerProfileId`。不要把自配置工具改去起草配置。
5. `project.json` 只追加可选 `configId`。知识库开关、自配置开关、检查员字段原样留着。

**T10.13 清理**

1. 已下线页面的语言包，以及知识库注释里的「发送到当前会话」（计划 §9.1 已列）。导航「七个页面」的过时注释一起改。
2. README「软件不再读取旧文件」改准（计划 §9.1 第 2 条）。
3. 删除没有调用方的通道和契约：`plans:list`、`plans:approve`、`tasks:list`、`tasks:accept`、`tasks:cancel`、`tasks:set-reasoning-effort`、`runs:list`、`sessions:list`、`handoff:generate`、`workbench:remove-layout`，以及只有契约没有 handler 的 `sessions:latest`、`sessions:transcript`、`sessions:active-turns`、`tasks:settled`。领域类型和存储层保留。删项目摘要里没人调用的四路读取。删无人引用的 `useRoleProfile.ts`。
4. 隐藏「AI 输出语言」和「上下文阈值」。值可以继续留在 `config.json`，避免旧文件读入失败。对应 E2E 从「必须看得见」改成「页面上没有这项」。
5. 来源页「本机登录」探测下拉里的 Gemini / OpenCode / Grok 隐藏，代码保留。档案页若已在 T10.12a 整页隐藏，Qwen / iFlow / Aider / 通用命令不必再单 unique 处理。
6. 任务状态徽章若已无页面使用，随旧 `tasks.*` 文案删除。

**T10.14 串联（候选，等 Tony 逐条定）**

1. 自配置工具：改成起草「配置」并只进管理者窗口，或下线。推荐下线（问题 7）。
2. 习惯：把已通过且启用的习惯写进该窗口的角色提示。自动纠正建议不要接回来。
3. 知识库：发到某个窗口的收件箱，加固定模板提醒，正文不进终端。
4. 检查员：不要把旧的档案 id 接回来。开窗口时选检查员角色已经是工作台里的对应物。
5. 记忆候选：保持窗口工具这条来源。不要把 `tasks:accept` 接回来。
6. 上下文用量：推荐不接。Claude / Codex 自己会显示，本软件没有可靠用量信号。

**保持不动**

外观、界面语言、窗口上限、工作台默认权限、角色说明书、API 来源、知识库页和项目级知识库开关、知识库接入覆盖、记忆页的审核、工作台记忆工具。

### 需 Tony 决定的问题

1. 设置里的「自定义角色」要不要和档案一起藏？推荐：T10.12a 一起藏。它只给档案的默认角色用，和工作台窗口角色不是一套，留着像是还能设计窗口角色。
2. 「默认权限预设」（新建档案时预填的那套旧权限）要不要一起藏？推荐：T10.12a 一起藏。开窗口用的是另一项「工作台默认权限」，藏这项不影响工作台。
3. 「AI 输出语言」现在没有窗口在读。只藏起来，还是以后写进窗口提示？推荐：T10.13 先藏，T10.14 不自动接上。真要接，也只写进该窗口的角色提示，不改本机 CLI 的全局设置。
4. 工作台要不要做「上下文快满了」的提醒？推荐：不做。T10.13 把设置项藏起来。用量让 CLI 自己显示。
5. 项目里还要不要「这个项目必须开检查员」这种开关？推荐：不要。开窗口时选检查员就够了。磁盘上的旧开关和旧档案 id 留着，程序继续不读。
6. 开窗口时要不要自动带上习惯？推荐：要，放在 T10.14。只带你已经点过通过、并且还开着的习惯，写进该窗口的角色提示。不要恢复「看你怎么纠正 AI、自动生成习惯候选」。
7. 自配置工具是改成让管理者起草「配置」，还是下线？推荐：下线。一张配置就是 Claude 一条路、Codex 一条路，手改更清楚；现在的工具改的是档案，不是配置。若要留，必须改成起草配置、只给管理者、仍要你点确认才保存。
8. 知识库要不要「发到某个窗口」？推荐：T10.14 做。只放进那个窗口的收件箱，再提示一句固定的话。正文不写进终端。
9. 任务验收自动产生记忆候选，还要不要？推荐：不要。窗口工具已经会写出待审核条目，你在记忆页点通过才生效。验收那条通道在 T10.13 删掉。

### 改动文件

- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- 未跑 lint / typecheck / 测试。未启动应用，未调用模型。
- `Get-Date -Format "yyyy-MM-dd HH:mm"` → `2026-10-01 14:03`，用于本条标题。
- `Test-Path`：`session/index.ts`、`orchestrator.ts`、会话页、任务页为 MISSING；`session/env.ts`、`knowledge-tool.ts`、`quit.ts`、`config-tool.ts`、`config-draft-hub.ts` 为 EXISTS。
- 磁盘 `rg`（排除 `node_modules` 与 `dist`）核对设置字段、项目字段、IPC 通道、运行时下拉和档案引用。未读用户数据目录。

### 相关文件链接

- [Phase 10 计划 §7.3、§7.4、§8、§9](../Phase10-多窗口终端工作台计划.md)
- [Phase 10 统一验收 §2、§5](../验收记录/Phase10-统一验收.md)
- 设置页：`apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx`
- 项目设置：`packages/storage/src/projects/settings.ts`
- 启动：`apps/desktop/src/main/workbench/launch-cli.ts`、`handlers.ts`
- 通道：`apps/desktop/src/main/data.ts`、`apps/desktop/src/shared-ipc/contracts.ts`
- 上一则配置调研：[2026-10-01 13:42 · Phase10 · T10.12 · 调研 · 项目配置现状](./Phase10-对话总记录.md)

## 2026-10-01 14:37 · T10.12a · 执行 · 项目配置

### 任务要点

按计划 §8、§9.5、§9.6 第 1 条和 §7.3、§7.4，只做 T10.12a。全局 `configs.json`：名称、是否默认、可用项目范围（空 = 所有项目）、可选默认权限（工作台四档）、Claude / Codex 各一路（连法、中转来源 id、可选模型、可选思考强度），可以只配一路。首次自动生成两边本机登录的默认配置。设置页管理配置，并同一批隐藏「档案」「自定义角色」「默认权限预设」；「API 来源」保留。项目 `project.json` 只追加可选 `configId`。新开窗口、`ffpane_open_window`、重启 / 续接改读项目配置。窗口只读显示路、模型、思考强度。不改自配置工具，不迁旧档案，不提交。

### 结论

项目配置已接上工作台主流程。没有档案时，默认配置可以开 Claude 和 Codex。配置只配一路时，另一路在对话框和 `ffpane_open_window` 里都会明确失败。收窄范围时，名单外仍绑定的项目会拦住保存。已开窗口不热改；重启 / 续接按当时的项目配置重读。本机登录不注入密钥和网址，不设 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。未提交。

### 改动文件

- 领域与存储：`packages/shared/src/domain/project-config.ts`、`common.ts`、`workbench.ts`、`index.ts`；`packages/storage/src/project-configs/`；`packages/storage/src/fs/layout.ts`；`packages/storage/src/projects/settings.ts`；`packages/storage/src/workbench/store.ts`；`packages/storage/src/index.ts`
- 主进程：`apps/desktop/src/main/data.ts`；`apps/desktop/src/main/workbench/resolve-config.ts`、`launch-cli.ts`、`handlers.ts`、`open-child.ts`、`mcp-tools.ts`；`apps/desktop/src/mcp/workbench-tools.ts`；`apps/desktop/src/shared-ipc/contracts.ts`
- 界面：`apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx`、`pages/settings/configs/`；`pages/workbench/NewWindowDialog.tsx`、`WorkbenchPage.tsx`、`WindowPane.tsx`、`TerminalView.tsx`；`pages/projects/CreateProjectDialog.tsx`、`ProjectCard.tsx`；`stores/workbench.ts`；`locales/zh-CN.json`、`locales/en-US.json`
- 测试：`packages/storage/tests/project-configs.test.ts`、`project-settings.test.ts`、`fs.test.ts`；`apps/desktop/tests/project-config.test.ts`、`workbench-launch-role.test.ts`、`workbench-mcp.test.ts`；`apps/desktop/tests/e2e/project-config.spec.ts` 以及受影响的 `workbench-cli.spec.ts`、`workbench-mcp.spec.ts`、`custom-role.spec.ts`、`profile-provider-freshness.spec.ts`、`role-template.spec.ts`、`generic-exec-profile.spec.ts`、`reasoning-effort.spec.ts`

### 命令结果

- `pnpm lint`：通过（biome 747 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/shared build` 与 `pnpm --filter @ff-pane/storage build`：通过。给 desktop typecheck 和 e2e 用；`dist/` 在 gitignore 里。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过（node、web、e2e 三份 tsconfig）。
- 相关单测 `vitest run`（配置存储、项目设置、布局路径、工作台布局、选路、启动角色、MCP 开窗、契约、CLI 参数）：9 个文件、96 个测试通过。选路单测在改完类型后又跑了一次，2 个测试通过。
- 受影响 e2e：`electron-vite build` 后跑 21 个。20 个通过。`没有档案时默认配置能开 Claude 和 Codex` 第一次失败，是因为第二个窗口在另一个标签里，断言去找第二个 `workbench-window-route`。产品行为已经是本机登录（第一个窗口的断言过了）。改成按窗口种类断言后，单条复跑通过（4.3s）。其余 20 条未因该测试改动而重跑。

### 问题与遗留

- 未做 T10.12b、T10.13、T10.14。自配置工具（config MCP、`config-tool.ts`、`config-draft-hub.ts`）未改。
- `profiles.json`、`roles.json` 不删不迁。设置页不再渲染档案、自定义角色、旧默认权限预设。开窗口不再读档案。
- `reviewerEnabled` / `reviewerProfileId` 仍原样留在 `project.json`，程序不读。
- 窗口上的路、模型、思考强度是本次启动写回的快照。启动成功前显示「尚未记录」。已开着的进程不热改。
- 旧布局里的 `profileId` 还能读出来，但不再当作启动依据。对话框「上次档案」和主进程「最近档案」已去掉。
- 删来源时，除档案外也会看配置的中转路是否还引用它。
- Claude 本机登录没有模型枚举途径（原有通道会回 unsupported）。配置里仍可手打，或从中转来源已有模型列表里选。留空 = CLI 默认。
- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。
- 不需要主控决策。

### 相关文件链接

- [Phase 10 计划 §8、§9.5、§9.6、§7.3、§7.4](../Phase10-多窗口终端工作台计划.md)
- 调研：[2026-10-01 13:42 · Phase10 · T10.12 · 调研 · 项目配置现状](./Phase10-对话总记录.md)
- 审计：[2026-10-01 14:03 · Phase10 · T10.12-0 · 调研 · 串联审计](./Phase10-对话总记录.md)
- 选路：`apps/desktop/src/main/workbench/resolve-config.ts`、`launch-cli.ts`
- 设置页：`apps/desktop/src/renderer/src/pages/settings/configs/ConfigsSection.tsx`
- e2e：`apps/desktop/tests/e2e/project-config.spec.ts`

## 2026-10-01 14:59 · T10.12a · 检查 · 项目配置

### 任务要点

独立检查未提交的 T10.12a。对照计划 §8、§9.5、§9.6 第 1 条、§4.1、§7.3、§7.4，以及总记录「2026-10-01 14:37 · T10.12a · 执行 · 项目配置」。审查 diff 与代码，做反向探针，首验完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。

### 结论

**有条件通过，2 项必须修。** 项目配置已接上开窗口、MCP、重启 / 续接和设置页；隐藏档案、自定义角色、旧默认权限预设符合范围；没有越界改自配置工具、旧档案文件、检查员字段或 T10.12b。必须先修：收窄后的默认配置仍会被名单外项目用上；`projects:update-settings` 允许名单外项目绑上被收窄的配置，随后那张配置无法再保存。需要主控定第 1 项的修法（默认配置也能收窄并真正拦住，或默认配置不提供范围勾选）。

### 改动文件

- 新增验收记录：`docs/验收记录/T10.12a-验收.md`
- 本条追加：`docs/对话记录/Phase10-对话总记录.md`
- 未改实现代码。反向探针用过的临时测试已删除，未入库。

### 命令结果

- `pnpm lint`：通过（Biome 747 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：**2392 过 / 1 跳过**（137 个文件）。首跑即过。
- `pnpm smoke`：**11 项 ALL PASS**。应用信息 FF-pane v0.10.12。pdfjs 缺 canvas 的警告在 PASS 之前，不记失败。
- `pnpm test:e2e`：**48 过**（约 4.8 分钟）。

### 问题与遗留

- 必须修 1：`selectEffectiveProjectConfig` 回落到默认配置时不看范围。探针用 `configs:update` 把默认配置收成只含项目甲，项目乙仍开出这张配置上的模型。
- 必须修 2：`projects:update-settings` 不校验范围。探针里项目乙绑上「只给甲」的配置并写入成功；之后保存那张配置会被拦住并点名乙。`projects:create` 会拒绝收窄配置。MCP 不能改绑定。
- 其余反向探针通过：旧 `profileId` 不按档案走；只配一路时对话框、MCP、重启 / 续接都拒绝另一路；本机登录不注入密钥和网址，不设 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`；子窗口权限仍封顶；被配置引用的来源删不掉；没有写 `~/.claude`、`~/.codex`。
- 被改的 7 个旧 e2e 是随入口隐藏而替换，工作台启动、续接、越权、封顶仍在。e2e 48 条 = 原 45 条加 3 条新的项目配置。
- 未做打包冒烟。这次不改原生模块。
- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。

### 相关文件链接

- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)
- [Phase 10 计划 §8、§9.5、§9.6](../Phase10-多窗口终端工作台计划.md)
- 执行：[2026-10-01 14:37 · T10.12a · 执行 · 项目配置](./Phase10-对话总记录.md)
- 选路：`packages/shared/src/domain/project-config.ts`、`apps/desktop/src/main/workbench/resolve-config.ts`
- 绑定：`apps/desktop/src/main/data.ts`（`projects:update-settings`、`configs:update`）

## 2026-10-01 15:14 · T10.12a · 修复 · 项目配置

### 任务要点

按验收必须修和计划 §9.8 修两处范围漏洞。默认配置永远对所有项目开放：设置页不给默认配置勾范围，存储层拒绝给默认配置写范围，设为默认（含删除默认时指定新默认）时界面先提示「设为默认后所有项目都能用」，确认后清空范围，主进程同样清空。`projects:update-settings` 拒绝名单外的 `configId`。补上建议里的单测和一条权限初值 e2e。不提交。

### 结论

两处必须修已按「默认配置全局使用」落地。非默认配置的范围，以及「名单外仍绑定就不许收窄」，没有改。未提交。

### 改动文件

- 选路与存储：`packages/shared/src/domain/project-config.ts`、`packages/storage/src/project-configs/store.ts`、`packages/storage/tests/project-configs.test.ts`
- 主进程绑定：`apps/desktop/src/main/data.ts`、`apps/desktop/tests/project-config-bind.test.ts`、`apps/desktop/tests/project-config.test.ts`
- 界面与文案：`apps/desktop/src/renderer/src/pages/settings/configs/ConfigsSection.tsx`、`ConfigEditorDialog.tsx`、`pages/projects/ProjectCard.tsx`、`CreateProjectDialog.tsx`、`locales/zh-CN.json`、`locales/en-US.json`
- e2e：`apps/desktop/tests/e2e/project-config.spec.ts`
- 本条追加：`docs/对话记录/Phase10-对话总记录.md`

### 命令结果

- `pnpm lint`：通过（Biome 748 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- 相关单测：`project-configs.test.ts`、`project-config.test.ts`、`project-config-bind.test.ts` 共 9 项通过。
- 受影响 e2e：`project-config.spec.ts` 4 项、`reasoning-effort.spec.ts` 1 项，共 5 项通过。

### 问题与遗留

- 建议第 3 条（布局里的旧 `profileId`）未做，留给后面的清理。
- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。
- 不需要主控决策。

### 相关文件链接

- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)
- [计划 §9.8](../Phase10-多窗口终端工作台计划.md)
- 检查：[2026-10-01 14:59 · T10.12a · 检查 · 项目配置](./Phase10-对话总记录.md)

## 2026-10-01 15:22 · T10.12a · 复验 · 项目配置

### 任务要点

复验 T10.12a 两项必须修是否按计划 §9.8 落地。重跑收窄默认配置和名单外 IPC 绑定，并补探针：有范围的配置设为默认后名单外能否使用、范围是否清空；直接给默认配置写范围是否被拒。最后一轮完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现。

### 结论

**有条件通过。** 产品行为按 §9.8 落地，反向探针通过。desktop typecheck 未过：`project-config-bind.test.ts` 里 `configs:list()` 少传了类型为 `undefined` 的那个参数。没有新的产品决定。

### 改动文件

- 追加复验：`docs/验收记录/T10.12a-验收.md`
- 本条追加：`docs/对话记录/Phase10-对话总记录.md`
- 未改实现。复验探针已删除，未入库。

### 命令结果

- `pnpm lint`：通过（Biome 748 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：未过。`tests/project-config-bind.test.ts(40,11)` Expected 1 arguments, but got 0。
- `pnpm test`：**2394 过 / 1 跳过**（138 个文件）。
- `pnpm smoke`：**11 项 ALL PASS**。应用信息 FF-pane v0.10.12。
- `pnpm test:e2e`：**49 过**（约 5.0 分钟）。一条清理临时目录时 EPERM，用例仍通过。

### 问题与遗留

- 必须再改一处测试调用：`handlers["configs:list"]()` 改成 `handlers["configs:list"](undefined)`，然后 desktop typecheck 应能过。运行时这条单测已经通过。
- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。

### 相关文件链接

- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)
- [计划 §9.8](../Phase10-多窗口终端工作台计划.md)
- 修复：[2026-10-01 15:14 · T10.12a · 修复 · 项目配置](./Phase10-对话总记录.md)

## 2026-10-01 15:25 · T10.12a · 修复 · 测试类型

### 任务要点

复验指出 `apps/desktop/tests/project-config-bind.test.ts` 里 `configs:list()` 少传参数。按契约改成 `handlers["configs:list"](undefined)`。不改实现，不提交。

### 结论

类型错误已去掉。desktop typecheck、lint、这条单测都通过。未提交。

### 改动文件

- `apps/desktop/tests/project-config-bind.test.ts`
- 本条追加：`docs/对话记录/Phase10-对话总记录.md`

### 命令结果

- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm lint`：通过（Biome 748 个文件，check-i18n PASS）。
- `vitest run apps/desktop/tests/project-config-bind.test.ts`：1 项通过。

### 问题与遗留

- 未提交。未改实现代码，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。
- 不需要主控决策。

### 相关文件链接

- 复验：[2026-10-01 15:22 · T10.12a · 复验 · 项目配置](./Phase10-对话总记录.md)
- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)

## 2026-10-01 15:36 · T10.12a · 复验 · 终验

### 任务要点

确认「测试类型」那一笔只改了测试调用，没有改实现。重跑 desktop typecheck、lint、`project-config-bind` 单测。整套 test / smoke / e2e 上一轮已过，本轮不重跑。

### 结论

**通过。** 第 40 行已是 `handlers["configs:list"](undefined)`。15:24 之后实现目录没有新改动。三条命令都过。不需要主控再定。

### 改动文件

- 追加终验：`docs/验收记录/T10.12a-验收.md`
- 本条追加：`docs/对话记录/Phase10-对话总记录.md`
- 未改实现，未改测试。

### 命令结果

- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm lint`：通过（Biome 748 个文件，check-i18n PASS）。
- `vitest run apps/desktop/tests/project-config-bind.test.ts`：1 项通过。

### 问题与遗留

- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。
- 不需要主控决策。

### 相关文件链接

- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)
- 测试类型：[2026-10-01 15:25 · T10.12a · 修复 · 测试类型](./Phase10-对话总记录.md)

## 2026-10-01 15:42 · T10.12a · 提交 · v0.10.13

### 任务要点

按计划 §7.2 第 4 步提交 T10.12a。版本 `0.10.12` → `0.10.13`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.12a 已验收，并记下遗留建议；Phase 10 统一验收那 10 条决定标为 Tony 已全部同意（2026-10-01）。计划 §4、§9、§7.5 同步。轻量 tag `v0.10.13`，不 push。

### 结论

已提交并打轻量 tag `v0.10.13`，未 push。终验通过的项目配置、验收记录和进度文档在同一笔提交。不需要主控决策。下一步 T10.12b。

### 改动文件

暂存并提交（不含 `apps/desktop/scripts/real-config-probe.mjs`，不含 `apps/desktop/out`）：

- `package.json`
- `apps/desktop/package.json`
- `README.md`
- `apps/desktop/tests/client-server.test.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `apps/desktop/src/main/data.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/main/workbench/launch-cli.ts`
- `apps/desktop/src/main/workbench/mcp-tools.ts`
- `apps/desktop/src/main/workbench/open-child.ts`
- `apps/desktop/src/main/workbench/resolve-config.ts`
- `apps/desktop/src/mcp/workbench-tools.ts`
- `apps/desktop/src/renderer/src/pages/projects/CreateProjectDialog.tsx`
- `apps/desktop/src/renderer/src/pages/projects/ProjectCard.tsx`
- `apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx`
- `apps/desktop/src/renderer/src/pages/settings/configs/`
- `apps/desktop/src/renderer/src/pages/workbench/NewWindowDialog.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/TerminalView.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/WindowPane.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/WorkbenchPage.tsx`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/tests/e2e/custom-role.spec.ts`
- `apps/desktop/tests/e2e/generic-exec-profile.spec.ts`
- `apps/desktop/tests/e2e/profile-provider-freshness.spec.ts`
- `apps/desktop/tests/e2e/project-config.spec.ts`
- `apps/desktop/tests/e2e/reasoning-effort.spec.ts`
- `apps/desktop/tests/e2e/role-template.spec.ts`
- `apps/desktop/tests/e2e/workbench-cli.spec.ts`
- `apps/desktop/tests/e2e/workbench-mcp.spec.ts`
- `apps/desktop/tests/project-config-bind.test.ts`
- `apps/desktop/tests/project-config.test.ts`
- `apps/desktop/tests/workbench-launch-role.test.ts`
- `apps/desktop/tests/workbench-mcp.test.ts`
- `locales/zh-CN.json`
- `locales/en-US.json`
- `packages/shared/src/domain/common.ts`
- `packages/shared/src/domain/index.ts`
- `packages/shared/src/domain/project-config.ts`
- `packages/shared/src/domain/workbench.ts`
- `packages/storage/src/fs/layout.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/project-configs/`
- `packages/storage/src/projects/settings.ts`
- `packages/storage/src/workbench/store.ts`
- `packages/storage/tests/fs.test.ts`
- `packages/storage/tests/project-configs.test.ts`
- `packages/storage/tests/project-settings.test.ts`
- `docs/Phase10-多窗口终端工作台计划.md`
- `docs/开发进度.md`
- `docs/验收记录/T10.12a-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`

### 命令结果

- `pnpm lint`：通过（Biome 748 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/command-ipc.test.ts apps/desktop/tests/client-server.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.12a 项目配置`
- 轻量 tag `v0.10.13`，未 push
- 提交哈希：`397e91da5b37e9130fb46c1a8253cc94bef1ea29`

### 问题与遗留

验收遗留仍是：布局里的旧 `profileId` 启动已不读，留给后面清理。历史记录里的 `0.10.12` 没有改。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。上面的提交哈希是 tag `v0.10.13` 所指的那一笔；这一行是后补的，所以 tag 里的本条仍写着上一笔已被替换的哈希。

### 相关文件链接

- [T10.12a 验收记录](../验收记录/T10.12a-验收.md)
- [开发进度](../开发进度.md)
- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)

## 2026-10-01 15:52 · T10.12b · 调研 · 改模型强度

### 任务要点

按计划 §8 第二轮决定 3、4、7 和 T10.12b 拆分，先查本机 Claude Code、Codex CLI 在交互会话里能否用一条输入切完模型和思考强度，且不弹出要方向键选择的菜单。只看 `--help`、官方文档、`docs/adapters/claude-code.md`、`docs/adapters/codex.md`。不调用模型，不写代码。顺带查有没有只对本窗口生效、不碰用户全局设置的热加载。任一做不到就停下，不改成重启后生效。

### 调研结论

#### Claude Code（本机 2.1.220）

启动参数能各带一个值，但是启动时的，不是会话中途的一条输入。`claude --help`：`--model <model>`（别名如 `fable` / `opus` / `sonnet`，或全名）、`--effort <level>`（`low`、`medium`、`high`、`xhigh`、`max`）。适配器文档 §1.2、§11 只记这两条启动参数，没有会话中的斜杠命令。

会话中的官方命令是两条，不是一条（[Commands](https://code.claude.com/docs/en/commands)，[Model configuration](https://code.claude.com/docs/en/model-config)）：

- 模型：`/model <别名或全名>`。带参数不打开选择器，文档写「立即切换」。不带参数才开选择器。自 v2.1.153 起，直接打 `/model <名>` 等于在选择器里按 Enter：切换，并把 `model` 写进用户设置，作为以后新会话的默认。只对本会话、不写设置的做法是在选择器里按 `s`，那是菜单。已有输出时，选择器还会再要一次确认（下一次回答会不带缓存重读历史）；带参数那条是否也弹这下确认，两页措辞不一致，不能当成一定没有弹窗。
- 强度：`/effort <low|medium|high|xhigh|max|ultracode>` 或 `/effort auto`。带档位不打开滑条，不等当前回答结束就生效。不带参数打开方向键滑条。交互会话里 `low` / `medium` / `high` / `xhigh` 会跨会话保存；只有 `max` 和 `ultracode` 只对当前会话。`-p` 非交互里的 `/effort` 才是只对本次、不保存，工作台窗口不是这条路径。

模型和强度不能一条切完。官方「一次切完」的例子仍是两行：`/model opus`，然后 `/effort xhigh`。要在同一次操作里调强度，得在 `/model` 选择器里用左右键，那是菜单。`/config key=value`（v2.1.181 起可多对、不打开设置界面）写的是用户设置，不是本窗口临时值。

没有「本窗口专属临时设置、运行中再读一次」的文档。`--settings`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL` 都是启动时读。`/reload-plugins`、`/reload-skills` 不重读模型和强度。自定义模型环境变量的文档写明要重启会话才吃到。

#### Codex CLI（本机 0.159.2）

`codex --help` 只有启动参数：`-m, --model <MODEL>`，以及 `-c, --config <key=value>`（值按 TOML 解析，例子是 `-c model="o3"`）。没有交互会话里的一条切换命令。适配器文档记的是启动时 `-m` 和 `-c model_reasoning_effort="<档>"`（调研版本 0.147.0 / 0.153.4）；本机帮助仍是这个形状，没有新增一条输入的子命令。

官方斜杠命令（[Slash commands](https://developers.openai.com/codex/cli/slash-commands)，页面未标对应 0.159.2）里，`/model` 没有参数位。规定步骤是：输入 `/model` 回车，再从弹窗里选模型；有推理强度时也在这个弹窗里一起选。模型和强度是在菜单里一起定的，不能用一条文字写完。同页里 `/fast on|off`、`/plan <提示>` 有行内参数，`/model` 没有。

`-c` 是本次启动覆盖，官方说明不改 `~/.codex/config.toml`。运行中的 TUI 没有「重新读取一份本窗口临时配置」的命令。`/debug-config` 只打印。`/statusline`、`/theme`、`/keymap` 会把选择写进用户 `config.toml`。

### 结论

两家都做不到。停下，不实现 `ffpane_set_model_effort`，也不改成重启后生效。

Claude 不能一条切完模型和强度；带参数的 `/model`、以及 `low`–`xhigh` 的 `/effort`，还会写入用户全局设置。Codex 的 `/model` 必须弹窗用方向键选，没有一条文字同时写上模型和强度。两边都没有「只对本窗口、不碰用户全局、运行中热加载」的设置文件。

可交给主控选的替代（本次都没做）：

1. 仍用现在的启动参数，重启或续接才生效。Claude `--model` 加 `--effort`，Codex `-m` 加 `-c model_reasoning_effort="档"`。这两条不写用户全局设置。这就是计划不准自行改成的「重启后生效」。
2. Claude 分两行写 `/model <名>` 和 `/effort <档>`。不弹选择器，但常用档会改用户以后新会话的默认。
3. Claude 在 `/model` 选择器里按 `s`，只对本会话，但是菜单，软件写不进固定模板。
4. Codex 继续用 `/model` 弹窗，人和方向键选模型和强度。软件不能一条写完。

### 改动文件

- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- `claude --version` → `2.1.220 (Claude Code)`
- `codex --version` → `codex-cli 0.159.2`
- `claude --help`、`codex --help`：只看到上面的启动参数，没有会话中一条切完的命令
- 未启动交互会话，未调用模型，未跑 lint / typecheck / 测试
- `Get-Date -Format "yyyy-MM-dd HH:mm"` → `2026-10-01 15:52`

### 问题与遗留

需要主控定：接受「重启 / 续接才生效」，还是接受 Claude 两条斜杠命令（会改用户全局默认），还是先不做立即切换。在此之前不写实现。

Claude 带参数的 `/model` 在已有对话时会不会再要一次确认，官方两页措辞不一致，本次没有开会话去试。

### 相关文件链接

- [Phase 10 计划 §8、§3.2.1、§7.3、§7.4](../Phase10-多窗口终端工作台计划.md)
- [Claude Code Commands](https://code.claude.com/docs/en/commands)
- [Claude Code Model configuration](https://code.claude.com/docs/en/model-config)
- [Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)
- 适配器：`docs/adapters/claude-code.md`、`docs/adapters/codex.md`
- 上一则：[2026-10-01 13:42 · Phase10 · T10.12 · 调研 · 项目配置现状](./Phase10-对话总记录.md)

## 2026-10-01 16:14 · T10.12b · 执行 · 改模型强度

### 任务要点

按计划 §9.9 实现管理者改窗口的模型和思考强度。覆盖记在窗口布局上，优先级是窗口覆盖、项目配置这一路、都没有就不传。新工具 `ffpane_set_model_effort`：已授权管理者可改自己，以及自己后代里的写计划、工作者、检查员、普通窗口；不能改别的管理者。空闲时自动续接重启并带上新启动参数；忙则排队，同一窗口新请求覆盖旧请求。管理者窗口和全放开窗口不自动重启，沿用现有确认框，用户点确认才续接。无法续接（例如还没有原生会话 id）不硬重启，标待生效。续接失败显示原因，不自动重试。不往 PTY 写切换命令，不改用户全局 CLI 设置。不提交。

### 调研结论

#### Claude Code

沿用上一则（2026-10-01 15:52）。本机 2.1.220 不能一条输入切完模型和强度还不弹菜单，带参数的斜杠命令还会写用户设置。本步不走那条路。

#### Codex CLI

沿用上一则。本机 0.159.2 的 `/model` 要弹窗选择。本步不走那条路。

### 结论

已按 §9.9 实现，未提交。空闲的工作者窗口会自动续接，启动参数带上新强度；管理者改自己会先出现确认框，点确认后才续接。不需要主控再定做法。

模型白名单：去掉首尾空白后不能为空，不能含换行或其它控制字符，最多 128 个字符；只允许字母、数字和 `.` `_` `:` `@` `/` `-`，末尾可以有 `[1m]` 这类后缀。思考强度只用既有档位 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。

### 改动文件

- `packages/shared/src/domain/workbench.ts`、`model-override.ts`、`index.ts`
- `packages/storage/src/workbench/store.ts`
- `apps/desktop/src/main/data.ts`、`index.ts`
- `apps/desktop/src/main/workbench/model-effort.ts`、`handlers.ts`、`mcp-tools.ts`
- `apps/desktop/src/mcp/workbench-tools.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `apps/desktop/src/renderer/src/pages/workbench/WindowPane.tsx`、`TerminalView.tsx`
- `apps/desktop/resources/workbench-roles/manager.md`
- `locales/zh-CN.json`、`locales/en-US.json`
- `docs/Phase10-多窗口终端工作台计划.md`（§3.2.1、§8 的 T10.12b 条目改成指向 §9.9）
- `apps/desktop/tests/model-effort.test.ts`、`workbench-mcp.test.ts`、`workbench-memory.test.ts`
- `packages/shared/tests/model-override.test.ts`
- `apps/desktop/tests/e2e/model-effort.spec.ts`、`fake-workbench-cli.js`
- `docs/对话记录/Phase10-对话总记录.md`（本条）

### 命令结果

- `pnpm lint`：通过（Biome 753 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run` 模型覆盖、权限队列、以及工作台 MCP / 记忆单测：4 个文件，40 过。
- `playwright test tests/e2e/model-effort.spec.ts`：2 过（工作者自动续接 20.1s，管理者确认后续接 13.7s）。

### 问题与遗留

未提交。窗口里如果有人再手动改模型，这里的显示仍是上次启动参数，软件不知道。续接失败的原因来自启动错误原文。

### 相关文件链接

- [Phase 10 计划 §9.9、§3.2.1、§7.4](../Phase10-多窗口终端工作台计划.md)
- 调研：[2026-10-01 15:52 · T10.12b · 调研 · 改模型强度](./Phase10-对话总记录.md)
- 角色说明：`apps/desktop/resources/workbench-roles/manager.md`

## 2026-10-01 16:35 · T10.12b · 检查 · 改模型强度

### 任务要点

独立检查未提交的 T10.12b。对照计划 §9.9、§8 第二轮决定 4、§3.2.1、§4.1、§7.3、§7.4，以及总记录里的调研和执行条目。审查 diff 与代码，做反向探针，首验完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。

### 结论

**有条件通过，1 项必须修。** 覆盖字段、空闲才续接、忙时只留最后一次、管理者和全放开要确认、无法续接和失败都不硬重启、非法覆盖读入即丢、不往终端写切换命令，这些都在。必须先修：窗口已经空闲时连续两次请求会各发一次续接；后一次若撞上第一次还在启动，会被重入闩丢掉，最后的值不一定进这一次启动参数。没有需要主控另选产品方案。

### 改动文件

- 新增验收记录：`docs/验收记录/T10.12b-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）
- 反向探针测试跑完已删，未入库

### 命令结果

- `pnpm lint`：通过（Biome 753 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：2405 过 / 1 跳过（140 个文件）。
- `pnpm smoke`：11 项 ALL PASS。版本 v0.10.13。
- `pnpm test:e2e`：51 过（约 4.9 分钟）。
- 反向探针：`vitest run apps/desktop/tests/t1012b-probe.test.ts` 3 过，随后删除该文件。

### 问题与遗留

必须修见验收记录。建议不阻断：待生效文案没写出新的模型和强度；§8 决定 3 的旧句子还在；清洗锁不阻止已授权管理者改那个后代窗口的强度。

### 相关文件链接

- [T10.12b 验收记录](../验收记录/T10.12b-验收.md)
- [Phase 10 计划 §9.9](../Phase10-多窗口终端工作台计划.md)
- 执行：[2026-10-01 16:14 · T10.12b · 执行 · 改模型强度](./Phase10-对话总记录.md)

## 2026-10-01 16:42 · T10.12b · 修复 · 改模型强度

### 任务要点

按验收必须修和 §9.9：同一窗口空闲时连续调用，或续接进行中又来新请求，不能并发两次续接，最后一次的值必须进启动。需要确认的窗口，确认框显示最新值，确认一次只续接一次。

### 结论

已修好，未提交。空闲连发两次只发一次续接，启动读到的是第二次的值。续接已经读过旧值之后又来新请求，等这次结束再续接一次，不会两路一起重启。失败仍然不自动重试。不需要主控决策。

顺手做了验收建议第 2 条：待生效和确认框写上即将用的模型和强度。没有改 §8 决定 3 的旧句子，也没有改清洗锁的权限。

### 改动文件

- `apps/desktop/src/main/workbench/model-effort.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/renderer/src/pages/workbench/WindowPane.tsx`
- `apps/desktop/tests/model-effort.test.ts`
- `locales/zh-CN.json`、`locales/en-US.json`
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- `pnpm lint`：通过（Biome 753 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/model-effort.test.ts`：12 过。
- 重新构建后 `playwright test tests/e2e/model-effort.spec.ts`：2 过。

### 问题与遗留

没有。建议第 3、4 条未做。

### 相关文件链接

- [T10.12b 验收记录](../验收记录/T10.12b-验收.md)
- 检查：[2026-10-01 16:35 · T10.12b · 检查 · 改模型强度](./Phase10-对话总记录.md)

## 2026-10-01 17:03 · T10.12b · 复验 · 改模型强度

### 任务要点

复验 T10.12b 必须修。重跑空闲时连续改两次，并补「续接进行中又来新值」和「管理者连续改两次、确认一次」。核对上一轮通过的探针。最后一轮完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现。

### 结论

**通过。** 空闲连改两次只续接一次，参数是第二次的值。进行中再改不会并发重启，这次结束后再续接一次并带上最后的值。管理者两次改动都停在确认，确认时是最新值，确认一次不再自动续接。上一轮的注入、越权、无法续接和失败不重试仍然成立。不需要主控决策。

### 改动文件

- 追加复验：`docs/验收记录/T10.12b-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）
- 探针跑完已删

### 命令结果

- 复验探针 4 项：通过。
- `pnpm lint`：通过（Biome 753 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：2408 过 / 1 跳过（140 个文件）。
- `pnpm smoke`：11 项 ALL PASS。v0.10.13。
- `pnpm test:e2e`：51 过（约 5.0 分钟）。

### 问题与遗留

没有。建议第 3、4 条仍未做，不阻断。

### 相关文件链接

- [T10.12b 验收记录](../验收记录/T10.12b-验收.md)
- 修复：[2026-10-01 16:42 · T10.12b · 修复 · 改模型强度](./Phase10-对话总记录.md)

## 2026-10-01 17:12 · T10.12b · 提交 · v0.10.14

### 任务要点

按计划 §7.2 第 4 步提交 T10.12b。版本 `0.10.13` → `0.10.14`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.12b 已验收和遗留建议。计划 §4、§9、§7.5 同步。轻量 tag `v0.10.14`，不 push。

### 结论

已提交并打轻量 tag `v0.10.14`，未 push。不需要主控决策。下一步 T10.13 清理。

提交哈希：`ffe732d4f092b33bb9fdab34974badfb4706e788`。tag 指向这一笔。本条是后补的，所以 tag 里的总记录还没有这一节。

### 改动文件

暂存并提交（不含 `apps/desktop/scripts/real-config-probe.mjs`，不含 `apps/desktop/out`）：

- `package.json`
- `apps/desktop/package.json`
- `README.md`
- `apps/desktop/tests/client-server.test.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `apps/desktop/resources/workbench-roles/manager.md`
- `apps/desktop/src/main/data.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/main/workbench/mcp-tools.ts`
- `apps/desktop/src/main/workbench/model-effort.ts`
- `apps/desktop/src/mcp/workbench-tools.ts`
- `apps/desktop/src/renderer/src/pages/workbench/TerminalView.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/WindowPane.tsx`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/tests/e2e/fake-workbench-cli.js`
- `apps/desktop/tests/e2e/model-effort.spec.ts`
- `apps/desktop/tests/model-effort.test.ts`
- `apps/desktop/tests/workbench-mcp.test.ts`
- `apps/desktop/tests/workbench-memory.test.ts`
- `locales/zh-CN.json`
- `locales/en-US.json`
- `packages/shared/src/domain/index.ts`
- `packages/shared/src/domain/model-override.ts`
- `packages/shared/src/domain/workbench.ts`
- `packages/shared/tests/model-override.test.ts`
- `packages/storage/src/workbench/store.ts`
- `docs/Phase10-多窗口终端工作台计划.md`
- `docs/开发进度.md`
- `docs/验收记录/T10.12b-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`（提交时含到复验；本条后补）

### 命令结果

- `pnpm lint`：通过（Biome 753 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/client-server.test.ts apps/desktop/tests/command-ipc.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.12b 管理者改模型与思考强度`
- 轻量 tag `v0.10.14`，未 push
- 提交哈希：`ffe732d4f092b33bb9fdab34974badfb4706e788`

### 问题与遗留

未纳入 `apps/desktop/scripts/real-config-probe.mjs`。验收建议仍是：§8 决定 3 的旧句子还在；清洗锁不阻止已授权管理者改后代窗口的模型和强度。布局里的旧 `profileId` 留给 T10.13。

### 相关文件链接

- [T10.12b 验收记录](../验收记录/T10.12b-验收.md)
- [开发进度](../开发进度.md)
- 复验：[2026-10-01 17:03 · T10.12b · 复验 · 改模型强度](./Phase10-对话总记录.md)

## 2026-10-01 17:31 · T10.13 · 执行 · 清理

### 任务要点

按计划 §9.1、§9.5、§9.6、§9.4 和 §7.3、§7.4 做清理。不提交。不碰 `apps/desktop/scripts/real-config-probe.mjs`。不读写 `~/.aiworkbench`，不改 `~/.claude`、`~/.codex`。不跑消耗额度的命令。磁盘上的旧计划 / 任务 / 会话文件不删、不迁。领域类型 Plan / Task / Run / Session 和 storage 读写保留。

「AI 输出语言」按 §9.5 第 3 条留给 T10.14，这次不藏。自配置工具和它的开关不动。

### 结论

清理已落地，未提交。界面、启动和主进程都不再读取旧计划 / 任务 / 会话文件；文件仍留在磁盘上。

顺手做了的验收遗留：布局不再写入旧 `profileId`，读入时忽略、不报错（T10.12a / T10.12b 都提到的那条）。

没做的验收遗留（拿不准，不是小清理）：

1. 计划 §8 决定 3 里「往窗口输入切换命令」的旧句子。§9.9 已经取代它。改计划归主控，这次没动。
2. 界面上标注「手动改过可能和显示不一致」。那是被 §9.9 换掉的旧做法，这次不加。
3. 被清洗锁住的后代窗口，已授权管理者仍可改它的模型和强度。这是权限行为，不是清理。

### 改动文件

**删除的通道和契约**

- 有 handler 的：`plans:list`、`plans:approve`、`tasks:list`、`tasks:accept`、`tasks:cancel`、`tasks:set-reasoning-effort`、`runs:list`、`sessions:list`、`handoff:generate`、`workbench:remove-layout`
- 只有契约的：`sessions:latest`、`sessions:transcript`、`sessions:active-turns`、事件 `tasks:settled`
- 一并删掉只服务这些通道的契约类型：`RemoveWorkbenchLayoutRequest`、`TaskActionRequest`、`SetTaskReasoningEffortRequest`、`AcceptTaskResult`、`ApprovePlanRequest`、`HandoffPreview`、`SessionTranscriptRequest`、`SessionTranscriptView`、`DEFAULT_TRANSCRIPT_LIMIT`、`TaskSettledEvent`
- 删项目摘要里计划 / 任务 / Run / 会话四路读取（`project-summary.ts` 的类型和 `data.ts` 的装配）。汇总仍只看 `.workbench/` 在不在
- 删项目时仍直接调 layout store 的 `removeProject`，不走已删的 `workbench:remove-layout`

**删除的语言包键（中英同步，各 241 个叶子键）**

- `nav.session` / `nav.plan` / `nav.tasks` / `nav.runs`（各 label + question）
- 整段 `session.*`、`plan.*`、`tasks.*`、`runs.*`
- `knowledge.sendToSession`
- `task.status.*`（7 个）。只被已删的任务状态徽章使用，徽章删掉后没有引用
- 未动 `workbench.drawer.*`

**删除的文件**

- `apps/desktop/src/renderer/src/hooks/useRoleProfile.ts`（`useRoleProfile` / `useDiscussionProfiles`，没有调用方）
- `apps/desktop/src/renderer/src/pages/settings/ContextWarnSection.tsx`（设置页不再挂这一块）

**其它**

- 知识库页和 HitCard 注释改为只留复制引用。导航注释改为侧栏四个页面（项目、工作台、记忆、知识库）加设置
- 设置页隐藏「上下文阈值」。`contextWarnPercent` 仍在 `GlobalConfig` / `config.json`，`config:get` 能读出默认 70。e2e 改为断言页面上没有这一项，并且字段仍能读到。AI 输出语言仍在
- 「本机登录」探测下拉只留 `claude-code`、`codex`。`CLI_LOGIN_RUNTIME_WIRES` 和适配器没删。档案页已整页隐藏，Qwen / iFlow / Aider / 通用命令不会出现。新开窗口和配置编辑本来就只有 Claude、Codex
- 工作台 store 新建 / 拆分 / 补丁不再写 `profileId`。布局读入忽略该字段；`stripRuntimeFields` 落盘时剥掉。权威表同步也不再把它抄回去
- `TASK_STATUS_BADGE`、`TaskStatusBadge` 连同只测它们的单测删除。能力徽章保留
- README 改为：界面、启动和主进程都不再读取旧计划 / 任务 / 会话文件；文件保留，不删不迁

文件：

- `README.md`
- `locales/zh-CN.json`、`locales/en-US.json`
- `apps/desktop/src/main/data.ts`
- `apps/desktop/src/main/project-summary.ts`
- `apps/desktop/src/main/workbench/auth-registry.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `apps/desktop/src/renderer/src/stores/pages.ts`
- `apps/desktop/src/renderer/src/stores/project-alerts.ts`
- `apps/desktop/src/renderer/src/layout/nav.ts`
- `apps/desktop/src/renderer/src/layout/Sidebar.tsx`
- `apps/desktop/src/renderer/src/command/commands.ts`
- `apps/desktop/src/renderer/src/pages/knowledge/KnowledgePage.tsx`
- `apps/desktop/src/renderer/src/pages/knowledge/HitCard.tsx`
- `apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx`
- `apps/desktop/src/renderer/src/pages/settings/providers/ProviderEditorDialog.tsx`
- `apps/desktop/src/renderer/src/components/ui/Badge.tsx`
- `apps/desktop/src/renderer/src/components/ui/badge.variants.ts`
- `apps/desktop/src/renderer/src/components/ui/index.ts`
- `packages/shared/src/domain/workbench.ts`
- `packages/storage/src/workbench/store.ts`
- `apps/desktop/tests/contracts.test.ts`
- `apps/desktop/tests/project-summary.test.ts`
- `apps/desktop/tests/secondary-panel.test.ts`
- `apps/desktop/tests/ui-components.test.ts`
- `apps/desktop/tests/e2e/context-warn.spec.ts`
- `apps/desktop/tests/e2e/multi-project.spec.ts`
- `apps/desktop/tests/e2e/provider-config-ux.spec.ts`
- `apps/desktop/tests/e2e/reasoning-effort.spec.ts`（只改过时的文件头注释）
- `packages/storage/tests/workbench-layouts.test.ts`
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- `pnpm lint`：通过（Biome 751 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：140 个文件，2399 过 / 1 跳过。
- 受影响 e2e：`context-warn.spec.ts`、`multi-project.spec.ts`、`provider-config-ux.spec.ts`，6 过。
- 改过的文件没有 CRLF。未跑 `pnpm smoke`、全量 `pnpm test:e2e`。未调用模型。

### 问题与遗留

- 未纳入 `apps/desktop/scripts/real-config-probe.mjs`。e2e 构建刷新了 `apps/desktop/out/`，那是构建产物，不是这次要交的源码。
- 历史脚本仍调用已删通道，不在 `pnpm test` 里，这次没改：`apps/desktop/scripts/live-ten-step.mjs`、`live-knowledge-tool.mjs`、`human-walk.mjs`、`human-walk-continue.mjs`、`dirty-walk.mjs`。`config-click-audit.mjs` 还会去点已隐藏的阈值下拉和已不存在的会话页。
- 契约里还留着 `session:start`、`session:cancel`、`session:respond-permission`、`session:respond-config-draft`、事件 `session:event`。主进程和渲染层都没有调用。派活清单没列，没删。
- 计划 §9.1 第 2 条仍写「主进程查询通道还留着」。README 已按删通道之后的事实改过。计划正文归主控，这次没改。
- `project-alerts` store 还在，只剩测试在用，界面不再订阅落定事件。没删，避免扩大范围。
- 上面三条验收遗留（计划旧句子、显示不一致标注、清洗锁）未做。

### 相关文件链接

- [Phase 10 计划 §7.3、§7.4、§9.1、§9.4、§9.5、§9.6](../Phase10-多窗口终端工作台计划.md)
- 审计：[2026-10-01 14:03 · Phase10 · T10.12-0 · 调研 · 串联审计](./Phase10-对话总记录.md)
- [开发进度](../开发进度.md)（T10.12a / T10.12b 验收遗留建议）

## 2026-10-01 17:47 · T10.13 · 修复 · 补删旧通道

### 任务要点

按主控补充的计划 §9.1 第 3 条，把契约里其它只服务旧会话、没有 handler、也没有调用方的通道一并删掉。删前逐个确认主进程、渲染层和类型引用。工作台、记忆、知识库、来源、配置、终端在用的通道不动。领域类型和存储读写保留。拿不准的不删。不提交。

### 结论

删了 4 条。留了 2 条，因为自配置工具的草案中枢还引用它们的类型。

### 删掉的通道

- `session:start`
- `session:respond-permission`
- `session:cancel`
- 事件 `habits:suggestion`（旧会话「反复纠正就弹习惯建议」。没有 handler，渲染层不订阅。习惯页用的 `habits:list` / `create` / `update` / `approve` / `reject` / `set-enabled` / `check-conflicts` 都还在）

只被这些通道用的类型一并删了：`SessionInput`、`StartSessionRequest`、`StartSessionAck`、`RespondPermissionRequest`、`CancelSessionRequest`、`SessionActionAck`、`HabitSuggestionEvent`。

确认过：主进程没有这些 handler；`apps/desktop/src` 里没有 invoke / subscribe。历史走查脚本还在调用 `session:start` / `session:event`，那些脚本不在 `pnpm test` 里，上一轮已登记，这次仍不改。

### 保留的通道及理由

- `session:respond-config-draft`：主进程没有注册 handler，渲染层也不调用。但 `apps/desktop/src/main/session/config-draft-hub.ts` 使用 `RespondConfigDraftRequest` / `ConfigDraftAck`。这是自配置工具的生产代码，T10.14 要改造，不是测试里的假引用。
- 事件 `session:event`：同一份草案中枢用 `SessionStreamEvent` 发布 `config-draft`。删通道就要改自配置工具，这次不动。

工作台、记忆、知识库、来源、配置、终端、档案、角色、冒烟通道都没有动。

### 改动文件

- `apps/desktop/src/shared-ipc/contracts.ts`
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

### 命令结果

- `pnpm lint`：通过（Biome 751 个文件，check-i18n PASS）。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：140 个文件，2399 过 / 1 跳过。
- 未跑 e2e / smoke。未调用模型。未改 `real-config-probe.mjs`。

### 问题与遗留

- `session:respond-config-draft` 和 `session:event` 仍无 IPC handler，只被草案中枢的类型引用撑着。要不要在 T10.14 改造自配置工具时一起收口，等那一单。
- 历史脚本 `live-ten-step.mjs`、`live-knowledge-tool.mjs`、`human-walk.mjs`、`human-walk-continue.mjs`、`dirty-walk.mjs`、`config-click-audit.mjs` 仍会调用已删的 `session:start`。

### 相关文件链接

- [Phase 10 计划 §9.1](../Phase10-多窗口终端工作台计划.md)
- 上一轮：[2026-10-01 17:31 · T10.13 · 执行 · 清理](./Phase10-对话总记录.md)
- 草案中枢：`apps/desktop/src/main/session/config-draft-hub.ts`

## 2026-10-01 18:00 · T10.13 · 检查 · 清理

### 任务要点

独立检查未提交的 T10.13。对照计划 §9.1、§9.4、§9.5、§4.1、§7.3、§7.4，以及总记录里的审计清单、执行条目和补删通道条目。审查 diff，做反向探针，首验完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。

### 结论

**通过。** 没有必须修复。AI 输出语言、自配置开关、工作台抽屉语言键和在用通道都还在。旧计划 / 任务 / 会话文件没有被删或迁移。

### 改动文件

- `docs/验收记录/T10.13-验收.md`（新建）
- `docs/对话记录/Phase10-对话总记录.md`（本条，只追加）

未改实现。未改 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `pnpm lint`：通过。Biome 751 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：**2399 过 / 1 跳过**（140 个文件）。
- `pnpm smoke`：**11 项 ALL PASS**。FF-pane v0.10.14。pdfjs 缺 canvas 的警告不记失败。
- `pnpm test:e2e`：**51 过**（约 5.0 分钟）。
- 反向探针（临时数据根，跑完已删）：旧 `contextWarnPercent`、检查员字段、计划文件读入不崩且仍在磁盘上；`plans:list` 与 `session:start` 返回「通道未在契约中登记」，没有崩溃。

### 问题与遗留

- 建议，不挡：档案列表还在用已删除的 `session.role.*`，但档案页没挂上，界面到不了。
- 建议，不挡：冷启动 `workbench:get-layouts` 写回布局时会丢掉 `routeMode` / `routeModel`。`applyAuthNode` 本来就不抄这两项，这次 diff 只少了 `profileId`。标题、权限、会话 id 还在。
- `session:respond-config-draft` 和 `session:event` 按执行者的理由保留，检查同意：草案中枢还引用它们的类型。
- 计划 §7.5 和开发进度里 T10.11 那节仍写「查询通道还留着」。README 和 §9.1 已与事实一致。提交时对齐进度快照即可。

### 相关文件链接

- [T10.13 验收记录](../验收记录/T10.13-验收.md)
- [Phase 10 计划 §9.1](../Phase10-多窗口终端工作台计划.md)
- 执行：[2026-10-01 17:31 · T10.13 · 执行 · 清理](./Phase10-对话总记录.md)
- 补删：[2026-10-01 17:47 · T10.13 · 修复 · 补删旧通道](./Phase10-对话总记录.md)

## 2026-10-01 18:04 · T10.13 · 提交 · v0.10.15

### 任务要点

按计划 §7.2 第 4 步提交 T10.13。版本 `0.10.14` → `0.10.15`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.13 已验收和验收建议，并标明 T10.12a / T10.12b 里已做掉的 `profileId` 遗留。计划 §4、§9、§7.5 同步。轻量 tag `v0.10.15`，不 push。

### 结论

已提交并打轻量 tag `v0.10.15`，未 push。不需要主控决策。下一步 T10.14 串联。

### 改动文件

暂存并提交（不含 `apps/desktop/scripts/real-config-probe.mjs`，不含 `apps/desktop/out`）：

- `package.json`
- `apps/desktop/package.json`
- `README.md`
- `locales/zh-CN.json`
- `locales/en-US.json`
- `apps/desktop/src/main/data.ts`
- `apps/desktop/src/main/project-summary.ts`
- `apps/desktop/src/main/workbench/auth-registry.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `apps/desktop/src/renderer/src/stores/pages.ts`
- `apps/desktop/src/renderer/src/stores/project-alerts.ts`
- `apps/desktop/src/renderer/src/layout/nav.ts`
- `apps/desktop/src/renderer/src/layout/Sidebar.tsx`
- `apps/desktop/src/renderer/src/command/commands.ts`
- `apps/desktop/src/renderer/src/pages/knowledge/KnowledgePage.tsx`
- `apps/desktop/src/renderer/src/pages/knowledge/HitCard.tsx`
- `apps/desktop/src/renderer/src/pages/settings/SettingsPage.tsx`
- `apps/desktop/src/renderer/src/pages/settings/ContextWarnSection.tsx`（删除）
- `apps/desktop/src/renderer/src/pages/settings/providers/ProviderEditorDialog.tsx`
- `apps/desktop/src/renderer/src/components/ui/Badge.tsx`
- `apps/desktop/src/renderer/src/components/ui/badge.variants.ts`
- `apps/desktop/src/renderer/src/components/ui/index.ts`
- `apps/desktop/src/renderer/src/hooks/useRoleProfile.ts`（删除）
- `packages/shared/src/domain/workbench.ts`
- `packages/storage/src/workbench/store.ts`
- `apps/desktop/tests/client-server.test.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `apps/desktop/tests/contracts.test.ts`
- `apps/desktop/tests/project-summary.test.ts`
- `apps/desktop/tests/secondary-panel.test.ts`
- `apps/desktop/tests/ui-components.test.ts`
- `apps/desktop/tests/e2e/context-warn.spec.ts`
- `apps/desktop/tests/e2e/multi-project.spec.ts`
- `apps/desktop/tests/e2e/provider-config-ux.spec.ts`
- `apps/desktop/tests/e2e/reasoning-effort.spec.ts`
- `packages/storage/tests/workbench-layouts.test.ts`
- `docs/Phase10-多窗口终端工作台计划.md`
- `docs/开发进度.md`
- `docs/验收记录/T10.13-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`

### 命令结果

- `pnpm lint`：通过。Biome 751 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/client-server.test.ts apps/desktop/tests/command-ipc.test.ts`：2 个文件，73 过。
- 提交信息：`chore: T10.13 清理旧会话残留`
- 轻量 tag `v0.10.15`，未 push
- 提交哈希：`6c111d0bcaedc8416a7a8ffafe9f114a843eb2f5`

### 问题与遗留

未纳入 `apps/desktop/scripts/real-config-probe.mjs`。验收建议仍是：档案列表还引用已删的 `session.role.*`（页面未挂上）；冷启动写回布局会丢掉 `routeMode` / `routeModel`（T10.12 起就有）。T10.12b 另外三条遗留未做。

### 相关文件链接

- [T10.13 验收记录](../验收记录/T10.13-验收.md)
- [开发进度](../开发进度.md)
- 检查：[2026-10-01 18:00 · T10.13 · 检查 · 清理](./Phase10-对话总记录.md)

## 2026-10-01 18:32 · T10.14 · 执行 · 串联

### 任务要点

按计划 §9.2 定稿、§9.5 第 3、6、7 条、§9.6 第 2 条、§9.7、§8、§3.2.1、§7.3、§7.4，以及总记录「2026-10-01 14:03 · Phase10 · T10.12-0 · 调研 · 串联审计」第 1、3、5 节，做四件事：AI 输出语言写进窗口角色提示；已通过且启用的习惯写进同一份提示；自配置工具改为起草配置、只给管理者、须确认；用户主动要求时管理者派工作者总结沉淀。不提交。

### 结论

#### AI 输出语言

设置页增加「跟随（不指定）」。选简体中文或 English 时，打开 Claude / Codex 窗口会把一句「请用该语言回复」接在该窗口角色提示后面。选跟随、空值或无法识别的值不写。出厂默认仍是简体中文，所以没改过这项的窗口会要求用中文回复。Claude 写进该窗口临时文件；Codex 走现有的本窗口 `developer_instructions`。不写 PTY，不改本机 CLI 全局设置。设置页说明已改成这句话。

#### 习惯

开窗口时用 `compileHabitProfile` 只取已通过且启用的习惯，接在同一份角色提示里。停用、待审核、已归档（删除）不带。习惯段上限 4000 字，超出在换行处截断并写明「其余习惯因长度上限未写入」。没有把「根据纠正自动生成习惯候选」接回来。记忆页习惯说明已改成与上述事实一致。

#### 自配置工具

工具改为 `config_list_providers`、`config_list_configs`、`config_draft_provider`、`config_draft_config`。不再注册档案列表和档案草案。中转路需要新来源时仍可起草来源；密钥只能在确认框里手输，schema、列表和草案里都没有密钥或 `apiKeyRef`。只在该项目 `configToolEnabled` 打开、且窗口角色是管理者时挂上 `ffpane-config`。草案先走与设置页相同的校验（默认配置不能收窄范围、名单外仍绑定不许收窄、中转来源必须存在、不能取消唯一默认）。校验通过后工作台弹出确认框，展示全部字段和与现状的差异；确认才写入 `configs.json`，取消丢弃。设置页开关说明已改回：打开后注册给该项目的管理者窗口，写入须经你确认。§3.2.1 和 `manager.md` 已写上这套工具。

#### 总结沉淀

`manager.md` 写明：只有用户主动要求总结时，管理者才派一个工作者去总结；工作者用 `ffpane_memory_add` 写成待审核记忆（现有 120 / 2000 字和 10 秒间隔），再用 `ffpane_report` 汇报。不自动触发，不新增写知识库的工具。`worker.md` 补了总结任务的写法。

### 改动文件

- 语言与习惯注入：`packages/shared/src/domain/language.ts`、`packages/shared/src/domain/config.ts`、`packages/storage/src/config/store.ts`、`packages/core/src/habit/compile.ts`、`packages/core/src/workbench-role/launch-prompt.ts`、`packages/core/src/workbench-role/index.ts`、`apps/desktop/src/main/workbench/handlers.ts`、`apps/desktop/src/renderer/src/pages/settings/LanguageSection.tsx`
- 自配置：`apps/desktop/src/mcp/config-tool.ts`、`apps/desktop/src/mcp/config-server.ts`、`apps/desktop/src/main/session/config-tool.ts`、`apps/desktop/src/main/session/config-draft-hub.ts`、`apps/desktop/src/main/workbench/config-draft-validate.ts`、`apps/desktop/src/main/workbench/config-draft-apply.ts`、`apps/desktop/src/main/workbench/config-tool-attach.ts`、`apps/desktop/src/main/workbench/launch-cli.ts`、`apps/desktop/src/main/data.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/shared-ipc/contracts.ts`、`apps/desktop/src/renderer/src/pages/workbench/WorkbenchConfigDraftDialog.tsx`、`apps/desktop/src/renderer/src/App.tsx`
- 文案与说明：`locales/zh-CN.json`、`locales/en-US.json`、`apps/desktop/resources/workbench-roles/manager.md`、`apps/desktop/resources/workbench-roles/worker.md`、`docs/Phase10-多窗口终端工作台计划.md`（§3.2.1 工具清单）
- 测试：`packages/core/tests/launch-prompt.test.ts`、`apps/desktop/tests/mcp-config-tool.test.ts`、`apps/desktop/tests/session-config-tool.test.ts`、`apps/desktop/tests/workbench-config-draft.test.ts`、`apps/desktop/tests/e2e/config-tool.spec.ts`、`apps/desktop/tests/e2e/config-tool-workbench.spec.ts`

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/shared build`、`pnpm --filter @ff-pane/core build`、`pnpm --filter @ff-pane/storage build`：通过。给 desktop typecheck 用。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过（node、web、e2e）。
- 相关单测：`packages/core` `launch-prompt.test.ts` 7 过；desktop `workbench-config-draft.test.ts`、`mcp-config-tool.test.ts`、`session-config-tool.test.ts` 共 47 过。
- e2e：`electron-vite build` 后，`config-tool.spec.ts` 2 过，`config-tool-workbench.spec.ts` 1 过（管理者确认后配置出现、取消不变、工作者窗口没有该工具）。

### 问题与遗留

- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。
- 计划 §9 总表里 T10.14 仍写「待开工」。本节是执行结果，状态行留给检查通过后的提交步骤。
- 旧档案草案解析函数还在，工具面已不再注册。会话编排不在磁盘上，没有接回。
- 语言和习惯在启动时写进角色提示。窗口开着之后改设置或习惯，要重启该窗口才生效。
- Codex 的角色提示仍是启动参数里的 `developer_instructions`，不是临时文件；正文不进 PTY。
- 不需要主控决策。

### 相关文件链接

- [Phase 10 计划 §3.2.1、§9.5、§9.6、§9.7](../Phase10-多窗口终端工作台计划.md)
- 审计：[2026-10-01 14:03 · Phase10 · T10.12-0 · 调研 · 串联审计](./Phase10-对话总记录.md)
- 注入：`packages/core/src/workbench-role/launch-prompt.ts`、`apps/desktop/src/main/workbench/handlers.ts`
- 确认框：`apps/desktop/src/renderer/src/pages/workbench/WorkbenchConfigDraftDialog.tsx`
- 说明书：`apps/desktop/resources/workbench-roles/manager.md`、`apps/desktop/resources/workbench-roles/worker.md`
- e2e：`apps/desktop/tests/e2e/config-tool-workbench.spec.ts`

## 2026-10-01 19:02 · T10.14 · 检查 · 串联

### 任务要点

独立检查未提交的 T10.14。对照计划 §9.2 定稿、§9.5 第 3、6、7 条、§9.6 第 2 条、§9.7、§9.8、§3.2.1、§4.1、§7.3、§7.4，以及总记录「2026-10-01 18:32 · T10.14 · 执行 · 串联」。未改实现，未提交。

### 结论

有条件通过。四件事的主路径都在：语言和已启用习惯写入本窗口角色提示；自配置改为起草配置，普通角色和开关关闭不挂；未确认不落盘；说明书写了「只有用户要求才总结 → 派工作者 → `ffpane_memory_add` 待审核 → 汇报」，没有新的写知识库工具。

必须修复 4 项，修完再给 Tony 试用：

1. `manager.md` 2921 字节，超过说明书测试上限 2048，`pnpm test` 因此失败。写短，保留总结和确认两句。
2. 冷读后管理权未恢复、或被清洗锁住的管理者，角色名仍是 manager，自配置工具仍会挂上。应拿不到。
3. 确认框不清洗零宽字符和双向控制符；来源草案的 `extraEnv` 可夹带密钥且确认框不展示，确认后会写入 `providers.json`。
4. 短时间 30 份合格草案全部进入待确认。界面同时只显示一个，但没有上限或合并。

建议不挡：Codex 仍把提示放进本次进程参数而不是临时文件；不存在的项目 id 能写进范围；无法识别的输出语言会被收成简体中文。

不需要主控决策。

### 改动文件

- 新增 `docs/验收记录/T10.14-验收.md`
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过（node、web、e2e）。
- `pnpm test`：2413 过 / 1 失败 / 1 跳过。失败是 `manager.md` 超 2048 字节，不是偶发。
- `pnpm smoke`：11 项 ALL PASS。FF-pane v0.10.15。pdfjs 缺 canvas 的警告在 PASS 之前。
- `pnpm test:e2e`：52 过（约 5.3 分钟）。含管理者确认草案、非管理者没有工具、config MCP 无密钥字段。无 flake。
- 打包冒烟：`electron-builder --win dir` 到系统临时目录，数据根隔离后 `--smoke` ALL PASS。打包内有新的 `manager.md` 和 `config-mcp.js`。临时目录已删。

### 问题与遗留

- 未提交。未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。探针文件已删。
- 必须项见验收记录第 4 节。

### 相关文件链接

- [T10.14 验收记录](../验收记录/T10.14-验收.md)
- 执行：[2026-10-01 18:32 · T10.14 · 执行 · 串联](./Phase10-对话总记录.md)

## 2026-10-01 19:14 · T10.14 · 修复 · 串联

### 任务要点

按验收记录「必须修复」四项改。建议里没有改动小到可以顺手做的：Codex 改临时文件验收写明可以以后再做；不存在的项目 id、无法识别的语言收口拿不准，没动；设为默认仍保持拒绝；开着的窗口仍要重启才吃到新语言和习惯。

### 结论

四项都按验收写明的改法修了。

1. **说明书超长。** `manager.md` 从 2921 字节压到 2035 字节（上限 2048），仍是 LF。留下「只有 Tony 主动要求总结时」和「确认后才保存」。模型切换和自配置的约束还在，只是写短了。
2. **未恢复管理权仍挂工具。** 挂载增加「这次启动会授予或已经授予管理权」。已授予、用户重新授权的顶层管理者、父级已授予而继承的，才挂。冷读后不授予、被清洗锁住、父级还没授予的子管理者，不挂。伪造令牌仍走原来的控制通道拒绝，没改那条。
3. **确认框误导和隐藏密钥。** 名称、模型、地址、代理、项目 id、附加环境变量和模板选项里的换行、控制符、零宽字符、双向控制符，解析时直接拒绝，不进确认框。`extraEnv` 的键或值像密钥（含 `ANTHROPIC_API_KEY`、`sk-` 开头）也拒绝。确认框补上默认模型、向量模型、代理、超时、附加环境变量、模板选项，这些非密钥字段能看见。密钥仍只在确认框手输。
4. **草案刷屏。** 同时最多 3 份在等确认。多出来的写回「没有交给用户，也没有保存」，不弹下一个。

### 改动文件

- `apps/desktop/resources/workbench-roles/manager.md`
- `apps/desktop/src/main/workbench/config-tool-attach.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/main/session/config-draft-hub.ts`
- `apps/desktop/src/mcp/config-tool.ts`
- `apps/desktop/src/renderer/src/pages/workbench/WorkbenchConfigDraftDialog.tsx`
- `locales/zh-CN.json`、`locales/en-US.json`
- 测试：`apps/desktop/tests/workbench-config-draft.test.ts`、`apps/desktop/tests/mcp-config-tool.test.ts`、`apps/desktop/tests/e2e/config-tool-workbench.spec.ts`

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过（node、web、e2e）。
- 相关单测：`workbench-config-draft.test.ts`、`mcp-config-tool.test.ts`、`workbench-role-resources.test.ts`、`session-config-tool.test.ts` 共 54 过。修完正则写法后又跑前三份，40 过。
- 受影响 e2e：`config-tool-workbench.spec.ts` 1 过（约 24 秒）。含确认、取消、零宽名称被拒、第 4 份草案不进确认框、工作者没有该工具。

### 问题与遗留

- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。
- 建议 5 条都没改，原因见任务要点。
- 不需要主控决策。

### 相关文件链接

- [T10.14 验收记录](../验收记录/T10.14-验收.md)
- 检查：[2026-10-01 19:02 · T10.14 · 检查 · 串联](./Phase10-对话总记录.md)

## 2026-10-01 19:39 · T10.14 · 复验 · 串联

### 任务要点

复验 4 项必须修。重跑首验失败的探针，并核对上一轮通过的探针。完整跑 lint、desktop typecheck、`pnpm test`、`pnpm smoke`、`pnpm test:e2e`，以及打包冒烟。未改实现，未提交。

### 结论

通过。4 项必须修都成立，上一轮通过的探针没有被修坏。可以按验收记录里的手动试用步骤给 Tony 试用。建议 5 条仍未改，不挡。

### 改动文件

- 在 `docs/验收记录/T10.14-验收.md` 末尾追加「复验」
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：2417 过 / 1 跳过（142 个文件）。首跑即过。
- `pnpm smoke`：11 项 ALL PASS。FF-pane v0.10.15。
- `pnpm test:e2e`：52 过（约 5.6 分钟）。无 flake。
- 打包冒烟：临时目录 `--smoke` 退出码 0。打包内 `manager.md` 2035 字节，含总结和确认两句。`app.asar` 含 `config-mcp.js`。临时目录已删。

### 问题与遗留

- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。探针已删。
- 不需要主控决策。

### 相关文件链接

- [T10.14 验收记录](../验收记录/T10.14-验收.md)
- 修复：[2026-10-01 19:14 · T10.14 · 修复 · 串联](./Phase10-对话总记录.md)

## 2026-10-01 19:42 · T10.14 · 提交 · v0.10.16

### 任务要点

按计划 §7.2 第 4 步提交 T10.14。版本 `0.10.15` → `0.10.16`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.14 已验收和验收建议。计划 §4、§9、§7.5 同步。轻量 tag `v0.10.16`，不 push。

### 结论

已提交并打轻量 tag `v0.10.16`，未 push。不需要主控决策。下一步 T10.15 加固。

### 改动文件

暂存并提交（不含 `apps/desktop/scripts/real-config-probe.mjs`，不含 `apps/desktop/out`）：

- `package.json`
- `apps/desktop/package.json`
- `README.md`
- `locales/zh-CN.json`
- `locales/en-US.json`
- `apps/desktop/resources/workbench-roles/manager.md`
- `apps/desktop/resources/workbench-roles/worker.md`
- `apps/desktop/src/main/data.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/session/config-draft-hub.ts`
- `apps/desktop/src/main/session/config-tool.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/main/workbench/launch-cli.ts`
- `apps/desktop/src/main/workbench/config-draft-apply.ts`
- `apps/desktop/src/main/workbench/config-draft-validate.ts`
- `apps/desktop/src/main/workbench/config-tool-attach.ts`
- `apps/desktop/src/mcp/config-server.ts`
- `apps/desktop/src/mcp/config-tool.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/pages/settings/LanguageSection.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/WorkbenchConfigDraftDialog.tsx`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/tests/client-server.test.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `apps/desktop/tests/e2e/config-tool.spec.ts`
- `apps/desktop/tests/e2e/config-tool-workbench.spec.ts`
- `apps/desktop/tests/mcp-config-tool.test.ts`
- `apps/desktop/tests/session-config-tool.test.ts`
- `apps/desktop/tests/workbench-config-draft.test.ts`
- `packages/core/src/habit/compile.ts`
- `packages/core/src/workbench-role/index.ts`
- `packages/core/src/workbench-role/launch-prompt.ts`
- `packages/core/tests/launch-prompt.test.ts`
- `packages/shared/src/domain/config.ts`
- `packages/shared/src/domain/language.ts`
- `packages/storage/src/config/store.ts`
- `docs/Phase10-多窗口终端工作台计划.md`
- `docs/开发进度.md`
- `docs/验收记录/T10.14-验收.md`
- `docs/对话记录/Phase10-对话总记录.md`

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/client-server.test.ts apps/desktop/tests/command-ipc.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.14 语言习惯注入、自配置改起草配置、总结沉淀`
- 轻量 tag `v0.10.16`，未 push
- 提交哈希：`305f05ba66cbac1446f0fa31070e108e12fbe3d7`

### 问题与遗留

未纳入 `apps/desktop/scripts/real-config-probe.mjs`。验收建议仍是：Codex 提示在本次进程参数里；草案可写入不存在的项目 id；无法识别的输出语言会收成简体中文；带范围的配置设为默认时草案直接拒绝；语言和习惯要重启窗口才生效。

### 相关文件链接

- [T10.14 验收记录](../验收记录/T10.14-验收.md)
- 复验：[2026-10-01 19:39 · T10.14 · 复验 · 串联](./Phase10-对话总记录.md)

## 2026-10-01 20:07 · T10.14 · 复验 · 串联

### 任务要点

独立复验已提交的 T10.14（`305f05ba66cbac1446f0fa31070e108e12fbe3d7`，tag `v0.10.16`）。核对 4 项必须修，重跑验收记录第 2 节的反向探针，并核对上一轮通过的探针。完整跑 lint、desktop typecheck、`pnpm test`、`pnpm smoke`、`pnpm test:e2e`，以及打包冒烟。未改实现，未提交。


### 结论

通过。4 项必须修都成立，上一轮通过的探针没有被修坏。可以按验收记录里的手动试用步骤给 Tony 试用。建议 5 条仍未改，不挡。不需要主控决策。

### 改动文件

- 在 `docs/验收记录/T10.14-验收.md` 末尾追加「复验（独立）」
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 759 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：2417 过 / 1 跳过（142 个文件，约 21 秒）。首跑即过。
- `pnpm smoke`：11 项 ALL PASS。FF-pane v0.10.16。
- `pnpm test:e2e`：52 过（约 5.5 分钟）。无 flake。
- 打包冒烟：临时目录 `--smoke` 退出码 0。打包内 `manager.md` 2035 字节，含总结和确认两句。`app.asar` 含 `config-mcp.js`。临时目录已删。

### 问题与遗留

- 未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。未跑消耗额度的命令。探针已删。
- 不需要主控决策。

### 相关文件链接

- [T10.14 验收记录](../验收记录/T10.14-验收.md)
- 修复：[2026-10-01 19:14 · T10.14 · 修复 · 串联](./Phase10-对话总记录.md)

## 2026-10-01 20:32 · T10.15 · 执行 · 加固

### 任务要点

按计划 §9.3 逐条分类后，只做甲、乙。丙不实现。未提交。

### 结论

甲 1 条、乙 3 条已做。丙 3 条留给 Tony，没有改对应代码。

**1. 记忆文件可被改成已生效 — 甲。** 有编辑权的窗口可以直接改项目里的记忆 Markdown，把状态写成已生效，旧注入会收。这是 Tony 已经同意的（§9.4 第 1 条里的 T10.10 决定 2）。根因不在工具，而在记忆文件就放在项目目录里，编辑权窗口本来就能改这些文件。要挡死得挪走文件或给每条签名，那是另一项产品决定。处置：只写进计划 §9.3 第 1 条，标为已知并接受，不改代码。

**2. 记忆检索先读完整文件 — 乙。** 检索命中后 `loadEntry` 会把 Markdown 整份读进内存，16KB 只限制交回给模型的字数。手改的超大文件会先占主进程。根因：`apps/desktop/src/main/workbench/project-memory.ts` 的 `searchCallerProjectMemory` 对每条命中调用 `loadEntry`。修法：单文件超过 256KB 时只读开头，正文前加一句说明；不超过的仍整份解码，条数、查询、状态过滤、16KB 装箱都不变。风险：超限文件的后半段检索结果里看不到，说明写在正文开头，装箱时不会被截掉。

**3. 权限摘要多重集减穿 — 丙，未实现。** 只有一次确认，却来了一次没有对应 PermissionRequest 的同摘要 PostToolUse（例如同一次输入里，另一条相同命令被自动允许并先跑完）时，多重集会被减到 0，阶段变成 busy，下一次 Stop 可能写入。代码在 `apps/desktop/src/main/workbench/idle-deliver.ts` 的 `noteHook`。PermissionRequest 没有 tool_use_id，PostToolUse 有，两边只能按摘要配对，分不出「这是框对应的那一次」还是「另一次相同输入」。两次都在等确认的交错是安全的。真实 Claude 在确认框还开着时通常还不发 Stop。验收 T10.7b §4 已建议保持现状。
- 推荐：已知并接受。不改配对。
- 备选：没有 id 的摘要不再因 PostToolUse 减少，只等用户再发一句才清。更安全，但确认之后的提醒会停住，直到用户再提交。这会改变自动投递，需 Tony 拍板。
- 不推荐：退回「任意 PostToolUse 都清零」，或去读 hook 正文来猜哪一次弹了框。

**4. Codex 首轮前手动发送 — 乙（只改说明，不改投递）。** Codex 没有权限信号。第一轮还没结束时，点「立即发送」会真的把排队的字和回车写进终端。画面上已有确认框时，这一下等于在框上按了回车。回合进行中是安全的：已经提交过回车就会记成忙，直到 `agent-turn-complete`。根因：`idle-deliver.ts` 在 phase 为 unknown 时允许 `deliverNow`；§7.4 写明没有可靠信号时只允许用户手动发送。旧文案「若画面上有确认框请勿点击」没说清不要点的是这个按钮，也没说它会写回车。修法：中英文提示改成：这个按钮会写入一次回车；Codex 第一轮结束前收不到权限信号；确认框还在时不要点。不禁止手动发送，不改自动投递。风险：用户仍可能点下去，这是决定留下的残余，文案只是让人看得见。

**5. 工作台 Codex 窗口替换用户 notify — 丙，未实现。** 本次进程的 `-c notify=[node.exe, 脚本]` 盖过 `config.toml` 里的 notify，不转发、不写 `~/.codex`。窗口退出后，用户自己的 notify 还在配置文件里。代码在 `apps/desktop/src/main/workbench/cli-args.ts` 与 `hook-launch.ts`。要「修好」就得读取并执行用户 `~/.codex` 里配置的 notify 命令，碰 §7.4。
- 推荐：已知并接受。不读、不执行用户的 notify。
- 不推荐：读 config.toml 再链式调用用户命令。
- 不推荐：去掉 `-c notify`。Codex 窗口会失去回合结束信号，自动投递退回到全程手动。

**6. 同目录极短时间双开 Codex，认领可能超时 — 丙，未实现。** 两个窗口几乎同时在同一目录打开，若只落下一个 rollout，后开的那个按启动先后贪心，等不到第二个文件，默认最多等 120 秒然后失败，续接走选择器，不静默 `--last`。代码在 `apps/desktop/src/main/workbench/codex-claim.ts` 的 `pickCodexSessionForClaim` / `CodexSessionClaimer`。两个文件都在时，现有单测能配成不同 id。只落一个文件时，分不出第二个会话，缩短等待会误伤「Codex 很久才写 session_meta」。
- 推荐：已知并接受。超时后进选择器，不静默接最近一条。
- 备选：同目录已经有窗口认领了唯一文件后，后开窗口把等待缩短到几秒再进选择器。更快，但第二个文件写得慢时会误判失败。需 Tony 拍板。
- 不推荐：超时后改回 `--last`。

**7. 三个偶发测试 — 乙，只加固测试。**
- 命令面板：`command-ipc.test.ts` 在用例体内动态 import 命令面板，机器忙时超过 vitest 默认 5 秒。导入改到文件加载时开始，断言仍是导出为函数。没有加长这条用例的超时。
- 适配器超时树杀：`process.test.ts` 的 500ms 超时在 node 还没写出 `up` 时就树杀，于是读不到 `up`。产品超时仍是 500ms。只有「结束方式是 timeout、输出为空、标记文件不存在（进程还没执行到 write）」才重试，最多 3 次；写出了 `up` 就必须是 timeout；标记已写但输出不是 `up` 会失败，不重试。
- PTY 清理 EPERM：`terminal-pty.integration.test.ts` 的 `rmSync` 没有重试，cmd 退出后目录句柄还占着就会失败。清理改为最多 5 次、间隔 200ms。echo 仍须在 8 秒内出现。用例计时器设为 20 秒，只为盖住这 8 秒等待和清理，不把 8 秒放宽。

### 改动文件

- `docs/Phase10-多窗口终端工作台计划.md`（§9.3 第 1 条标为已知并接受）
- `apps/desktop/src/main/workbench/memory-policy.ts`
- `apps/desktop/src/main/workbench/project-memory.ts`
- `apps/desktop/tests/workbench-memory.test.ts`
- `locales/zh-CN.json`、`locales/en-US.json`
- `apps/desktop/tests/workbench-deliver-hint.test.ts`
- `apps/desktop/tests/e2e/workbench-cli.spec.ts`
- `apps/desktop/tests/command-ipc.test.ts`
- `packages/adapters/tests/process.test.ts`
- `apps/desktop/tests/terminal-pty.integration.test.ts`
- 本条

未改：`idle-deliver.ts`、`cli-args.ts`、`hook-launch.ts`、`codex-claim.ts`。未改 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `pnpm lint`：通过。Biome 760 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- 相关单测一次：`workbench-memory`、`workbench-deliver-hint`、`command-ipc`、`terminal-pty.integration`、`process` 共 5 个文件，111 过 / 1 跳过。
- 偶发相关 3 个文件连续 5 次：每次 100 过 / 1 跳过，全部通过。
- 受影响 e2e：`workbench-cli.spec.ts` 里「Codex notify 的 agent-turn-complete 之后才自动投递」1 过（约 16 秒，含构建）。

### 问题与遗留

丙类 3 条（第 3、5、6 条）需要 Tony 决定，推荐都是已知并接受。未提交。

### 相关文件链接

- 计划 §9.3、§7.4
- 验收出处：`docs/验收记录/T10.10-验收.md` §7、`docs/验收记录/T10.7b-验收.md` §4、`docs/验收记录/T10.6-验收.md` §10.4 / §10.7、`docs/开发进度.md` T10.4 认领残余与统一验收偶发测试

## 2026-10-01 20:58 · T10.15 · 提交 · v0.10.17

### 任务要点

检查通过，没有必须修。按 §7.2 第 4 步提交。版本 `0.10.16` → `0.10.17`。丙类 3 条标为待 Tony 决定，不挡这次提交。轻量 tag `v0.10.17`，不 push。

### 结论

已提交并打轻量 tag `v0.10.17`，未 push。丙类 3 条仍要 Tony 决定，推荐都是已知并接受。下一步 Phase 10 终验。

### 改动文件

版本：根与 `apps/desktop` 的 `package.json`、README 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo。
进度与计划：`docs/开发进度.md` 登记 T10.15 ✅；已处理的残余标为已处理；甲类标为已知并接受；丙类标为待 Tony 决定。计划 §4 增加 T10.15 行，§9 总表 T10.15 标 ✅ 并注明丙类待定，§7.5 当前版本改为 0.10.17。
另含本任务的实现、测试、验收记录和此前的执行 / 检查条目。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `pnpm lint`：通过。Biome 760 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/command-ipc.test.ts apps/desktop/tests/client-server.test.ts`：2 个文件，73 过。
- 提交信息：`fix: T10.15 加固残余风险`
- 轻量 tag `v0.10.17`，未 push

### 问题与遗留

丙类 3 条待 Tony 决定：权限摘要减穿；工作台 Codex 窗口替换用户 notify；同目录极短时间双开认领超时。推荐都是已知并接受。验收建议：记忆索引第一次对账仍会整份读文件，不挡。

### 相关文件链接

- [T10.15 验收记录](../验收记录/T10.15-验收.md)
- 检查：[2026-10-01 20:54 · T10.15 · 检查 · 加固](./Phase10-对话总记录.md)
- 执行：[2026-10-01 20:32 · T10.15 · 执行 · 加固](./Phase10-对话总记录.md)

## 2026-10-01 20:54 · T10.15 · 检查 · 加固

### 任务要点

独立检查 T10.15 加固。不改实现。核对甲乙丙分类，乙类做反向探针，丙类确认没被偷偷实现，并完整跑 lint、desktop typecheck、`pnpm test`、`pnpm smoke`、`pnpm test:e2e`。版本仍是 0.10.16，未提交。

### 结论

裁定：**通过**。必须修复 0 条。建议 1 条，不挡：记忆索引第一次打开时的对账仍会整份读超大文件，交回窗口的正文已经截过。

甲第 1 条只写了计划，没有改记忆授权或签名。乙第 2 条超限只返回开头并带说明，上限内仍是全文；拿掉上限后能读到尾部标记，还原后用例恢复。乙项目窗口用现有记忆工具检索甲项目，拿不到。乙第 4 条只改了文案，中英文都写明会写回车、确认框还在时不要点这个按钮；改回旧句后单测变红，已还原。权限等待时立即发送仍被拒绝，未知状态仍允许手动发送，没有超时强写。乙第 7 条没有删测试、没有新跳过、没有放松断言，也没有用加长超时掩盖产品问题。丙第 3、5、6 条都还在：同摘要会减到 0；Codex 仍用自己的 notify，不读用户配置；认领仍约 120 秒，失败不走静默最近一条。

丙类 3 条需要 Tony 拍板。推荐都是已知并接受。

### 改动文件

- `docs/验收记录/T10.15-验收.md`（新建）
- 本条

未改实现。探针改过的文件已还原。探针脚本已删。未动 `apps/desktop/scripts/real-config-probe.mjs`。未把 `apps/desktop/out` 写进提交（本来也不提交）。

### 命令结果

- `pnpm lint`：通过。Biome 760 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：通过。143 个文件，2420 过 / 1 跳过。那 1 条是原有的「非 Windows 才解释为何跳过真 PTY」。
- `pnpm smoke`：通过。版本 0.10.16。
- `pnpm test:e2e`：通过。52 过，约 5.4 分钟。

### 问题与遗留

没有必须修复。建议：索引首次对账仍整份读文件，不挡这次。丙类 3 条待 Tony 决定，推荐都是已知并接受。未提交。

### 相关文件链接

- `docs/验收记录/T10.15-验收.md`
- 计划 §9.3、§7.3、§7.4
- 总记录「2026-10-01 20:32 · T10.15 · 执行 · 加固」

## 2026-10-01 22:22 · T10.15b · 执行 · 对话编号与权限配对

### 任务要点

按 §9.10 做对话编号和更保守的权限配对。先调研 Claude / Codex 能否在启动时指定编号。未提交。

### 结论

调研：本机 Claude Code 2.1.220 交互模式有 `--session-id <uuid>`，续接用 `--resume <id>`；不带编号的 `--resume` 打开选择器。本机 Codex 0.159.2 不能在启动时指定会话编号（`--help` 与官方未实现的 `--session-id` 请求都对得上）。`session_meta` 不存 `developer_instructions`，但首轮会把这段说明写进 rollout 的开发者消息。因此 Codex 用每个窗口独有的随机记号 `ffpane-claim:<uuid>` 接在本次 `developer_instructions` 末尾，只在 rollout 有限前缀里对这个记号，不按启动先后猜，不排队。对不上或记号撞车就标「编号未识别」，续接打开选择器，不用 `--last` / `--continue`。

实现：Claude 新开仍在启动时指定编号；开新对话换新编号；历史只记编号、开始时间、最后活动时间，最多 24 条。窗口上显示短编号（可复制），可续接当前、开新对话、从本窗口历史里选一段。续接管理者 / 全放开仍走原来的确认。§9.9 自动续接用这个编号；没有编号就不自动续接。没有 tool_use_id 的权限摘要不再被同摘要的 PostToolUse 减到 0，要等用户再发一句才清。提醒停住时多一句说明。

### 改动文件

- `packages/shared/src/domain/workbench.ts`
- `packages/storage/src/workbench/store.ts`
- `apps/desktop/src/main/workbench/codex-claim.ts`
- `apps/desktop/src/main/workbench/cli-args.ts`
- `apps/desktop/src/main/workbench/launch-cli.ts`
- `apps/desktop/src/main/workbench/idle-deliver.ts`
- `apps/desktop/src/main/workbench/handlers.ts`
- `apps/desktop/src/shared-ipc/contracts.ts`
- `apps/desktop/src/renderer/src/pages/workbench/conversation-launch.ts`
- `apps/desktop/src/renderer/src/pages/workbench/WindowPane.tsx`
- `apps/desktop/src/renderer/src/pages/workbench/TerminalView.tsx`
- `apps/desktop/src/renderer/src/stores/workbench.ts`
- `locales/zh-CN.json`、`locales/en-US.json`
- `apps/desktop/tests/codex-claim.test.ts`
- `apps/desktop/tests/conversation-id.test.ts`
- `apps/desktop/tests/workbench-idle-deliver.test.ts`
- `apps/desktop/tests/workbench-cli-args.test.ts`
- `apps/desktop/tests/e2e/workbench-cli.spec.ts`
- `packages/storage/tests/workbench-layouts.test.ts`
- 本条

未改 `apps/desktop/scripts/real-config-probe.mjs`。未读用户 `~/.codex` / `~/.claude`。

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- 相关单测：`codex-claim`、`conversation-id`、`workbench-idle-deliver`、`workbench-cli-args`、`workbench-deliver-hint` 共 5 个文件，61 过。布局单测 6 过。
- 受影响 e2e：`workbench-cli.spec.ts` 与 `model-effort.spec.ts`。首跑 9 过、三条编号那条超时只见到 2 个编号；改成逐个等认领后再开下一个，复跑该条通过（约 7 秒）。自动续接两条也过。

### 问题与遗留

没有需要主控拍板的做法。未提交。下一步独立检查。

### 相关文件链接

- 计划 §9.10、§9.9、§7.3、§7.4
- 总记录「2026-10-01 20:32 · T10.15 · 执行 · 加固」第 3、6 条

## 2026-10-01 22:45 · T10.15b · 检查 · 对话编号与权限配对

### 任务要点

独立检查 T10.15b。对照计划 §9.10、§9.9、§7.4，以及总记录「2026-10-01 22:22 · T10.15b · 执行 · 对话编号与权限配对」。不改实现。探针用完已删，改过的源码已按原字节还原。

### 结论

有条件通过。必须修复 1 条：同一记号出现在两份 rollout 里时，若其中一份还带了别的记号，仍会认那份只有该记号的文件。两份都只有同一记号时不会挑。同目录 5 个 Codex 按记号一次认完，不排队。识别失败只开选择器，没有 `--last` 或 `--continue`。管理者和全放开第一次续接要确认。窗口令牌不进 argv、日志、文件。原来的摘要减穿不再提前投递。不需要主控另选做法。未提交。

### 改动文件

- `docs/验收记录/T10.15b-验收.md`
- 本条

未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：通过。144 个文件，2427 过，1 跳过。
- `pnpm smoke`：通过。应用版本 0.10.17。
- `pnpm test:e2e`：通过。53 过，约 5.7 分钟。

### 问题与遗留

必须修复 1 条，见验收记录第 2 节。建议 1 条：同一次进程里确认过之后不再问。没有要主控拍板的决定。未提交。

### 相关文件链接

- `docs/验收记录/T10.15b-验收.md`
- 计划 §9.10、§9.9、§7.4
- 总记录「2026-10-01 22:22 · T10.15b · 执行 · 对话编号与权限配对」

## 2026-10-01 22:47 · T10.15b · 修复 · 记号撞车

### 任务要点

检查必须项：同一记号出现在两份 rollout 时，即使其中一份还带了别的记号，也不得认领。

### 结论

前缀里只要出现这个记号就计入份数。多于一份就标未识别，两份都不认。唯一一份里如果还混着别的记号，也不认。

### 改动文件

- `apps/desktop/src/main/workbench/codex-claim.ts`
- `apps/desktop/tests/codex-claim.test.ts`
- 本条

### 命令结果

- `vitest run tests/codex-claim.test.ts`：19 过。

### 问题与遗留

未提交。等复验。

### 相关文件链接

- `docs/验收记录/T10.15b-验收.md`
- 总记录「2026-10-01 22:45 · T10.15b · 检查 · 对话编号与权限配对」

## 2026-10-01 22:51 · T10.15b · 复验 · 记号撞车

### 任务要点

独立复验必须项：同一记号出现在两份 rollout 时，即使其中一份还带了别的记号，也不得认领任一份。

### 结论

通过。必须修复已不在。隔离目录里，干净文件和多记号文件都含同一记号时，挑选为撞车，认领返回未识别，两份都不进入已认领集合。不需要主控决策。

### 改动文件

- `docs/验收记录/T10.15b-验收.md`（末尾追加「复验」，首验正文未改）
- 本条

未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`。

### 命令结果

- `vitest run tests/codex-claim.test.ts`（`apps/desktop`）：通过。与隔离探针同跑，2 个文件 20 过。探针已删。未重跑全套 test / smoke / e2e。

### 问题与遗留

必须项关闭。建议（非阻断）仍在：同一次进程里确认过之后不再问。未提交。

### 相关文件链接

- `docs/验收记录/T10.15b-验收.md`
- 总记录「2026-10-01 22:47 · T10.15b · 修复 · 记号撞车」

## 2026-10-01 22:53 · T10.15b · 提交 · v0.10.18

### 任务要点

复验通过。按 §7.2 第 4 步提交。版本 `0.10.17` → `0.10.18`。轻量 tag `v0.10.18`，不 push。

### 结论

已提交并打轻量 tag `v0.10.18`，未 push。下一步 Phase 10 终验。不需要主控决策。

### 改动文件

版本：根与 `apps/desktop` 的 `package.json`、README 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo。
进度与计划：`docs/开发进度.md` 登记 T10.15b ✅；权限摘要减穿、同目录双开认领标为已处理；Codex notify 替换标为 Tony 已接受。计划 §4、§9 增加 T10.15b 并标 ✅，§7.5 当前版本改为 0.10.18，下一步为 Phase 10 终验。
另含本任务的实现、测试、验收记录和此前的执行 / 检查 / 修复 / 复验条目。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run tests/command-ipc.test.ts tests/client-server.test.ts tests/codex-claim.test.ts`：3 个文件，92 过。
- 提交信息：`feat: T10.15b 对话编号与权限配对加固`
- 轻量 tag `v0.10.18`，未 push

### 问题与遗留

没有必须修复。没有要主控拍板的决定。下一步 Phase 10 终验。

### 相关文件链接

- [T10.15b 验收记录](../验收记录/T10.15b-验收.md)
- 复验：[2026-10-01 22:51 · T10.15b · 复验 · 记号撞车](./Phase10-对话总记录.md)

## 2026-10-02 02:30 · Phase10 · 终验

### 任务要点

独立终验，范围 `v0.10.12` 到 HEAD `487ace5`（tag `v0.10.18`）。对照计划 §8、§9 和 §7.4，重跑关键反向探针，完整跑 lint / typecheck / test / smoke / e2e，并做临时目录打包冒烟。不改实现，不改版本，不打 tag，不提交。

### 结论

有条件通过。1 项必须修：保存布局和冷启动写回会丢掉窗口上的模型 / 思考强度覆盖，以及本窗口的对话历史。忙时排队的自动续接因此带不上新值。不需要另选产品方案。未提交。

### 改动文件

- 新增 `docs/验收记录/Phase10-终验.md`
- 本条追加进 `docs/对话记录/Phase10-对话总记录.md`

未改 `docs/开发进度.md` 和计划。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。探针文件已删。

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：**2428 过 / 1 跳过**。首跑通过。
- `pnpm smoke`：11 项 ALL PASS。FF-pane v0.10.18。
- `pnpm test:e2e`：首跑 52 过 / 1 失败。失败项是管理者起草配置的排队确认框超时。单独重跑该文件 1 过。
- 反向探针：6 项通过，冷启动保住覆盖和历史失败。探针已删。
- `electron-builder --dir` 到系统临时目录：成功。`FF-pane.exe --smoke` ALL PASS，版本 0.10.18。临时目录已删。

### 问题与遗留

必须修：`applyAuthNode` 写回布局时丢掉 `modelOverride`、`effortOverride`、`conversations`、`sessionUnidentified` 和连法显示字段。`keepModelEffortOverrides` 补回去之后又被剥掉。详见验收记录。

e2e 偶发：`config-tool-workbench.spec.ts` 排队草案取消后 15 秒内对话框没有换到下一份。安静重跑通过。

各任务未做掉的建议已去重写进验收记录。没有要主控拍板的产品分叉。

### 相关文件链接

- [Phase 10 终验](../验收记录/Phase10-终验.md)

## 2026-10-02 04:15 · Phase10 · 终验 · 修复 · 布局写回保留覆盖与历史

### 任务要点

终验必须修：冷启动和保存布局写回时，把窗口上的连法、模型与思考强度覆盖、对话历史留在原窗口上。权限和父子关系仍以主进程登记为准。旧档案 id 继续不写入。不提交。

### 结论

写回已保留这些字段。相关单测和这次点名的 e2e 通过。终验裁定仍是有条件通过，这次没有改验收记录，也没有重跑全套 test / smoke。未提交。

### 改动文件

- `apps/desktop/src/main/workbench/auth-registry.ts`
- `apps/desktop/tests/workbench-auth-registry.test.ts`

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件，无修复。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- 受影响 e2e（先 `electron-vite build`）：4 过。
  - `model-effort.spec.ts`：管理者改工作者强度，空闲后自动续接并带上新强度。
  - `model-effort.spec.ts`：改管理者自己时先确认，点确认后才续接。
  - `workbench-cli.spec.ts`：Codex 按记号认领会话，续接 argv 为 resume \<id\>。
  - `workbench-cli.spec.ts`：同目录三个 Codex 各自认出编号，开新对话后能从历史续接。
- 此前 `workbench-auth-registry.test.ts`：14 过，含冷启动、再次同步、写入布局后再读出。

### 问题与遗留

没有新的必须修。终验里其余建议和已知并接受的事项没动。未提交。

## 2026-10-02 04:37 · Phase10 · 终验 · 复验

### 任务要点

复验布局写回修复。重跑冷启动、再次同步、写入后再读出，并补「忙时排队 → 冷启动 → 空闲后续接，启动参数带新值」。查草案确认框那次失败：连续跑 5 次，并看排队代码。最后完整跑 lint、typecheck、test、smoke、e2e 和临时目录打包冒烟。另用本机命令行做一次最低消费核对。不提交。

### 结论

通过。覆盖、历史、未识别标记、连法显示都留在布局里。权限和父子关系仍按主进程登记。旧档案 id 不写入。忙时排队后的续接参数是新模型和新强度。草案确认失败是测试时序，不是产品缺陷。未提交。

### 改动文件

只追加本条和 `docs/验收记录/Phase10-终验.md` 末尾的「## 复验」。未改实现，未改上文。

### 命令结果

- 复验探针：2 过。已删。
- `config-tool-workbench.spec.ts`：连续 5 次都过。
- `pnpm lint`：通过。Biome 762。`check-i18n` PASS。
- desktop typecheck：通过。
- `pnpm test`：2429 过 / 1 跳过。
- `pnpm smoke`：11 项 ALL PASS。v0.10.18。
- `pnpm test:e2e`：53 过。
- 打包冒烟：`FF-pane.exe --smoke` ALL PASS，v0.10.18。临时目录已删。
- 本机 Codex 一次：`gpt-5.6-luna`，强度 `low`，回复 `ok`，约 2974 token。
- 本机 Claude：`haiku` 与 `sonnet` 加 `--effort low` 均 403，费用 0。没有再换更贵模型。

### 问题与遗留

没有新的必须修。Claude 打印模式在这台机器上返回 403，登录状态仍是已登录。不挡这次裁定。未提交。

### 相关文件链接

- [Phase 10 终验](../验收记录/Phase10-终验.md)

## 2026-10-02 04:51 · Phase10 · 终验 · 提交 · v0.10.19

### 任务要点

复验通过。按 §7.2 第 4 步提交。版本 `0.10.18` → `0.10.19`。轻量 tag `v0.10.19`，不 push。

### 结论

已提交并打轻量 tag `v0.10.19`，未 push。下一步交 Tony 试用。不需要主控决策。

### 改动文件

版本：根与 `apps/desktop` 的 `package.json`、README 状态行、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo。
实现：布局写回保留连法、模型与思考强度覆盖、对话历史和未识别标记。
进度与计划：`docs/开发进度.md` 登记 Phase 10 终验 ✅，并写入未处理建议和已知并接受事项。计划 §7.5 当前版本改为 0.10.19，下一步交 Tony 试用。§9 总表终验标 ✅，tag `v0.10.19`。
另含终验记录和此前的终验 / 修复 / 复验条目。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `pnpm lint`：通过。Biome 762 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run tests/command-ipc.test.ts tests/client-server.test.ts tests/workbench-auth-registry.test.ts`：3 个文件，87 过。
- 提交信息：`fix: Phase 10 终验 布局写回保留覆盖与对话历史`
- 轻量 tag `v0.10.19`，未 push

### 问题与遗留

没有新的必须修。未处理建议和已知并接受事项已写入开发进度。下一步交 Tony 试用。

### 相关文件链接

- [Phase 10 终验](../验收记录/Phase10-终验.md)

## 2026-10-06 16:39 · T10.16 · 调研 · Grok 窗口

### 任务要点

按计划 §10 先查、不写实现。只看本机 `grok --help`、官方文档和 `docs/adapters/grok-build.md`。确认能不能在启动这一个工作台窗口时带上 MCP，而且不改用户 `~/.grok`、不在项目目录留下 `.grok`。不调用模型。

### 结论

不能。停下，没有改代码。

本机是 `grok 1.0.13`（`C:\Users\admin\.grok\bin\grok.exe`）。工作台窗口要启动的是交互式 `grok`（和 Claude、Codex 一样的终端窗口）。这条命令没有「只给这一个进程」的 MCP 参数：`grok --help` 里没有 `--plugin-dir`、`--mcp-config` 或临时配置路径；实测 `grok --plugin-dir` 报 `unexpected argument '--plugin-dir'`。

`grok mcp add --scope` 只有两档，帮助写明都会落盘：`user` 写 `~/.grok/config.toml`，`project` 写 `./.grok/config.toml`。两条都是本单禁止的。官方文档 [MCP Servers](https://docs.x.ai/build/features/mcp-servers) 同样只写这两处，另外还会读 `~/.claude.json`、`.cursor/mcp.json` 和项目 `.mcp.json`。写这些也会改用户全局配置，或在项目里留文件。

`grok agent --plugin-dir <DIR>` 的帮助写明「仅本进程，MCP 会直接启用」。但 `grok agent` 是不带交互界面的子命令，下面只有 `stdio` / `headless` / `serve` / `leader`，不是用户在窗口里打字的那条命令。官方插件说明也把 `--plugin-dir` 限定在 agent 进程，不包含交互式窗口。

`GROK_HOME` 会把配置、登录态和会话整份搬走，`docs/adapters/grok-build.md` §7.4 已否决，本单不用。ACP `session/new` 的 `mcpServers` / `_meta.pluginDirs` 是非交互协议，旧文档写明形状未实测，也不是工作台这个 PTY 窗口。未调用模型，未做注入试验。

按 §10：不要改成写用户配置或项目目录。请 Tony 定下一步。

### 改动文件

无实现改动。只追加本条。

### 命令结果

- `grok --version`：`grok 1.0.13 (5e9a58528b76) [stable]`
- `grok --help`：交互式命令无 MCP / plugin-dir / 临时配置参数。有 `grok mcp` 子命令。
- `grok --plugin-dir`：退出码 2，`unexpected argument '--plugin-dir'`
- `grok mcp add --help`：`--scope` 仅 `user`（`~/.grok/config.toml`）或 `project`（`./.grok/config.toml`），默认 user
- `grok agent --help`：`--plugin-dir` 仅在此子命令；说明为仅本进程。子命令为 stdio / headless / serve / leader
- `grok agent --plugin-dir`：退出码 2，缺目录参数（说明参数存在），未启动、未调用模型
- 官方文档：https://docs.x.ai/build/features/mcp-servers ，https://docs.x.ai/build/features/skills-plugins-marketplaces ，https://docs.x.ai/build/cli/reference

### 问题与遗留

当前本机 Grok 不能在启动这一个交互窗口时带上工作台工具，同时守住「不改 `~/.grok`、不在项目留 `.grok`」。实现未开始。需要 Tony 决定：继续挂起 Grok，还是接受改用户配置 / 项目目录 / 换非交互的 `grok agent` 路径。

### 相关文件链接

- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)
- [Grok 适配器说明](../adapters/grok-build.md)

## 2026-10-07 01:52 · T10.16 · 执行 · Grok 窗口

### 任务要点

按 §10 把 Grok 接进工作台：配置多一路（本机登录或中转），启动时合并写入项目 `.grok/config.toml`，令牌只放进程环境。不提交。

### 结论

做完了。本机 `grok 1.0.13` 会展开占位，所以令牌没有写进文件。

官方文档写明 `[mcp_servers]` 的 `env` 在加载时展开 `${VAR}`，项目 `.grok/config.toml` 会读这一段。帮助里交互式 `grok` 有 `--session-id`，新开窗口由软件指定对话编号，并行不排队。没有编号时不用空的 `--resume`（那个会接最近一条），改从本窗口历史里选。

中转没有现成能给 Grok 用的来源模板，补了只给 Grok 的「Grok 中转」（地址和密钥必填）。密钥进 `XAI_API_KEY`，地址进 `GROK_MODELS_BASE_URL`，都不进配置文件。角色说明走 `--rules`。Grok 没有可靠的回合结束信号，投递要手动点发送。版本仍是 1.0.0，末位 +1 留给提交那一步。

### 改动文件

配置与窗口：项目配置增加 Grok 一路；新建窗口、管理者开子窗口、重启和续接都走这一路。来源模板 `grok-compatible`。权限参数：只读 `plan`，可改 / 可改+跑命令都是 `acceptEdits`（Grok 没有单独禁命令的档），全放开 `--always-approve`。

工具文件：启动时合并项目 `.grok/config.toml`。工作台工具始终写入。知识库、自配置看项目开关。自配置调用时非管理者会被拒绝。退出不删文件。`.grok/` 已加入仓库忽略列表。不写 `~/.grok`、`~/.claude.json`、`.cursor/mcp.json`、项目 `.mcp.json`。

说明：中英文语言包、`使用说明.md`。计划 §7.5 里「不能在项目留 .grok」已改成 Tony 选定的写法。

### 命令结果

- `pnpm lint`：通过。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- 单测：`grok-mcp-config`、`workbench-grok-launch`、`mcp-config-tool`、`workbench-permission`（快照已更新）、`provider-injection`、`domain`、`project-configs` 通过。
- e2e：`tests/e2e/workbench-grok.spec.ts` 通过。假的 grok 开得出窗口，项目里有 `.grok/config.toml`，文件里是占位符，没有令牌明文。测例在 PATH 前面放了同名 exe，避免启动本机真的 `grok.exe`。

### 问题与遗留

Grok 的「可改文件」和「可改+跑命令」启动参数相同，命令仍由 Grok 自己询问。没有不接最近一条的命令行选择器。回合结束要手动发送。版本号留到提交时改为 1.0.1。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。

### 相关文件链接

- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)
- [使用说明](../../使用说明.md)

## 2026-10-07 11:02 · T10.16 · 检查 · Grok 窗口

### 任务要点

独立检查未提交的 T10.16。对照计划 §10、§7.3、§7.4，以及总记录「2026-10-07 01:52 · T10.16 · 执行 · Grok 窗口」。审查未提交改动，做反向探针，完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。不碰 `apps/desktop/scripts/real-config-probe.mjs`。不改 `~/.grok`、`~/.claude`、`~/.codex`。

### 结论

通过。配置有 Grok 一路，默认不勾。只合并项目 `.grok/config.toml`，不写 `~/.grok`、`~/.claude.json`、`.cursor/mcp.json`、项目 `.mcp.json`。令牌只有占位符。知识库和自配置看项目开关，非管理者调用自配置会被拒绝。退出不删文件。`.grok/` 在忽略列表里。新开、子窗口、重启和续接都走这一路。使用说明里的四句和事实一致。

执行者的三点都属实，没有破坏安全规矩：可改文件和可改+跑命令的启动参数相同，命令仍询问；没有编号时不起进程，不用空的 `--resume`；没有回合结束信号，不会超时强写，要点立即发送。

不需要主控决策。版本仍是 1.0.0，末位 +1 留到提交。

### 改动文件

- 新增 `docs/验收记录/T10.16-验收.md`
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 766 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：146 个文件，2444 过，1 跳过。
- `pnpm smoke`：ALL PASS。`FF-pane v1.0.0`。pdfjs 缺 canvas 的警告在 PASS 之前。
- `pnpm test:e2e`：53 过，1 失败。失败是 Grok 用例超过 60 秒，另有一次工作进程清理超时。单独重跑 `tests/e2e/workbench-grok.spec.ts`：1 过，10.2 秒。

### 问题与遗留

- 未提交。未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.grok`、`~/.claude`、`~/.codex`。未跑消耗额度的命令。探针已删。核对用户目录时只比较了修改时间和大小，没有打开内容。
- 建议不挡：使用说明补一句 Grok 两档权限参数相同；黄条补上立即发送会写回车；全量 e2e 的 Grok 超时先单独重跑。
- 工作区里若干旧验收记录和 `docs/Provider-模板说明.md` 只有换行警告、diff 没有正文。提交时不要带上。

### 相关文件链接

- [T10.16 验收记录](../验收记录/T10.16-验收.md)
- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)
- 执行：[2026-10-07 01:52 · T10.16 · 执行 · Grok 窗口](./Phase10-对话总记录.md)

## 2026-10-07 11:40 · T10.16 · 提交 · v1.0.1

### 任务要点

按计划 §7.2 第 4 步提交 T10.16。版本 `1.0.0` → `1.0.1`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.16 已验收，并写下验收留下的三点。计划 §4 保持 T10.8 挂起，另加 T10.16 行；§7.5 当前版本改为 1.0.1。轻量 tag `v1.0.1`，不 push。

### 结论

已提交并打轻量 tag `v1.0.1`，未 push。验收没有必须修复。不需要主控决策。

### 改动文件

暂存并提交（不含 `apps/desktop/scripts/real-config-probe.mjs`，不含只有换行符变化的旧验收记录和 `docs/Provider-模板说明.md`）：

- 版本：根与 `apps/desktop` 的 `package.json`、`README.md`、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- 实现与测试：Grok 配置一路、项目 `.grok/config.toml` 合并、启动 / 子窗口 / 续接、语言包、使用说明、`.gitignore`
- 进度与计划：`docs/开发进度.md`、`docs/Phase10-多窗口终端工作台计划.md`
- `docs/验收记录/T10.16-验收.md`
- 本总记录

### 命令结果

- `pnpm lint`：通过。Biome 766 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run tests/command-ipc.test.ts tests/client-server.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.16 工作台接入 Grok 窗口`
- 轻量 tag `v1.0.1`，未 push
- 提交哈希：`74995a267318260b9653dd41882cec635806002c`

### 问题与遗留

验收留下的三点已写入开发进度：Grok 两档权限启动参数相同；没有不接最近一条的选择器；没有回合结束信号，要手动发送。历史记录里的 `1.0.0` 没有改。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。旧验收记录和 `docs/Provider-模板说明.md` 只有换行符变化，没有提交。上面的提交哈希是 tag `v1.0.1` 所指的那一笔；这一行是后补的，所以 tag 里的本条仍写着「打 tag 之后补进本条」。

### 相关文件链接

- [T10.16 验收记录](../验收记录/T10.16-验收.md)
- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)

## 2026-10-07 14:23 · T10.17 · 执行 · DeepSeek 窗口

### 任务要点

按计划 §11、§7.3、§7.4 做 DeepSeek 窗口。Tony 已定用本机 Claude Code 连接，不用 Codex。先只查官方文档、不调用模型。查到地址再实现，地址做默认值。不提交。不碰 apps/desktop/scripts/real-config-probe.mjs。不读写 ~/.aiworkbench，不改 ~/.claude、~/.codex、~/.grok。

### 结论

做完了。官方文档写明，给 Claude Code 用的地址是 https://api.deepseek.com/anthropic（[Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)，[Using the Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)）。密钥用 ANTHROPIC_AUTH_TOKEN。没有改回 Codex。

来源模板「DeepSeek」：地址默认就是这个，可以改；密钥必填；模型手填。项目配置多一路 DeepSeek，默认不勾。没配这一路不能开窗口。本机登录这一档对 DeepSeek 不开放。

新建窗口、管理者开子窗口、重启和续接都能选 DeepSeek。实际启动的是本机 claude：权限参数、工作台工具、对话编号（--session-id / --resume）都走 Claude。密钥和地址只进这个进程的环境变量，不写用户的 Claude 配置。窗口标题和种类显示 DeepSeek，不是普通 Claude。思考强度仍用 Claude 的 --effort。用户填了模型时，同时写入 ANTHROPIC_MODEL 和官方文档里的 opus / sonnet / haiku / 子代理模型变量，避免 Claude 再换成别的名字。

中英文语言包和仓库根目录使用说明已同步：选 DeepSeek，填密钥和模型；窗口里是 Claude 的界面，模型是 DeepSeek。版本仍是 1.0.1，提交时再升到 1.0.2。不需要主控决策。

### 改动文件

- 来源与配置：packages/shared 的 provider、模板、项目配置、窗口种类；packages/storage 的配置读写；packages/core 的注入表
- 启动：launch-cli、resolve-config、open-child、handlers、MCP 开窗口与自配置草案
- 界面：新建窗口、窗口标题、配置编辑、中英文语言包、使用说明.md
- 测试：workbench-deepseek-launch.test.ts、project-config.test.ts、e2e/workbench-deepseek.spec.ts

### 命令结果

- pnpm lint：通过。Biome 768 个文件。check-i18n PASS。
- pnpm --filter @ff-pane/shared --filter @ff-pane/core --filter @ff-pane/storage build：通过（typecheck 读的是各包 dist）。
- pnpm --filter @ff-pane/desktop run typecheck：通过。
- vitest：workbench-deepseek-launch、project-config、mcp-config-tool、domain、project-configs、provider-injection 共 6 个文件，112 过（修断言后 deepseek 启动 4 过、选路 2 过）。
- e2e tests/e2e/workbench-deepseek.spec.ts：1 过，9.1 秒。假 claude 开出 data-window-kind=deepseek，回放里有 Claude 参数、官方地址、deepseek-chat，密钥只显示 present。

### 问题与遗留

未提交。版本号留在 1.0.1。未改 apps/desktop/scripts/real-config-probe.mjs。未读写 ~/.aiworkbench，未改 ~/.claude、~/.codex、~/.grok。未调用模型。官方文档里的 CLAUDE_CODE_EFFORT_LEVEL 和自动压缩窗口没有照抄进环境变量，思考强度仍走 Claude 的 --effort。

### 相关文件链接

- [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)
- [Using the Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [Phase 10 计划 §11](../Phase10-多窗口终端工作台计划.md)

## 2026-10-07 15:33 · T10.17 · 检查 · DeepSeek 窗口

### 任务要点

独立检查未提交的 T10.17。对照计划 §11、§7.3、§7.4，以及总记录「2026-10-07 14:23 · T10.17 · 执行 · DeepSeek 窗口」。审查未提交改动，做反向探针，完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。不碰 `apps/desktop/scripts/real-config-probe.mjs`。不改 `~/.claude`、`~/.codex`、`~/.grok`。

### 结论

有条件通过，1 项必须修。启动的是本机 Claude，不是 Codex。默认地址是 `https://api.deepseek.com/anthropic`。没配这一路时，对话框、管理者开子窗口、重启都会拒绝。密钥和地址只在这个进程的环境里，探针期间没有改用户的 `~/.claude`、`~/.codex`、`~/.grok`。窗口显示 DeepSeek。管理者开子窗口、重启和续接也走这一路。使用说明里「窗口里是 Claude 的界面，模型是 DeepSeek」和事实一致。

必须修：删除来源时只检查了 Claude、Codex、Grok，没算 DeepSeek。来源和密钥会被删掉，配置里这一路还指着它。

要主控决策：使用说明和语言包的模型例子仍是计划里的 `deepseek-chat` / `deepseek-reasoner`。今天打开的官方文档示例已是 `deepseek-flash` 一类名字。软件不写死模型。

### 改动文件

- 新增 `docs/验收记录/T10.17-验收.md`
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 768 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：147 个文件，2448 过，1 跳过。
- `pnpm smoke`：ALL PASS。`FF-pane v1.0.1`。pdfjs 缺 canvas 的警告在 PASS 之前。
- `pnpm test:e2e`：55 过，约 5.7 分钟。含 `workbench-deepseek.spec.ts`。没有单独重跑。

### 问题与遗留

- 未提交。未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`、`~/.grok`。未跑消耗额度的命令。探针已删。核对用户目录时只比较了修改时间和大小，没有打开内容。
- 必须修：`configReferencesProvider` 漏了 DeepSeek。
- 建议不挡：配置卡片摘要没列出 DeepSeek；官方示例里的 `CLAUDE_CODE_EFFORT_LEVEL` 和自动压缩窗口没有写入，思考强度仍走 `--effort`；真 `claude` 仍可能把会话记在 `~/.claude`，软件没有改配置目录。
- 工作区里若干旧验收记录和 `docs/Provider-模板说明.md` 只有换行警告、diff 没有正文。提交时不要带上。

### 相关文件链接

- [T10.17 验收记录](../验收记录/T10.17-验收.md)
- [Phase 10 计划 §11](../Phase10-多窗口终端工作台计划.md)
- 执行：[2026-10-07 14:23 · T10.17 · 执行 · DeepSeek 窗口](./Phase10-对话总记录.md)

## 2026-10-07 15:43 · T10.17 · 修复 · DeepSeek 窗口

### 任务要点

按验收「必须修复」和计划 §11 末尾的模型例子决定。不提交。

1. 删除来源时把 DeepSeek 这一路算进「还在用」。还有配置指着它，就不能删，密钥也不会被清掉。
2. 使用说明和中英文语言包的模型例子改成 `deepseek-flash`、`deepseek-v4-pro`。不写死，手填仍有效。

### 结论

两处都改了。`configReferencesProvider` 现在也会看 DeepSeek 的来源。设置页删除来源时，只要有配置的 DeepSeek 路指着它，就会拒绝删除，后面的清密钥不会执行。模型输入框仍是手填，例子换成官方现在的两个名字。

### 改动文件

- `packages/storage/src/project-configs/store.ts`
- `packages/storage/tests/project-configs.test.ts`
- `使用说明.md`
- `locales/zh-CN.json`、`locales/en-US.json`

### 命令结果

- `pnpm lint`：通过。Biome 768 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/storage build`：通过。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run packages/storage/tests/project-configs.test.ts`：1 个文件，7 过。含「只有 DeepSeek 引用的来源也算还在用」。

### 问题与遗留

未提交。未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`、`~/.grok`。配置卡片摘要仍不列出 DeepSeek，验收里这一条是建议，这次没改。不需要主控决策。

### 相关文件链接

- [T10.17 验收记录](../验收记录/T10.17-验收.md)
- [Phase 10 计划 §11](../Phase10-多窗口终端工作台计划.md)

## 2026-10-07 15:59 · T10.17 · 复验 · DeepSeek 窗口

### 任务要点

复验 T10.17 必须项和模型例子。对照总记录「2026-10-07 15:43 · T10.17 · 修复 · DeepSeek 窗口」，以及计划 §11 已定的例子 `deepseek-flash`、`deepseek-v4-pro`。删掉仍被 DeepSeek 使用的来源应被拒绝，密钥还在；没有任何配置引用时才能删。上一轮通过的探针不能被修坏。最后一轮完整跑 lint / desktop typecheck / `pnpm test` / `pnpm smoke` / `pnpm test:e2e`。不改实现，不提交。

### 结论

通过。必须项已补上：还有配置的 DeepSeek 路指着这个来源时，删除被拒绝，密钥还能读出来；拿掉引用之后才能删，密钥随之清掉。使用说明和中英文语言包的例子已换成 `deepseek-flash`、`deepseek-v4-pro`，仍是手填。上一轮的启动、拒绝和普通 Claude 不被改去连 DeepSeek，都还在。不需要主控决策。

### 改动文件

- `docs/验收记录/T10.17-验收.md` 末尾追加「复验」
- 本条追加到总记录

### 命令结果

- `pnpm lint`：通过。Biome 768 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：147 个文件，2449 过，1 跳过。
- `pnpm smoke`：ALL PASS。`FF-pane v1.0.1`。pdfjs 缺 canvas 的警告在 PASS 之前。
- `pnpm test:e2e`：55 过，约 5.5 分钟。含 `workbench-deepseek.spec.ts`。没有单独重跑。

### 问题与遗留

未提交。未改实现，未改 `apps/desktop/scripts/real-config-probe.mjs`。未读写 `~/.aiworkbench`，未改 `~/.claude`、`~/.codex`、`~/.grok`。未跑消耗额度的命令。探针已删。核对用户目录时只比较了修改时间和大小，没有打开内容。配置卡片摘要仍不列出 DeepSeek，仍是建议，不挡。版本仍是 1.0.1。

### 相关文件链接

- [T10.17 验收记录](../验收记录/T10.17-验收.md)
- [Phase 10 计划 §11](../Phase10-多窗口终端工作台计划.md)
- 修复：[2026-10-07 15:43 · T10.17 · 修复 · DeepSeek 窗口](./Phase10-对话总记录.md)

## 2026-10-07 16:29 · T10.17 · 提交 · v1.0.2

### 任务要点

按计划 §7.2 第 4 步提交 T10.17。版本 `1.0.1` → `1.0.2`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.17 已验收。计划 §4 增加 T10.17 行，§7.5 当前版本改为 1.0.2。轻量 tag `v1.0.2`，不 push。

### 结论

已提交并打轻量 tag `v1.0.2`，未 push。复验已通过。不需要主控决策。

### 改动文件

- 版本：根与 `apps/desktop` 的 `package.json`、`README.md`、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- 实现与测试：DeepSeek 来源模板、项目配置一路、用本机 Claude 启动、删除来源时算「还在用」、语言包、使用说明
- 进度与计划：`docs/开发进度.md`、`docs/Phase10-多窗口终端工作台计划.md`
- `docs/验收记录/T10.17-验收.md`
- 本总记录

### 命令结果

- `pnpm lint`：通过。Biome 768 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/command-ipc.test.ts apps/desktop/tests/client-server.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.17 DeepSeek 窗口经 Claude 连接`
- 轻量 tag `v1.0.2`，未 push
- 提交哈希：`c5bc103d94b11b2b3b20f4270fd0684b3b4e3e9c`

### 问题与遗留

历史记录里的 `1.0.1` 没有改。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。旧验收记录和 `docs/Provider-模板说明.md` 只有换行符变化，没有提交。配置卡片摘要仍不列出 DeepSeek，验收里是建议，不挡。上面的提交哈希是 tag `v1.0.2` 所指的那一笔；这一行是后补的，所以 tag 里的本条仍写着「打 tag 之后补进本条」。

### 相关文件链接

- [T10.17 验收记录](../验收记录/T10.17-验收.md)
- [Phase 10 计划 §11](../Phase10-多窗口终端工作台计划.md)

## 2026-10-07 17:17 · T10.18 · 执行 · Grok 回合结束通知

### 任务要点

交互式 Grok 窗口在一轮说完后，要像 Claude 一样收到「有新消息」并继续。正在等权限批准时不能按回车。没有信号时仍只允许手动发送，不超时强写。先核对官方钩子说明和本机 grok 1.0.13，不调用模型。

### 结论

停下，没有改启动，也没有改成看屏幕猜它停了。

本机 `grok 1.0.13`（`5e9a58528b76`）里，回合事件和 `--trust` 都在。随包 `~/.grok/docs/user-guide/10-hooks.md` 和二进制都能对上：`Stop`、`StopFailure`、`StopCancelled`、`PermissionDenied`，以及 `Notification` 的 `permission_prompt`。未知参数 `grok --not-a-real-flag -h` 退出码 2；`grok --trust -h` 退出码 0。`--help` 正文不列出 `--trust`，它是隐藏旗标。文档写明第一次会把该项目文件夹记进 `~/.grok/trusted_folders.toml`。

装不上的是命令形态。钩子的 `command` 是一整段字符串，没有 Claude 那种 `args` 参数数组。路径里没有空格等符号时，只直接启动那一个文件，不能再带上脚本和事件名。一旦有空格，Windows 上走 shell（二进制写明当时的 shell 是 cmd 或 PowerShell）。网上当前源码的钩子结构也只有 `command`、`url`、`timeout`、`env`。要启动 `node` 加上现有的 `workbench-hook.mjs`，就得把路径拼进这一段字符串，从而经过 cmd。这违反「用参数数组、不经过 cmd」。

所以没有写项目 `.grok/hooks/`，没有给启动参数加 `--trust`，没有改 `~/.grok/config.toml`，也没有往 `~/.grok/hooks`、`~/.claude`、`~/.cursor` 加文件。Grok 窗口仍是说完后手动发送，不会超时强写。

### 改动文件

只追加本总记录。产品代码、使用说明、语言包都没动。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。

### 命令结果

- `grok --version`：`grok 1.0.13 (5e9a58528b76)`。
- `grok --help`：没有 `--trust` 这一行。
- `grok --trust -h`：退出码 0。
- `grok --not-a-real-flag -h`：退出码 2，`unexpected argument`。
- 未跑会消耗额度的命令。未跑 lint / typecheck（没有改代码）。

### 问题与遗留

要等本机 grok 的钩子能用参数数组直接启动 `node` 和 `workbench-hook.mjs`、并且不经过 cmd，才能再做自动继续。在那之前不要用输出静默去猜它停了。

### 相关文件链接

- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)
- [Grok 适配器说明](../adapters/grok-build.md)

## 2026-10-07 18:03 · T10.18 · 执行 · Grok 无空格钩子

### 任务要点

上一轮因为钩子 command 带空格会进 cmd 而停下。这次改成只写一个没有空格、不带参数的程序。事件从标准输入和 `GROK_HOOK_EVENT`、`GROK_SESSION_ID` 来。启动参数加 `--trust`。不改 `~/.grok/config.toml`，不写 `~/.grok/hooks`、`~/.claude`、`~/.cursor`。不调用模型。不提交。

### 结论

本机 `grok 1.0.13` 对没有空格的路径是直接启动，所以做了自动继续。随包说明写明：command 里有空格、管道、`&&`、重定向、`$` 时走 shell；没有这些符号的路径由运行器直接启动那一个文件。Windows 上那条 shell 是 cmd。因此没有改成看屏幕猜它停了。

项目 `.grok/hooks/ffpane-workbench.json` 的 command 只有 `ffpane-grok-hook.exe` 的完整路径。路径里有空格就不写这个文件，窗口仍是手动发送，不经过 cmd。程序不读命令行参数。说完（Stop、StopFailure、StopCancelled）才允许自动继续。PermissionDenied 和 `permission_prompt` 期间不按回车。批准被拒绝或取消之后，这一轮结束才放开。多个窗口用对话编号区分。令牌和密钥不进钩子文件。启动参数带 `--trust`，第一次由 Grok 自己把项目记成可信，软件不写 `config.toml`。

为核对父进程，曾用 `--trust` 拉起过一次 grok，会话还没建成就停了，钩子程序没有跑到。这次启动让 grok 自己把 `~/.grok/config.toml` 从 200 字节改成了 348 字节，并刷新了已过期的登录。没有备份，无法把配置文件退回原来的字节。探测写出的 `trusted_folders.toml` 事先不存在，已经删掉。没有写 `~/.grok/hooks`。没有发对话请求。

### 改动文件

- `apps/desktop/resources/ffpane-grok-hook/GrokHook.cs`、`apps/desktop/resources/ffpane-grok-hook.exe`
- `apps/desktop/src/main/workbench/grok-hook-config.ts`、`cli-args.ts`、`launch-cli.ts`、`control-channel.ts`、`idle-deliver.ts`、`handlers.ts`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/tests/workbench-grok-hook.test.ts`、`workbench-grok-launch.test.ts`、`workbench-idle-deliver.test.ts`、`workbench-control-channel.test.ts`
- `使用说明.md`、`locales/zh-CN.json`、`locales/en-US.json`、`docs/开发进度.md`
- 本总记录

未改 `apps/desktop/scripts/real-config-probe.mjs`。版本仍是 1.0.2。

### 命令结果

- `pnpm lint`：通过。Biome 770 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run` 上述 4 个测试文件：37 过。
- 未提交。

### 问题与遗留

探测把用户的 `~/.grok/config.toml` 改大了，登录也被 grok 刷新过一次。产品代码仍然不会去写这份配置。路径里有空格时，Grok 窗口还是手动发送。

### 相关文件链接

- [Phase 10 计划 §10](../Phase10-多窗口终端工作台计划.md)
- [使用说明](../../使用说明.md)

## 2026-10-07 18:33 · T10.18 · 检查 · Grok 无空格钩子

### 任务要点

独立检查未提交的 Grok 自动继续。钩子 command 只能是没有空格的 exe 路径。Stop、StopFailure、StopCancelled 才允许自动继续。权限等待不按回车。不启动本机 grok。不改实现，不提交。

### 结论

通过。没有必须修复，不需要主控再拍板。

带空格的安装路径不会写成交给 cmd 的命令。两边都有空格时不写钩子，窗口仍手动发送。能复制到没有空格的路径时，文件里只有那一个 exe。权限等待和其后的结束事件都不按回车；拒绝或取消之后的结束才放开。钩子文件里没有令牌和密钥。启动带 `--trust`。产品代码不写用户的 `~/.grok/config.toml`，也不写 `~/.grok/hooks`、`~/.claude`、`~/.cursor`。使用说明与此一致。版本仍是 1.0.2。

### 改动文件

- `docs/验收记录/T10.18-验收.md`
- 本总记录

未改实现。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。探针已删。

### 命令结果

- `pnpm lint`：通过。Biome 770 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `pnpm test`：148 个文件，2459 过，1 跳过。
- `pnpm smoke`：ALL PASS。`FF-pane v1.0.2`。
- `pnpm test:e2e`：55 过，约 5.5 分钟。没有需要单独重跑的失败。
- 未启动 grok。未提交。

### 问题与遗留

没有。用户目录的修改时间和大小在检查前后一致，没有打开里面的内容。

### 相关文件链接

- [T10.18 验收记录](../验收记录/T10.18-验收.md)
- [Phase 10 计划 §7.4](../Phase10-多窗口终端工作台计划.md)

## 2026-10-07 19:04 · T10.18 · 提交 · v1.0.3

### 任务要点

按计划 §7.2 第 4 步提交 T10.18。版本 `1.0.2` → `1.0.3`（根与 desktop 的 `package.json`、README 状态行、测试里的假 AppInfo）。开发进度登记 T10.18 已验收。计划 §4 增加 T10.18 行，§7.5 当前版本改为 1.0.3，下一步仍是 T10.19。轻量 tag `v1.0.3`，不 push。

### 结论

已提交并打轻量 tag `v1.0.3`，未 push。验收没有必须修复。不需要主控决策。

### 改动文件

- 版本：根与 `apps/desktop` 的 `package.json`、`README.md`、`command-ipc.test.ts` 与 `client-server.test.ts` 里的假 AppInfo
- 钩子：`ffpane-grok-hook.exe` 与源码、项目 `.grok/hooks` 只写没有空格的路径、`--trust`、说完自动继续、等批准不按回车
- 使用说明、语言包
- 进度与计划：`docs/开发进度.md`、`docs/Phase10-多窗口终端工作台计划.md`
- `docs/验收记录/T10.18-验收.md`
- 本总记录

### 命令结果

- `pnpm lint`：通过。Biome 770 个文件。`check-i18n` PASS。
- `pnpm --filter @ff-pane/desktop run typecheck`：通过。
- `vitest run apps/desktop/tests/command-ipc.test.ts apps/desktop/tests/client-server.test.ts`：2 个文件，73 过。
- 提交信息：`feat: T10.18 Grok 说完后自动继续`
- 轻量 tag `v1.0.3`，未 push
- 提交哈希：打 tag 之后补进本条

### 问题与遗留

历史记录里的 `1.0.2` 没有改。未纳入 `apps/desktop/scripts/real-config-probe.mjs`。旧验收记录和 `docs/Provider-模板说明.md` 只有换行符变化，没有提交。上面的提交哈希是 tag `v1.0.3` 所指的那一笔；这一行是后补的，所以 tag 里的本条仍写着「打 tag 之后补进本条」。

### 相关文件链接

- [T10.18 验收记录](../验收记录/T10.18-验收.md)
- [Phase 10 计划 §7.5](../Phase10-多窗口终端工作台计划.md)
