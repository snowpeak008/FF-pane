# 子 agent 管控计划

> 状态：Tony 2026-10-24 要求写计划。未开工，未改版本。总览见 [`改进计划总览-2026-10.md`](./改进计划总览-2026-10.md)。

## 1. 为什么做

Tony 怀疑执行者自己开子 agent，做不受控的并行开发。核实结果（《海上生存日记》全部会话，数字见总览 §4.1）：

- 执行者：63 个里 3 个用过，各 1 次，都是只读的 Explore，没改文件。不是问题的来源。
- **管理者：真的在用。** `af9ba649` 两天开了 62 个后台子 agent，改了 212 个文件。子 agent 不在窗口列表里，监管者看不到，没有 brief 划范围，不拿锁，不汇报。管理者说明里的「不亲自改代码」和「并发是硬规则」都被绕过。

代码里没有任何拦截：

- Claude：`launch-cli.ts` 调 `buildInteractiveClaudeArgs`（`cli-args.ts`）时不传 `--disallowedTools`，所有角色都能用 Agent 工具。适配器包（`packages/adapters/src/claude-code/args.ts`）支持这个参数，工作台没用。
- Codex：codex-cli 0.162.0 的 `multi_agent` 是 stable、**默认开**（`codex features list` 实测），`multi_agent_v2` 默认关。工作台没关，Codex 窗口随时能开子 agent。
- Grok：适配器的 `--no-subagents` 只对 headless 生效，工作台用的 agent 层没有这个参数（`grok-build/command.ts` 注释）。
- 说明书：`base.md`、`manager.md`、`worker.md` 都没提子 agent。

cc-pane 也只在 skill 文案里约定「子 agent 只做只读调研」，靠 worktree 兜底。我们没有 worktree，所以要在启动参数上拦。

## 2. 规则

| 角色 | Claude | Codex | Grok |
|---|---|---|---|
| 管理者 | 禁 `Agent` | 关 `multi_agent`、`multi_agent_v2` | 只靠说明书（见 §5） |
| 监管者 | 禁 | 关 | 同上 |
| 规划 | 禁 | 关 | 同上 |
| 检查 | 禁 | 关 | 同上 |
| 执行 | 禁（Tony 2026-10-24 定，见 §6） | 关 | 同上 |
| 调研（新角色，见 §3.5） | 禁 | 关 | 同上 |
| 普通（none，用户自己开的） | 不限 | 不限 | 不限 |

普通窗口是用户自己在用的 CLI，不替用户做决定。

子 agent 原来干的那些小活（只读调研、核对几处代码），改由**看得见的调研小窗**来做（§3.5），内容不脱离管理者和监管者。

## 3. 改动

### 3.1 Claude

- `BuildInteractiveClaudeArgsInput` 加 `disallowedTools`。拼参数时放在 `--allowedTools` 旁边，后面紧跟一个不可变参数的选项（现有代码已经这样防开场白被吞，照做）。
- `launch-cli.ts` 按角色传 `["Agent"]`。角色到工具的映射写成一个纯函数（如 `workbench/role-tool-policy.ts`），Claude、Codex 共用一张表，有单测。
- 真机核对一件事：`yolo`（`--dangerously-skip-permissions`）下 `--disallowedTools` 是否仍然生效。不生效就改写进每个窗口自己的 `--settings` 文件（`permissions.deny`），同样不碰 `~/.claude`。

### 3.2 Codex

- `launch-cli.ts` 给受限角色加 `-c features.multi_agent=false -c features.multi_agent_v2=false`，走现有 `configOverrides`。
- 真机核对：开出来的 Codex 窗口工具列表里没有 `spawn_agent`；`resume` 续接也带上。
- 不改 `~/.codex/config.toml`（Codex 桌面版共用它）。

### 3.3 运行中改角色

`set-role.ts` 现在只往终端写一行「请先阅读……」，不重启，启动参数不变。普通窗口改成管理者后仍能开子 agent。

改为：新旧角色的工具策略不同时，按 `ffpane_set_model_effort` 已有的重启路径续接重启（有编号续接、没聊过冷重启）。窗口在忙就排队，空闲了再重启。返回值写明「已生效」或「排队中」。

### 3.4 说明书

- `base.md` 加一句：要人手就用 `ffpane_open_window` 开窗口，或用 `ffpane_request_research` 要调研；没有子 agent。
- `worker.md`：没有子 agent；要查代码、核对资料，自己查或发调研请求（§3.5）。
- `manager.md`：写代码的活开执行；只读的小调研开调研小窗，或交给监管者开。
- `supervisor.md`：见 §3.5 第 4 条。
- 中文说明书改完核对 2KB 上限（`manager.md` 已接近）。

### 3.5 调研小窗：子 agent 的替代

Tony 2026-10-24 定：不留子 agent。原来交给子 agent 的小活，由管理者或监管者开一个看得见的窗口来做，结果交回来，内容不脱离管理者。这类小活交给监管者开，监管者也就不再只是挂着等事件的挂件，回到原本「帮管理者照看执行」的设计。

1. **新角色「调研」（researcher）。**
   - 只读（`read-only`），只回答一个问题。
   - 答案写进 `.ffpane/briefs/调研-<编号>.md`，每条结论附 `文件:行号` 或命令输出作证据。
   - 用 `ffpane_report` 交回路径，done 时带 `closeAfter: true` 自关。
   - 说明书 `researcher.md` 很短：只读、只答这一个问题、不扩大范围、不改文件、没有子 agent。
   - 默认用便宜模型、低思考强度，和监管者同一档。
2. **谁能要调研。**
   - 执行、检查、规划用新工具 `ffpane_request_research`：参数是问题、要看的范围（路径）、想要的答案形式。
   - 请求发给自己的监管者；没有监管者或监管者不在线，发给管理者。
   - 发完不用干等，可以接着做别的，或结束这一轮等结果。
3. **谁来开。**
   - **监管者**：在线监管时，`ffpane_wait_events` 会收到「调研请求」事件，由它开调研小窗。
   - **管理者**：自己想查什么时，也开调研小窗，不用子 agent。写代码的活照旧开执行，写 brief。
4. **监管者开窗的限制（代码里拦）。**
   - 只能开「调研」角色；权限只能是 `read-only`（现有「权限只往下放」的规则本来就把监管者开的窗口压到只读）；
   - 同时最多 2 个；
   - 不能开执行、检查、规划，派活仍是管理者的事；
   - `supervisor.md` 里「不写代码、不改项目、不给执行下命令」不变，加一条：收到调研请求就开调研小窗；结果回来先看证据齐不齐，不齐就让它补，齐了再交。
5. **结果怎么走。**
   - 调研小窗报 done → 平台把结果路径投给**提请求的那个窗口**，同时抄送开窗的监管者或管理者。
   - 消息里只传路径，不传正文（现有规则）。
   - 管理者从监管者的近况和 `ffpane_list_windows` 能看到开过哪些调研、结论在哪。
6. **和别的计划的关系。**
   - 调研小窗做完自关，活得短，占内存少。
   - 问题台账、计划评审里要补查的点，也可以用调研小窗（[计划评审计划](./计划评审计划.md)）。

## 4. 验收

1. 单测：角色 × 运行时的参数表；`--disallowedTools` 不吞开场白；续接也带限制。
2. 真机 Claude 2.1.302：开管理者（yolo）让它开子 agent，工具不可用；普通窗口照常能用。
3. 真机 codex-cli 0.162.0：开执行，工具列表没有 `spawn_agent`；续接后仍没有；`~/.codex/config.toml` 没变。
4. 普通窗口改成管理者：重启后被限制；在忙时排队，返回「排队中」。
5. e2e：开窗口的参数里带上限制（看主进程拼出的 argv，不依赖真 CLI）。
6. 调研小窗：执行发 `ffpane_request_research` → 在线的监管者收到事件、开调研小窗（只读）→ 调研写结论、报 done 自关 → 结果路径投到执行，抄送监管者。e2e 覆盖整条链路。
7. 监管者开执行、开检查、开可写窗口、同时开第 3 个调研：都被拒绝，原因写清。
8. 没有监管者或监管者不在线：调研请求转给管理者。

## 5. 已知缺口

Grok agent 层没有关子 agent 的参数，只能靠说明书。工作台里 Grok 窗口少，先记下；以后 Grok 出参数再补。

## 6. 已定（Tony 2026-10-24）

- **执行也不留子 agent**，包括只读的 Explore。所有角色（普通窗口除外）一律禁。
- 子 agent 原来干的小活，交给管理者或监管者开的调研小窗（§3.5）。内容不脱离管理者；监管者也有活干，不当挂件。
- 因此不需要核实「只禁某几种子 agent」的写法。
