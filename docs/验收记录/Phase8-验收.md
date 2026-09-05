# Phase 8 验收记录（M3：UI 收口 / 进程圈禁 / 会话续接 / 任务并行 / 自定义角色 / ACP / 更多 Runtime / 记忆语义检索）

**执行时间：** 2026-09-06
**执行人：** 关口收尾子 Agent（关口验收，边验边写）
**依据：** 开发计划 §11（T8.1~T8.7 各自的验收条款，v1.8 细化经用户 2026-09-01 批准）、§16.4 Phase 8 工单拆分表（v1.9 补入，v1.11 插入 T8.2b）、§14 执行批次总览
**版本关口：** 通过后 tag `v0.9.0` = **M3 完成**（tag 由本关口收尾单执行，主管理员已授权推送）
**被验范围：** `a2d62a8`（T8.1）~ `48236e0`（T8.7 验收落档），共 14 个工单、29 个提交（含各工单验收落档、v1.11 计划修订与 v0.9.x 清债单；另有 Phase 8 细化的 v1.8 / v1.9 两个计划提交 `d8f5865` / `8708368` 在 T8.1 之前）
**验收开始时 HEAD：** `48236e0`，工作区干净

---

## 0. 执行环境

| 项 | 值 |
|---|---|
| 平台 | Windows 10（10.0.22631），PowerShell，全部命令在仓库根执行 |
| 包管理器 / Node | pnpm 11 · Node v24.15.0 · Electron 44.0.0 monorepo（vitest 4.1.11，biome，Playwright `_electron`） |
| 本机真机资源 | Ollama 0.33.3 运行中 + `bge-m3`（1024 维，两条 live 抽验实跑）；opencode 1.18.25（适配器 live 抽验实跑）；grok / qwen / iflow / gemini 认证不在位（续验清单如实列出，§4.2） |
| 自动化 | vitest **2118** 单测 / 103 文件 · Playwright **29** 条 E2E · NSIS 打包链路 |
| 已知 flake 名单（§4.5，八条） | adapters generic-exec cancel · E2E task-parallel · vitest worker fork · opencode env 指纹（已加固） · iflow `--experimental-acp` 漂移 · grok-build respondPermission（已加固） · process 树杀前置探活 · memory-vector reconcile（T8.7 验收新登记）——触发则复跑绿即登记 |

> 本关口验收全程未启动任何会弹窗 / 抢焦点 / 联网授权的进程（E2E 的 Electron 窗口与 live 脚本的受管子进程除外），未改写用户全局配置。live 脚本的模型端为本机 Ollama（记忆/嵌入两条）与假 OpenAI 兼容服务端（opencode 一条，CLI 行为全真）。

---

## 1. 工单完备性（对照开发计划 §11 与 §16.4 Phase 8 表，逐单核对）

十四个工单全部交付、全部有独立验收记录、结论全部为通过。每单一行：

| 工单 | 内容 | 交付提交 | 验收落档提交 | 验收记录 | 结论 |
|---|---|---|---|---|---|
| T8.1 | 遗留 UI 收口（命令面板挂载 + 语言三态 + 同形清单收敛） | `a2d62a8` | `a4494cd` | `docs/验收记录/T8.1-验收.md` | ✅ 通过（带遗留，已并入 v0.9.x 清债单处置） |
| T8.2 | 进程圈禁根治（Windows Job Object，koffi FFI 经用户裁定引入） | `a058ecf` | `a4494cd` | `docs/验收记录/T8.2-验收.md` | ✅ 通过（带遗留，已并入 v0.9.x 清债单处置；Job 嵌套「关应用即清场」经用户 2026-09-02 裁定为期望行为） |
| T8.2b-a | 会话续接闭环——主进程侧（transcript 落盘 + interrupted + before-quit 钩子 + 启动修正） | `e63a938` | `c079931` | `docs/验收记录/T8.2b-a-验收.md` | ✅ 通过（带遗留，repair action 勘误归 T8.2b-b 已处置） |
| T8.2b-b | 会话续接闭环——渲染层（回放 + 续接横幅 + 中断标注 + E2E） | `3768d3a` | `ac3a6e2` | `docs/验收记录/T8.2b-b-验收.md` | ✅ 通过（带遗留，三裁定随落档处置） |
| T8.3a | 任务并行——接口定稿（writePaths 互斥纯函数 + 并发契约 + 注册键规约） | `16152c0` | `7c8ddc0` | `docs/验收记录/T8.3a-验收.md` | ✅ 通过（带遗留，三条裁定均已随 T8.3b 落地） |
| T8.3b | 任务并行——实现与呈现（并发受理 + 冲突拒绝 + 在飞区 + 僵尸注销根治） | `f72c99b` | `ac3cd2d` | `docs/验收记录/T8.3b-验收.md` | ✅ 通过（带遗留，释放时序单测已补钉） |
| T8.4 | 自定义角色（角色定义 + §7 清单不可绕过 + Prompt 第 1 层 + 真机演示 claude-code PASS） | `42f1da5` | `d2312e1` | `docs/验收记录/T8.4-验收.md` | ✅ 通过（不带遗留标记） |
| T8.4b | 多实例装配小单（复合键 + generic-exec 按 Profile 实例化 + aider tempDir 出 tmpdir）——**插单** | `8ecb4ef` | `706a046` | `docs/验收记录/T8.4b-验收.md` | ✅ 通过（带遗留，三裁定随落档处置） |
| T8.5a | ACP 协议层（stdio JSON-RPC 双工 + 会话语义类型，手写取舍回填技术选型 §10） | `4f395e0` | `32b2564` | `docs/验收记录/T8.5a-验收.md` | ✅ 通过（带遗留，真半包用例已补钉） |
| T8.5b | grok-build ACP 接入（权限转发/优雅取消双 yes + 握手失败降级） | `e4ce2a4` | `08164b3` | `docs/验收记录/T8.5b-验收.md` | ✅ 通过（带遗留，三裁定随落档处置） |
| T8.5c | OpenCode 注册小单（共享 server 惰性装配 + 退出收敛 + 能力声明选路）——**插单** | `9fc83c3` | `14a697a` | `docs/验收记录/T8.5c-验收.md` | ✅ 通过（带遗留，两裁定随落档处置） |
| T8.6a | Qwen Code 适配器（调研 + fixture + 实现 + 真机冒烟 10 判据） | `827c58b` | `09b28ec` | `docs/验收记录/T8.6a-验收.md` | ✅ 通过（带遗留，QWEN_MODEL 钉子与 opencode 用例加固随落档处置） |
| T8.6b | iFlow 适配器（ACP 单通道 + 受管 HOME 隔离 + 真机冒烟 11 判据） | `ee97e39` | `5c1e648` | `docs/验收记录/T8.6b-验收.md` | ✅ 通过（带遗留，grok-build 用例加固随落档处置） |
| T8.7 | 记忆语义检索（向量索引 + RRF 融合 + **Phase 6 向量路真机保留项闭环**） | `b9f3d69` | `48236e0` | `docs/验收记录/T8.7-验收.md` | ✅ 通过（带遗留，崩溃语义守卫用例与 reconcile flake 登记随落档处置，Phase6-验收.md 勘误注记同步） |

**十四个工单全部完成且全部独立验收通过，无未交付项、无未收尾工单。** 与计划表（§16.4：T8.1 / T8.2 / T8.2b-a / T8.2b-b / T8.3a / T8.3b / T8.4 / T8.5a / T8.5b / T8.6a / T8.6b / T8.7 共 12 单）的差异恰为两个过程插单（T8.4b / T8.5c，批准依据见 §2.1；T8.2b 本身即 v1.11 修订批准的插单，已在计划表内）。

**过程配套提交（非工单本体，如实列出）：** `d8f5865`（开发计划 v1.8，Phase 8 细化经用户批准）· `8708368`（v1.9 工单拆分表）· `9897287`（v1.11 T8.2b 插入修订）· `8e83bf3`（v0.9.x 清债单——T8.1/T8.2 两单验收遗留合并 14 项处置，含 asar 排除 koffi 源码；随后打包产物 `live-job-object.mjs` ALL PASS，本关口复验见 §3）。

---

## 2. 计划外偏差清点

### 2.1 §14 顺序执行情况

计划顺序（§14 第 10 行 / §16.4 依赖序）：T8.1 → T8.2 → T8.2b-a → T8.2b-b → T8.3a → T8.3b → T8.4 → T8.5a → T8.5b → T8.6a → T8.6b → T8.7。

实际顺序（git 提交序核实）：T8.1 → T8.2 →（v0.9.x 清债单）→ T8.2b-a → T8.2b-b → T8.3a → T8.3b → T8.4 → **T8.4b（插）** → T8.5a → T8.5b → **T8.5c（插）** → T8.6a → T8.6b → T8.7。

**与计划序一致，全程串行逐个交付、每单独立验收，无乱序。** 三个插单的批准依据：

| 插单 | 插入位置 | 批准依据 |
|---|---|---|
| T8.2b-a / T8.2b-b | T8.2 之后、T8.3a 之前 | 开发计划 **v1.11 修订**（`9897287`），经用户 2026-09-02 批准——T8.2 圈禁使「关应用即清场」成为现实（用户裁定为期望行为），会话续接闭环是其配套；§11 / §16.4 均有正式条目 |
| T8.4b | T8.4 之后、T8.5a 之前 | T8.3b 验收 §6-3 裁定（主管理员 2026-09-03 批复）：generic-exec 多实例装配与 aider tempDir 接线**另立多实例装配小单**，归属于「T8.4 之后、T8.5 之前」，§4.5 有登记 |
| T8.5c | T8.5b 之后、T8.6a 之前 | T8.4b 的 OpenCode 注册就绪评估落档（§0 T8.4b 节范围 4，建议 T8.5 后独立小单）+ T8.4b 验收裁定事项 ② 批复立项；四缺口清单在案 |

### 2.2 红线遵守情况

- **依赖引入**：`v0.8.0..HEAD` 范围内 `pnpm-lock.yaml` 恰两次改动——① `undici`（`db14538`，**v0.8.x 清债二单**，Phase 8 开工前的 v0.8.x 尾单，Provider.proxy 接入连接探测，主管理员裁定序列内，不属 Phase 8 工单）；② **`koffi`（`a058ecf`，T8.2，经用户 2026-09-01 裁定引入，取舍落档 `docs/技术选型.md` §10.1）**。Phase 8 十四工单内的依赖引入恰此一次，**无其他**。
- **fixtures 逐字节保真**：各工单验收均含该项核查（T8.5b 只新增 `real-acp-*` 三文件、既有逐字节不动；T8.6a/T8.6b 新目录入库；T8.7 零触碰），无违例。
- **能力声明与实测一致（T7.3a 纪律）**：qwen-code 权限转发如实报 no、iFlow streaming 如实报 partial、OpenCode 按 Server 声明选路且 CLI 降级未接线状态如实登记、grok-build 双 yes 仅限 ACP 路径——全程未美化。
- **每单验收含反向探针**：T8.3b 起各单验收均以反向探针验证覆盖面（恰红/未红均如实登记），两处覆盖缺口（T8.5a 半包、T8.7 崩溃语义）均已补钉（后者随本关口的 T8.7 落档提交 `48236e0`，反向自证恰红）。
- **未擅自 push**：Phase 8 全程提交留在本地，推送随本关口 tag 一并执行（主管理员已授权）。

---

## 3. 全量回归（关口级，本次实测）

全部在仓库根执行，HEAD = `48236e0`。

| 项 | 结果 |
|---|---|
| 单测全量连跑 | 第 1 跑 **2117/2118**——唯一红条为 `command-ipc.test.ts`「CommandPaletteProvider 与 CommandPalette 可被加载」5 s 超时（负载型，与 T8.7 验收首跑同形态；单文件复跑 66/66 绿）；**第 2/3/4 跑独立 3 连跑均 2118/2118（103 文件）全绿**（Duration 24.67 / 22.90 / 22.74 s）。2118 = Phase 7 收尾 1704 → Phase 8 各单增量 → T8.7 的 2117 + 本关口 T8.7 落档补测 1 条守卫用例 |
| `pnpm lint` | exit 0 —— biome `Checked 612 files. No fixes applied.` + `[check-i18n] PASS`（renderer 无硬编码 CJK 文案） |
| `pnpm build` | exit 0 —— 6 工程三套 typecheck，renderer 产物 1,553.56 kB |
| `pnpm smoke` | exit 0 —— 七项全 PASS（main-sqlite · ipc-ping-pong · app-info · sqlite-via-ipc · event-subscription · csp-blocks-eval · secrets-roundtrip） |
| `pnpm test:e2e` | **29 passed / 29（23.6 s）**，一次通过（E2E task-parallel 已知 flake 未触发）。逐条含 command-palette ×4（T8.1）· custom-role（T8.4）· generic-exec-profile ×2（T8.4b）· session-replay ×3（T8.2b-b）· task-parallel ×3（T8.3b）· ui-language ×2（T8.1）及 Phase 7 前存量 |
| `pnpm package` | exit 0 —— NSIS 打包成功（`FF-pane-Setup-0.1.0.exe` + blockmap；asar 完整性更新、signtool 签名步骤全过） |
| `live-job-object.mjs`（打包产物，T8.2 关键路径） | **ALL PASS** —— 四判据全过：① koffi 从 app.asar 内加载 + `.node` 来自打包产物平台包 ② `AssignProcessToJobObject = true` ③ `TerminateJobObject` 终止成功（终止前 `IsProcessInJob = true`）④ 对照组 `taskkill /T` 后残留仍活着（正是圈禁要根治的那类） |
| `live-memory-search.mjs`（live 抽验一，真机 Ollama bge-m3） | **ALL PASS** —— 对照组（配 Provider 前）0 命中 blocker=no-provider → 混合检索「怎么跑单测」命中「执行 vitest 命令」排第一来源 `[vector]`（首查 302 ms 含 3 条回填 → 第二查 40 ms）；编辑重嵌 / 删除出索引 / 过滤下推 / 关键词照常全过 |
| `live-opencode.mjs`（live 抽验二，适配器，真机 opencode 1.18.25） | **ALL PASS** —— 11 判据全过：server 健康 + 原生会话 ID + session_start 先于动作 + 权限真转发（write + bash）+ hello.txt 真落地 + file_change diff + 命令退出码 0 + 文本增量 final 收尾 + `close()` 601 ms ≤ 1 s 预算且 server 收干净 |

**已登记 flake 的本次观察**：触发一条（command-ipc 加载用例，单测首跑），复跑绿即登记，符合名单纪律；其余七条均未触发。**不存在真实失败。**

---

## 4. 技术债与续验清单盘点

### 4.1 §4.5 技术债现状汇总（共 38 条）

| 类别 | 条数 | 明细 |
|---|---|---|
| **已处置 / 已加固 / 已落档** | **20** | Provider.proxy 探测接入 · 注册键规约定稿+装配 · msys 逃逸根治（T8.2）· W2.4 PATH 冗余 · provider-probe 404 · 背压断言 · T7.3a / T7.3b / T7.4 验收抽查三组（各一行）· 冒烟 stderr 噪声 · 命令面板挂载（T8.1）· Job 嵌套语义落档（用户裁定）· x64 结构体尺寸边界登记 · aider tempDir 接线（T8.4b）· repair action 勘误 · 退出路径僵尸注销（T8.3b）· generic-exec 装配（T8.4b）· grok 中断凭据（T8.5b 根治，aider 侧如实不变）· opencode env 指纹用例加固 · grok-build respondPermission 用例加固 |
| **观察 / 备查 / 维持现状（含裁定）** | **12** | Provider.proxy 两路未覆盖（设计选择）· proxy 无存储层校验（裁定维持）· socks 按需增强（裁定）· CRLF 集成点归一策略 · 切项目残留（裁定维持）· E2E task-parallel flake · ACP schema 对照（裁定维持）· vitest worker fork flake · live-iflow R1 挂住备查 · process 树杀前置探活 flake · memory-vector reconcile flake（本关口新入名单）· Provider.proxy 未覆盖嵌入管道（既有口径重申，远端嵌入 + 代理真实诉求出现时评估） |
| **待真实诉求 / 跟上游 / 后续工单** | **6** | git-diff 样板重复（适配器整理小工单）· grok ACP MCP 注入翻案路径 · OpenCode CLI 降级接线 · qwen 权限转发翻案（跟上游）· iFlow `--experimental-acp` 漂移（跟版本）· habits 语义检索（真实诉求再立单） |

已知 flake 观察名单现为**八条**（§0 环境表），其中两条已加固（时序钉子）、名单纪律不变（触发则复跑，绿即登记）。

### 4.2 待用户 / 需裁定事项（§4 悬而未决 + 各单挂账，不阻塞关口）

| 事项 | 需要什么 | 来源 |
|---|---|---|
| Gemini 认证 | GEMINI_API_KEY 或交互式登录一次 → 补录真实 fixture + W2.5 的 7 项待真机校验 | Phase 2 起挂账（§4） |
| grok 登录补录 | 已登录的 grok CLI → 真实 xAI 后端字段补录（thought/plan 形状、refusal 等 stopReason；ACP 真实后端形态） | T7.3a / T8.5b（§7.5.4 续验命令已写进 live 脚本头注） |
| DASHSCOPE_API_KEY | qwen-code `LIVE_REAL_MODEL=1` 走真实端点续验 | T8.6a（README / 调研 §10 已登记） |
| iFlow 账号 | 真实后端 fixture 补录 + streaming 翻案验证 + `--port` / oauth 登录态等待验项 | T8.6b（`iflow.md` §10.4/§11.1） |
| 真机代理验证 | 真实本地 http 代理入口跑一次「测试连接 + 拉取模型」 | v0.8.x 清债二单裁定（2026-09-01）记入续验 |
| 双项目并发隔离取证 | 两项目同时各跑一轮真实 Agent（子进程 cwd、信封 writePaths、Run 落位） | Phase 7 关口续验项 §3.1-5 |
| codex headless 复测 | 涉 codex 真机的续验项执行前先复测本机环境（`codex exec` 曾两次挂起，T8.4 验收观察、主管理员 2026-09-04 裁定加注） | T8.4 验收 §2-5 |
| （可选）openai-compatible key | OpenCode 真实模型长会话 fixture 补录，不阻塞 | Phase 2 起挂账（§4） |
| 仓库 `.env` override 强隔离方案 | 用户显式确认是否提供「适配器自管 `--env-file`」设置项（与 §4.3 密钥不落盘相抵触）——原定 M3 评估，本阶段 T8.6b 已实证 dotenv 劫持可经 env 预占免疫（iFlow 侧），通用方案维持挂账待用户诉求 | T7.3b（§4） |
| aider native 恢复门槛 | `decideResumeKind` 只认 `nativeResume === "yes"`，aider（partial）续接轮不消费已出 tmpdir 的 transcript——是否放宽属编排器语义变更，待主管理员裁定 | T8.4b 验收裁定事项 ①（挂账） |
| T7.1 / T7.2 真机演示 | Phase 7 关口既有续验项（一个可用 Provider + 两个 Profile 即可跑），进度事实源 Phase 7 节仍在案 | Phase 7 关口 §3 |

以上均为**证据补录 / 用户资源依赖 / 显式裁定**性质，考察对象在第三方 CLI、真实后端或用户决策侧，本仓逻辑面均有自动化覆盖——不阻塞关口（与 Phase 7 关口对同类事项的处置口径一致）。

---

## 5. 关口结论

**Phase 8 通过，可 tag `v0.9.0`（M3 完成）。**

依据：

1. **十四个工单全部交付且全部独立验收通过**（§1）：计划内 12 单 + 过程插单 2 单（批准依据齐备，§2.1），每单有交付提交、验收记录、验收落档提交三件套，无未收尾项。各单验收遗留全部按裁定处置或如实登记（§4.1）。
2. **顺序纪律与红线全程遵守**（§2）：实际执行序与 §14 计划序一致（串行逐个交付）；依赖引入 Phase 8 工单内恰一次（koffi，经用户裁定并落档技术选型）；fixtures 保真、能力声明如实、反向探针纪律贯穿。
3. **关口级全量回归全绿且为本次实测**（§3）：2118 单测独立 3 连跑全绿（首跑一条已知 flake 复跑绿）· lint / build / smoke 全过 · E2E 29/29 一次通过 · **NSIS 打包成功且打包产物的 Job Object 四判据 live 实证 ALL PASS**（T8.2 关键路径在产物形态下成立）· live 抽验两条（记忆语义检索端到端 + opencode 适配器 11 判据）ALL PASS。
4. **M3 的三条主线全部闭环**：① 执行安全——进程圈禁根治 + 退出清场 + 会话续接闭环；② 执行能力——任务并行 + 自定义角色 + ACP 标准接入 + 适配器阵容扩到七家（codex / claude-code / gemini-cli / grok-build / aider / opencode / qwen-code / iflow，含 generic-exec 多实例）；③ 检索能力——记忆语义检索 + **Phase 6 唯一保留项「向量路真机未验」闭环**（真机 Ollama bge-m3，语义判据「向量赢过关键词」成立）。
5. **技术债与续验清单如实盘点**（§4）：§4.5 共 38 条——19 条已处置 / 已加固 / 已落档、12 条观察 / 备查 / 维持现状（含各裁定）、7 条待真实诉求或跟上游；待用户资源 / 裁定的续验项 11 条逐一列出，性质均为第三方证据补录或用户决策，不构成本仓缺陷。

验收结束时 `git status --short`：仅本记录与进度文档同步（随提交 2 入库）。
