# Phase 7 验收记录（Handoff / Reviewer / 更多 Runtime / 多项目）

**执行时间：** 2026-08-31
**执行人：** 验收员（本 Agent）
**依据：** 开发计划 §10（T7.1~T7.4 各自的验收条款）、§16.4 Phase 7 工单拆分表（v1.7）、设计文档 §3.1 / §10.4 / §11.1
**版本关口：** 通过后 tag `v0.8.0` = **M2 完成**（tag 由主管理员执行，不在本记录范围）
**被验范围：** `7e13247`（T7.1）· `52498ad`（T7.2）· `7c02f61`（T7.3a）· `4b8bac8`（T7.3b）· `9962630`（T7.4，本次一并验收）
**验收开始时 HEAD：** `9962630`，工作区干净

---

## 0. 执行环境

| 项 | 值 |
|---|---|
| 平台 | Windows 11（10.0.22631），PowerShell 5.x（多命令以 `;` 分隔） |
| 包管理器 | pnpm 11.24.0 · Node v24.15.0 |
| 本机 Agent CLI | codex · claude · grok（**未登录**）· aider 0.86.2（`uv tool install` 隔离安装） |
| 本机可用模型后端 | **仅 DeepSeek 一套**（`openai_compatible`，密钥由用户临时提供） |
| 应用真实数据根 | `~/.aiworkbench` 下**只有 `habits/` 与 `knowledge/` 两个目录**，`providers.json` / `profiles.json` / `projects.json` **均不存在**——即应用里当前一个 Provider / Profile 都没落盘（此前各阶段的真机实证均由脚本在临时根内自建、密钥经 env 下发） |
| 自动化 | vitest **1704** 单测 / 83 文件 · Playwright **14** 条 E2E（`_electron` 驱动构建产物） |

> 本次关口验收全程未启动任何会弹窗 / 抢焦点 / 开浏览器 / 联网授权的进程（E2E 的 Electron 窗口除外），
> 未起任何 Agent 子进程，未改写用户全局配置；对真实数据根只做了一次**只读**目录列举（用于如实记录上表那一行）。

---

## 1. 工单交付状态

| 工单 | 内容 | 计划 §10 的验收条款 | 状态 |
|---|---|---|---|
| T7.1 | Handoff 交接包（§10.4） | **Codex Planner → 其他 Planner 真实迁移一次，新 Agent 能正确接续工作** | ◐ 自动化证据齐全（见 §2.1）；**真机迁移演示待验**，见 §3 |
| T7.2 | Reviewer 角色（§3.1，默认关） | **一个任务走完 Worker → Reviewer → 用户 三级确认** | ◐ 自动化证据齐全（见 §2.2）；**真机审查演示待验**，见 §3 |
| T7.3a | Grok Build 适配器 | 同 Phase 2 适配器标准（fixture 回放单测全绿 + 真机冒烟） | ✅ **已验收通过** —— `docs/验收记录/T7.3a-验收.md` |
| T7.3b | Aider 适配器 | 同上 | ✅ **已验收通过** —— `docs/验收记录/T7.3b-验收.md` |
| T7.4 | 多项目完善（§11.1） | 两个项目并存互不干扰的核查清单通过 | ✅ **本次验收通过** —— `docs/验收记录/T7.4-验收.md` |

**四个工单（五份交付）全部完成，无未交付项。** T7.3 按 §16.4 拆成 a / b 两单各自交付、各自验收。

---

## 2. 各工单的验收依据

### 2.1 T7.1 Handoff —— 自动化证据与缺口的边界

计划条款是一次**真机迁移演示**，本次未能执行（原因与论证见 §3）。以下是已经成立的自动化证据，
数字为本次实测（非引用交付声明）：

| 层 | 证据 | 本次实测 |
|---|---|---|
| 组装与渲染（纯函数） | `packages/core/tests/handoff.test.ts` —— 8 字段组装 · projectGoal 回退 · 记忆状态与类别筛选 · lesson 取样而 decision/rule 不设限 · openIssues 派生 · expectation 六态 · 八节齐全 · 空字段成节写"（无）" · 记忆正文不截断 · 渲染确定性 · **无执行记录面（红线）** | 与渲染层合计 **32 passed** |
| 渲染层纯逻辑 | `apps/desktop/tests/handoff-view.test.ts` —— 目标候选排除自己 · 标出换 Runtime · 缺省选中三态 | 同上 |
| 编排器（真 guard + 真 core + 假适配器） | `apps/desktop/tests/session-orchestrator.test.ts` 中的 handoff 分支 —— `resumeKind=handoff` 与正文前置 · 强制开新会话 · 不叠加上下文重建 · 空白按没给处理 | 该文件与 project-summary 合计 **66 passed** |
| 真实 IPC 链路 | E2E `handoff.spec.ts` ×2 —— ① `handoff:generate` 空项目容错 + active 记忆入包 / candidate 不入 + 红线断言（按持久格式落盘让主进程真实读回）；② 会话页「换 Agent」开对话框、正文预填、可编辑、无候选 Profile 时确认键保持禁用 | **2 passed** |
| 红线的落法 | 取材面而非事后过滤：`HandoffInput` 只接收本项目的计划 / 任务 / 项目记忆三样，**不接收 Run**（`raw.log` 的宿主）、不认识密钥模块。想让密钥进交接包得先改函数签名 | 代码结构层成立 |

**缺的那一块**：真实的第二个 Agent CLI 读到这份交接包之后**是否真的接续得上工作**。
这是关于第三方 CLI 与模型行为的证据，不是关于本仓逻辑的证据。

### 2.2 T7.2 Reviewer —— 自动化证据与缺口的边界

同上，计划条款是**一个任务走完 Worker → Reviewer → 用户 三级确认**的真机演示：

| 层 | 证据 | 本次实测 |
|---|---|---|
| 材料与结论解析（纯函数） | `packages/core/tests/review.test.ts` —— 材料八节 · 报告标注为自述而非证据 · diff 预算与截断标注 · 预算再小也至少收一个文件 · 结论解析五类失败一律落 `inconclusive` 且留原文 · **Reviewer 信封 ∩ Worker 预设仍不可写** | 与渲染层合计 **40 passed** |
| 渲染层纯逻辑 | `apps/desktop/tests/task-review.test.ts` —— 取 attempt 最大者 · 跨任务不串 · 更早那次审过不算 · 六个非 done 态不可审 · 审过仍可再审 | 同上 |
| 编排器 | `session-orchestrator.test.ts` 中的 reviewer 分支 —— 结论写回被审 Run 且**不铸新 Run**、不改任务状态 · end 事件带 verdict 与被审 runId · 第 4 层是审查材料而非任务合同 · 解析失败落 inconclusive · **未跑完不写结论** · verify_only 放行合同命令 · 合同外命令掐断整轮 · Run 不属于该任务 / 不存在均拒绝受理 | 含在上面的 66 passed 内 |
| 真实 IPC 链路 | E2E `reviewer.spec.ts` ×3 —— ① 项目级开关真落盘（默认关 → 开启并绑定 → 关掉不丢绑定 → 重读一致，且不牵连知识库开关）；② 审查轮受理前的归属校验在真实读盘链路上成立（无材料一律不受理，**不起进程去问模型**）；③ 默认关闭时任务页只见开关条 | **3 passed** |
| 不替代用户 | `acceptTask` 在状态机层只认 `actor="user"`；界面上 `fail` 时接受键降级为 secondary 但**仍可点** | 代码 + 单测层成立 |

**缺的那一块**：真实模型作为 Reviewer 跑一次只读审查、按合同产出结论，以及用户在这个结论之后做最终确认——
即三级确认里第二级与第三级**在真机上首尾相接**的那一次演示。

### 2.3 T7.3a / T7.3b —— 已各自验收

两份验收记录均为独立验收、结论为通过，本关口直接引用不再复核：

- `docs/验收记录/T7.3a-验收.md`：8 份真机 fixture + 28 项回放单测 + **真机冒烟 8 判据全过**；
  头号事实是"退出码撒谎"（不加 `--always-approve` 时每个工具都以 failed 落地、文件一个没写、进程退出码仍是 0），
  已在映射层拦下。另如实报 **MCP 注入 = 否**（知识库只读检索工具在该 Runtime 上不可用）。
  抽查记录三项文档口径偏差，已登记 §4.5。
- `docs/验收记录/T7.3b-验收.md`：11 份真机 fixture + 65 项单测 + **真机冒烟 14 判据全过（含 6 条红线）**，
  真实 aider 0.86.2；扫描器 8 处标记与随装源码的 文件:行号 **逐字对上**，全无多行/回溯正则。
  抽查记录四项偏差（含用户 HOME 的 `~/.aider/` 交付期遗留，已按主管理员裁定清理）。

### 2.4 T7.4 —— 本次验收

`docs/验收记录/T7.4-验收.md`，结论**通过**。要点：九项隔离核查逐项复核成立，
其中八项落在两条真实链路 E2E 上（三个项目：全套数据 / 只有自己的记忆 / 数据目录被端掉），
第 9 项契约表清点**由验收员自己重数一遍得到同样的 58 = 项目作用域 15 + 全局 43**；
派生信息不持久化是结构性的（汇总模块连 `node:fs` 都不 import）；
`loadAllPlans` 抽取后 `plans:list` 与 `loadLatestPlan` 行为不变（循环体逐字搬移，语义等同）。
抽查记录四条不影响事实正确性的偏差（单测子项计数 ±1、契约注释里的命令面板消费者、
终态常量未复用领域常量、冒烟 stderr 既有噪声）。

---

## 3. 待验项（v0.8.x 续验）与「为什么不阻塞关口」

### 3.1 清单

| # | 待验项 | 需要什么 | 补验方式 |
|---|---|---|---|
| 1 | **T7.1 真机迁移演示**：Planner 生成交接包 → 换一个 Profile 真实接续 | 至少一个可用 Provider + 两个 Profile（`deriveHandoffTargets` 只要求**另一个 Profile**，换 Runtime 与只换 Provider/模型都放行） | 建 Provider（DeepSeek）+ 两个 Profile（如 codex / aider 各一）→ 会话页「换 Agent」→ 确认注入 → 观察新会话是否按交接包内容接续 |
| 2 | **T7.2 真机审查演示**：Worker 跑完 → Reviewer 真实出结论 → 用户确认 | 一个可用 Provider + 两个 Profile（`reviewerProfileId` 只是一个 Profile ID，**不要求换 Provider**） | 任务页开 Reviewer 开关并绑定 → 派发 Worker 到 done → 点审查 → 观察 verdict 落 Run 与任务卡片徽章 → 用户点接受 |
| 3 | **grok-build 真实 xAI 后端字段补录** | 已登录的 grok CLI | 见 `packages/adapters/fixtures/grok-build/README.md` 的补录命令（`signature`、非零缓存 token、`refusal` 等 stopReason 取值） |
| 4 | **aider 真实 Provider 后端字段补录** | 真实模型（去掉 `OPENAI_BASE_URL` 假端点） | 见 `packages/adapters/fixtures/aider/README.md` 文末（`Tokens:` 行的 `Cost: $…` 形态、缓存 token 呈现、真实模型在 `diff` 编辑格式下的批量编辑块） |
| 5 | 两个项目**同时各跑一轮真实 Agent** 时的隔离（子进程 cwd、信封 writePaths、Run 目录落位） | 两轮并发的真机执行 | T7.4 隔离核查清单 §4 已登记；数据读写作用域面已在真实 IPC 链路取证，单轮 cwd 与信封由 Phase 2 权限层与编排器单测覆盖 |

### 3.2 本机为什么没能当场跑掉 1 与 2

如实记录，不含推测：

- 本机**只有 DeepSeek 一套可用模型后端**，密钥由用户临时提供、不在本验收会话中；
  grok CLI 未登录，claude / gemini 的认证按前序阶段记录也不在位。
- 应用的真实数据根里 **一个 Provider / Profile 都没落盘**（`providers.json` / `profiles.json` 均不存在），
  即两项演示都要从"建 Provider"起步，而那一步需要用户的密钥。
- 主管理员对本次验收的明确约束是**不做任何会弹窗 / 抢焦点 / 联网授权的操作**，
  验收员亦不应擅自把用户密钥写进真实数据根。

### 3.3 为什么不阻塞关口（论证）

参照 Phase 6 对「向量路真机未验」的处置方式（登记补验方式、不阻塞 tag、给出论证），并把差别一并说清：

**自动化证据覆盖了什么。** 两项待验的都是**演示**，而它们要演示的那套逻辑已经被分三层覆盖到：
① 纯函数层——交接包的 8 字段组装与渲染、审查材料的八节与结论解析，共 72 项单测，含红线断言
（交接包取材面物理不含 Run/密钥/他项目；Reviewer 信封与 Worker 预设相交后仍不可写）；
② 编排器层——用**假适配器驱动真实权限层与真实 core**，覆盖 13 项，含"迁移强制开新会话且不叠加重建文本"、
"审查结论写回被审 Run 而不铸新 Run、不改任务状态"、"轮次没跑完则不写结论"这三条最容易出错的规则；
③ 真实 IPC 链路层——5 条 E2E 走 `preload → 主进程 → storage`，与生产同一条路径，覆盖落盘、
归属校验、界面入口的可见性。

**缺的那块是什么性质。** 缺的不是"我们的逻辑对不对"，而是"第三方 Agent CLI 拿到我们给的东西之后表现如何"
——接手方是否真的按交接包接续、审查者是否真的按合同产出可解析的结论。这类证据的载体在别人家的 CLI 与模型上，
其失败模式是**提示词/合同要不要再打磨**，而不是结构性返工；而"一轮受管执行在本机真能跑通"这件事，
本项目已经反复实证过：T4.5/T4.6 的十步真机走查（codex + DeepSeek，真实建文件、真实出 v1 计划）、
T6.6 的 Worker 自主调用检索工具（随机口令逐字符验对）、T7.3a/T7.3b 的两次适配器真机冒烟
（8 判据 / 14 判据全过）。也就是说执行脊柱本身不是待验项。

**与 Phase 6 那次的差别（必须如实说）。** Phase 6 的向量路是**穷尽了所有来源之后确实做不到**
（DeepSeek 无该端点、Ollama 下载三轮失败、用户选择不注册第三方）；而本次两项演示
**看代码是可以做到的**——`deriveHandoffTargets` 只要求"另一个 Profile"、`reviewerProfileId` 只要求一个 Profile ID，
两者都不需要第二套 Provider（进度文档里"需两套可用 Provider"的措辞比代码要求更严）。
换言之障碍是"本验收会话拿不到密钥且不得做联网授权"，而不是"物理上办不到"。
因此**是否先跑再打 tag，是一个合理的替代选择**，本记录把它列为需主管理员决策的第 1 项（§6）。
本验收员给出的建议是**先打 tag、把两项演示作 v0.8.x 续验**，理由是：计划 §10 对 T7.1/T7.2 的条款
是演示形态的验收，其考察对象在第三方 CLI 侧；本仓逻辑与落盘链路已有上述三层证据；
两项演示一旦发现问题，性质是 v0.8.x 的提示词/文案调整而非架构返工。

---

## 4. 全量回归结果（本次实测）

全部在仓库根执行（PowerShell，多命令以 `;` 分隔），HEAD = `9962630`。

| 项 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| 单测 | `pnpm test` | **1704 passed / 1704（83 文件）** | 12.09 s |
| lint | `pnpm lint` | **PASS** —— biome `Checked 535 files in 154ms. No fixes applied.`；`check-i18n` PASS | 2.4 s |
| typecheck（node / web / e2e 三套） | `pnpm --filter @ff-pane/desktop run typecheck` | **exit 0** | 2.9 s |
| 构建 | `pnpm build` | **PASS**（6 个工程）—— main 95.96 kB · knowledge-mcp 11.34 kB · preload 3.80 kB · renderer 1465.67 kB + 35.79 kB CSS | 8.5 s |
| 冒烟 | `pnpm smoke` | **七项全过、exit 0** —— main-sqlite（SQLite 3.53.4）· ipc-ping-pong（15 ms）· app-info（v0.1.0 / Electron 44.0.0）· sqlite-via-ipc · event-subscription · csp-blocks-eval · secrets-roundtrip | 7.2 s |
| E2E | `pnpm test:e2e` | **14 passed / 14**（1 worker） | 9.5 s（含构建共 16.4 s） |

E2E 逐条：create-project · create-provider · habits · **handoff ×2（T7.1）** · knowledge-mcp · knowledge ×2 ·
launch · **multi-project ×2（T7.4）** · **reviewer ×3（T7.2）**。

### 4.1 单测数字链核对

Phase 6 收尾 **1497** → T7.1 +36 = **1533** → T7.2 +54 = **1587** → T7.3a +31 = **1618** →
T7.3b +65 = **1683** → T7.4 +21 = **1704**。链条闭合于本次实测的 1704，
即 T7.1 / T7.2 交付声明里的单测数字**与今天的实际总数自洽**（这也是本关口对这两单
"依据交付时自动化证据评定"的一条客观支撑）。E2E 同理：7 → 9 → 12 → 12 → **14**。

### 4.2 已登记 flake 的本次观察

| flake | 本次触发情况 |
|---|---|
| `provider-probe.test.ts` 全量并发下偶发 `fetch failed ← bad port`（约 1/7） | **未触发** |
| `packages/adapters/tests/process.test.ts` 背压断言 `sawBacklog` 偶发不成立（T7.3a 复测约 1/3） | **未触发** |

全量 `pnpm test` 一次跑完即全绿，**无单文件重跑需求**，本关口不存在需判定为 flake 的失败。

### 4.3 一条如实登记的既有噪声

冒烟模式 stderr 有一行 `No handler registered for 'projects:summary'`。
成因是 `--smoke` 只装配 4 个 app / diagnostics 通道却加载**真实 renderer**，默认路由（项目页）照常发起数据查询。
已核实**改动前同一位置报的是 `projects:list`**（`git show 9962630 -- ProjectsPage.tsx`），性质未变、非 T7.4 引入。
冒烟判定由七条 check 与退出码决定，本次七项全 PASS、exit 0，**不影响判定**。

---

## 5. 技术债与悬置事项（Phase 7 期间新增）

摘自 `docs/开发进度.md` §4 / §4.5，只列 Phase 7 期间新增或被本阶段改写的条目。

### 5.1 §4 悬而未决（需用户提供 / 裁定）

| 事项 | 来源 | 归属 |
|---|---|---|
| 仓库 `.env` 以 `override=True` 覆盖注入 env（aider 实证）——是否提供「适配器自管 `--env-file`」设置项。与 §4.3「密钥只经 env 下发、不落盘」相抵触，需用户显式确认才可开 | T7.3b | **M3 评估** |

（另有 Gemini 认证、可选 openai-compatible key / 本地 Ollama 两条为 Phase 2 期遗留，本阶段未变。）

### 5.2 §4.5 技术债

| 事项 | 来源 | 归属 |
|---|---|---|
| `adapters/tests/process.test.ts` 背压断言在全量并发下偶发不成立；**T7.3a 复测频率上升到约 1/3，已到应当处置而非继续观察的程度** | T7.2 观察、T7.3a 复测 | 测试加固小工单 |
| T7.3a 抽查三项：`DENIAL_MARKERS` 实为 3 条未入调研档 · `grokBuildRule` 缺专属分支单测 · `auth-probe.test.ts` 两处标题仍写「四 runtime」（实覆盖五个） | T7.3a 验收 | 测试加固小工单 |
| T7.3b 抽查三项：`--no-detect-urls` 是实际下发的第八个残留开关但未入 `aider.md §1.2` 表 · 单测子项计数 ±1 · `live-aider.mjs` 判据分组注释编号过期 | T7.3b 验收 | 测试加固 / 文档口径小工单 |
| `aider/git-diff.ts` 与 `codex/git-diff.ts` 的 git 执行器样板重复（语义重心不同，暂不合并——提取共享模块会动 codex） | T7.3b | 适配器整理小工单 |
| **T7.4 抽查三项（本次新增）**：单测子项计数 ±1（降级 5 / 整表 4，总数 21 无误）· 契约注释把「命令面板的项目切换」写成现有 `projects:list` 消费者（命令面板未挂进 `App.tsx`）· `SETTLED_TASK_STATUSES` 与领域 `TASK_TERMINAL_STATUSES` 同内容但未复用（抗漂移建议） | T7.4 验收 | 测试加固 / 文档口径小工单 |

（`provider-probe` 404 flake、`Provider.proxy` 未被消费、msys 孙进程逃逸、注册表 runtime 键唯一性
等条目为 Phase 7 之前登记，本阶段未变。）

### 5.3 跨阶段既有遗留（本阶段未处置，如实带出）

| 项 | 说明 |
|---|---|
| 命令面板（Ctrl+K）尚未挂进 `App.tsx` | Phase 3 遗留，用户已明确后置。连带 `session-insert-knowledge` 命令无 handler；也是 §5.2 里那条契约注释口径偏差的成因 |
| `ProjectLayout` 预留的 `knowledgeDir` / `indexDbFile` 至今无写入者 | 知识库层一律绑全局根。T7.4 已把「它们确实是空的」固定成 E2E 断言，将来若有人给项目级知识库接线，该断言会先红 |
| MCP 注入在 grok-build / aider 上不可用 | grok 只能改用户全局或用户仓库配置（与红线相抵触）；aider 0.86.2 完全不支持 MCP（无取舍空间）。均已如实声明 |
| 向量路真机未验（Phase 6 保留项） | `v0.7.x` 续验项，补验脚本已就位；本阶段未涉及，未取得新证据 |

---

## 6. 关口结论

**Phase 7 通过，可 tag `v0.8.0`（M2 完成）。**

依据：

1. **四个工单（五份交付）全部完成**，无未交付项、无未收尾工单（§1）。
2. **三份工单级验收结论均为通过**：T7.3a、T7.3b 各有独立验收记录且含真机冒烟全过；
   T7.4 本次验收通过，其计划条款（两项目并存互不干扰的核查清单）九项逐项成立，
   第 9 项的契约表清点由验收员独立重数复核（58 = 15 + 43）。
3. **全量回归全绿且为本次实测**：1704 单测 / lint / check-i18n / 三套 typecheck / 全量构建 /
   冒烟七项 / E2E 14 条（§4）；两条已登记 flake 未触发，无单文件重跑，**不存在真实失败**。
   单测与 E2E 的数字链从 Phase 6 的 1497 / 7 逐单闭合到今天的 1704 / 14。
4. **T7.1 与 T7.2 的计划条款是真机演示形态，本次未取得该演示证据**，如实记为 v0.8.x 续验项（§3）。
   判定其不阻塞关口的依据：两单的逻辑面由 72 项纯函数单测 + 13 项编排器单测（真权限层 + 真 core +
   假适配器）+ 5 条真实 IPC 链路 E2E 覆盖，含各自最要紧的红线断言；缺的那块证据的考察对象在
   第三方 Agent CLI 与模型侧，而"一轮受管执行在本机真能跑通"已由 T4.5/T4.6/T6.6/T7.3a/T7.3b 反复实证。
5. **本记录对 §3.3 的差别如实披露**：与 Phase 6「向量路穷尽来源仍做不到」不同，这两项演示
   **按代码只需一个可用 Provider 加两个 Profile**（进度文档"需两套可用 Provider"的措辞比代码要求更严），
   障碍是本验收会话拿不到密钥且不得做联网授权。故"先补演示再打 tag"是一个合理的替代路径，
   由主管理员裁定；本验收员的建议是先打 tag、演示作 v0.8.x 续验。

需主管理员决策的事项：

1. **先 tag 还是先补演示**：§3.3 已论证两项真机演示按代码只需 DeepSeek 一套 Provider + 两个 Profile
   （codex → aider 的 handoff、同 Provider 两个 Profile 的 Worker → Reviewer），并非物理不可行。
   若倾向"关口条款必须逐字满足"，可在打 tag 前安排一次带密钥的真机演示。
2. **`docs/开发进度.md` 里"需两套可用 Provider"的措辞是否更正为"两个 Profile（可同一 Provider）"**
   ——当前措辞与 `deriveHandoffTargets` / `reviewerProfileId` 的实现不符（更严），会影响将来对这两项续验的排期判断。
3. **T7.4 抽查的两条建议是否并入既有「测试加固 / 文档口径小工单」**：`SETTLED_TASK_STATUSES` 改为
   import 领域常量；契约注释里命令面板消费者的口径。（另一条单测子项计数 ±1 同前两单，同一处置。）
4. **冒烟模式的 stderr 噪声**（加载全功能 renderer 却只装配 4 个通道，任何页面级查询都留一行）
   ——是否值得单开小工单，或长期如实容忍。
5. **仓库 `.env` 覆盖注入 env 的强隔离方案**（T7.3b 遗留，§5.1）——M3 评估，本关口不处置。
