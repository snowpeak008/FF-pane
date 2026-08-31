# Aider 适配器调研（T7.3b）

- **调研版本：** aider 0.86.2（`aider --version`），Windows 11，Python 3.12.4
- **安装方式：** `uv tool install aider-chat --python 3.12`（**隔离安装**，未污染全局 site-packages）
  - 虚拟环境落在 `%APPDATA%\uv\tools\aider-chat\`，可执行垫片 `~/.local/bin/aider.exe`（该目录已在用户 PATH 上）
  - pypi.org 直连三次重试全部超时，改走 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple` 装成
- **调研日期：** 2026-08-31
- **调研方式：** 真机运行 + 随装源码逐项核对（`%APPDATA%\uv\tools\aider-chat\Lib\site-packages\aider\`）
- **fixture：** `packages/adapters/fixtures/aider/`（**全部真机录制**，模型端为本地假服务，见该目录 README）

> **关于「真机」的口径**：与 grok-build 同法——用 `fixtures/tools/fake-openai-server.mjs`
> 起一个本地 OpenAI 兼容端点替换模型这一环。被录制的是**真实 CLI 的真实行为**：文件真的被写、
> git 真的被提交、退出码真的是那个值、残留文件真的落地，只有对话方是可复现的脚本。

---

## 0. 结论先行：这一家与前五家最大的不同

**aider 没有任何机器可读的输出模式。** 没有 `--output-format`，没有 JSONL/NDJSON 事件流，
没有 `--json`。`aider --help` 的 520 行里与输出相关的开关只有
`--pretty/--no-pretty`（要不要 ANSI 上色）、`--stream/--no-stream`（要不要流式）、
以及一堆 `--*-color`。stdout 是**给人看的终端流水**：aider 自己的状态行与模型的回答正文
混在同一条流里，**没有任何前缀或分隔符**。

因此本适配器与前五家的形态差异是结构性的，而非参数选择上的：

- 事件识别只能靠**扫描锚定的标记行**（`Applied edit to <path>` 一类），见 §2.2；
- 变更正文（diff）必须**自己用 git 快照补**，与 codex 同法（§2.4）；
- 命令执行事件**结构性地不存在**（§4）；
- 「成功」不能看退出码（§3）。

这不构成计划冲突熔断的条件：headless 仍可可靠驱动（提示词进得去、编辑落得下、
收尾判得出、残留清得干净），只是能力声明里 no/partial 偏多。如实声明即可，见 §6。

---

## 1. Headless / 非交互模式

### 1.1 启动命令

```text
aider --message <PROMPT> [OPTIONS]
aider --message-file <PATH> [OPTIONS]
```

- 交互式 TUI 与 headless 是同一个入口；给了 `--message` / `--message-file` 就「答完即退」
  （help 原文：`process reply then exit (disables chat mode)`）。
- **一次进程 = 一轮**，与 codex / grok 同构。多轮靠 `--restore-chat-history` 续接（§5）。
- stdin 无用途，spawn 时直接关闭（实测全程未读 stdin）。
- **冷启动约 8 秒**（实测 `real-*` 各份录制，从进程起到第一条模型请求发出）。litellm +
  tree-sitter 的导入开销，超时预算要把它算进去。

### 1.2 必开参数与理由

下表是适配器**固定下发**的一整套。分成三组，每组都不是可选项：

**（一）headless 能跑起来**

| 参数 | 作用 | 不给会怎样 |
|---|---|---|
| `--message-file <PATH>` | 提示词从文件读 | 见 §7.2：位置/长度/转义三重风险 |
| `--model <MODEL>` | 指定模型 | **触发 onboarding，会弹浏览器**，见 §7.3 坑 1 |
| `--yes-always` | 自动答确认 | 版本说明、加文件入会话等询问会挂住 |
| `--no-pretty` | 关 ANSI 上色 | 标记行里混进色码（管道输出时 aider 会自动关，此项是双保险） |
| `--no-fancy-input` | 关 prompt_toolkit | 同上，管道下自动关 |
| `--no-check-update` | 不查更新 | 多一次网络往返 + 额外输出行 |
| `--no-show-release-notes` | 不问版本说明 | 多一次询问（`--yes-always` 会答 y 并打印一段） |
| `--no-show-model-warnings` | 不因模型元数据缺失而询问 | 自定义模型名会多一次询问 |
| `--encoding utf-8` | 读写编码 | 中文提示词/文件在 GBK 默认页下乱码 |

**（二）不许动用户仓库（§8 红线，逐条实测见 §8.1）**

| 参数 | 拦住的默认行为 |
|---|---|
| `--no-gitignore` | **默认会把 `.aider*` 写进用户的 `.gitignore`**（没有该文件就新建一个） |
| `--no-auto-commits` | **默认会 git commit**（aider 自己攒提交信息，再花一次模型调用） |
| `--no-dirty-commits` | 默认会把用户**跑之前就有的**脏改动一并提交 |
| `--map-tokens 0` | 默认在仓库里建 `.aider.tags.cache.v4/` 目录（repo-map 的 tags 缓存） |
| `--chat-history-file <TMP>` | 默认写 `<git 根>/.aider.chat.history.md` |
| `--input-history-file <TMP>` | 默认写 `<git 根>/.aider.input.history` |
| `--no-analytics` | 默认在 `~/.aider/` 下写 `analytics.json`、`installs.json`、`caches/…json` 并可能上报 |

**（三）行为确定、不额外花钱**

| 参数 | 理由 |
|---|---|
| `--no-auto-lint` | 默认**开**：编辑完自动起 `python -m flake8` 子进程，有错就**自动再花一轮模型钱**去修（`real-autolint-fix.stdout.txt` 实录） |
| `--no-auto-test` | 默认关，显式写上防配置漂移（§7.4） |
| `--no-suggest-shell-commands` | headless 下命令**永远执行不了**（§4），开着只是白烧 token，且在 `whole` 编辑格式下 ```` ```bash ```` 围栏会撞坏编辑解析器（§7.3 坑 3） |

### 1.3 必设环境变量

| 变量 | 值 | 理由 |
|---|---|---|
| `COLUMNS` | `1000` | **不设会导致标记行被硬折行**，见 §7.3 坑 2 |
| `PYTHONIOENCODING` / `PYTHONUTF8` | `utf-8` / `1` | 中文提示词与中文文件内容 |
| `NO_COLOR` | `1` | 与 `--no-pretty` 同向的双保险 |
| `OPENAI_API_KEY`（或对应 Provider 的密钥变量） | 明文 | §4.3 密钥红线的唯一下发通道，正合（§5.2） |

### 1.4 `--analytics-disable` 是错的那一个

`--analytics-disable` 的 help 原文是「**Permanently** disable analytics」——它会往
`~/.aider/analytics.json` 落一个持久标记，**改的是用户的 HOME**。要的是「本轮不上报」，
该用 `--no-analytics`（实测：加 `--no-analytics` 后 `~/.aider/` 整个目录都不会被创建，
`real-success-edit.meta.json` 的 `homeFiles: []` 即此）。

---

## 2. 输出形态（stdout 是人类流水）

### 2.1 一次成功编辑的完整 stdout（真实录制，`real-success-edit.stdout.txt`）

```text
Detected dumb terminal, disabling fancy input and pretty output.

Aider v0.86.2
Model: openai/ffpane-fixture-model with whole edit format
Git repo: .git with 1 files
Repo-map: disabled


readme.txt
I will append a line to the readme.

readme.txt
```
hello world
hello aider
```

Tokens: 672 sent, 23 received.
Applied edit to readme.txt
```

逐段说明（这是全部结构，没有更多）：

1. 第一行 `Detected dumb terminal…`：**stdout 不是 tty 时 aider 自动关掉 pretty 与 fancy input**。
   这条是好消息（不必依赖 `--no-pretty` 生效），但它本身也是一行要跳过的噪声。
2. 四行开场横幅：版本、`Model: <模型> with <编辑格式> edit format`、`Git repo: …`、`Repo-map: …`。
   **编辑格式从这里读得到**，对判读后面的正文有用（§7.3 坑 3）。
3. 裸一行 `readme.txt`：这是 aider 把文件纳入本轮会话时打印的 subject 行。
   **它与模型正文长得一模一样**，没有前缀——这正是「不能靠行内容猜语义」的例证。
4. 模型回答正文**原样回显**，含它写的 ```` ``` ```` 围栏与文件清单。
5. `Tokens: 672 sent, 23 received.`：token 统计。带缓存/费用时形如
   `Tokens: 2.4k sent, 16 received.`（**会用 k 缩写**，见 `real-shell-declined.stdout.txt`）。
6. `Applied edit to readme.txt`：**唯一可靠的「文件真的被改了」标记**。

### 2.2 适配器认的标记行（全部出自随装源码，附文件:行号）

| 标记（行首锚定） | 源码位置 | 语义 |
|---|---|---|
| `Applied edit to <path>` | `coders/base_coder.py:2334` | 编辑已落盘。path 相对 git 根 |
| `Did not apply edit to <path> (--dry-run)` | 同上 `:2332` | `--dry-run` 下的空转 |
| `Committing <path> before applying edits.` | 同上 `:2188` | 编辑前先提交（`--no-dirty-commits` 已拦掉） |
| `The LLM did not conform to the edit format.` | 同上 `:2310` | 编辑块解析/匹配失败，随后 aider **自动重试一轮** |
| `# N SEARCH/REPLACE block(s) failed to match!` | `coders/editblock_coder.py:84` | 上一条的明细 |
| `Running <command>` | `coders/base_coder.py:2472` | 模型请求的命令**真的执行了**。headless 下**永不出现**（§4） |
| `## Running: <command>` | `linter.py:65,148` | aider 自己的 lint 子进程（仅非零退出时打印） |
| `Tokens: <N> sent, <M> received.` | `io.py` | token 统计，支持 `2.4k` 缩写 |
| `litellm.<ErrorName>: …` | litellm 直出 | 模型侧错误，**退出码仍是 0**（§3） |
| `Model: <model> with <fmt> edit format` | `main.py` 横幅 | 实际模型与编辑格式 |

**刻意不做的事**：不去解析模型正文里的编辑块（```` ``` ```` 围栏 / `<<<<<<< SEARCH`）。
理由与仓库既有纪律一致（gemini 适配器踩过回溯炸弹）：围栏与 SEARCH/REPLACE 块是
**可嵌套、可重复**的结构，正文里还会出现 aider 自己回显的同款文本，用行内正则去啃
必然要么漏要么炸。真相在标记行与 git 里，不在正文里。故 mapper 是**逐行手写扫描器**，
只做行首前缀匹配（`scanAiderLine`），无一处多行/回溯正则。

### 2.3 流式是真的（token 级，实测有时间戳）

用一个每 400 ms 吐一个词的本地 SSE 端点录到的 stdout 分块时间戳：

```text
ms=8909  "Streaming"     ms=9311  " chunk"    ms=9728  " one."
ms=10131 " Streaming"    ms=10534 " chunk"    ms=10939 " two."
ms=11340 " Done."     ms=11347 "\r\n"      ms=11347 "Tokens: 611 sent, 10 received."
```

每个 SSE delta 即时落到 stdout，间隔与服务端发牌节奏一一对应（`--no-pretty` 下
aider 走 `sys.stdout.write` + flush）。故 `streaming: "yes"` 是实测结论，不是推测。

代价：**文本增量与标记行共用一条流**，且增量不带换行。适配器的扫描器必须按
「行缓冲 + 未完成行暂存」处理，把不成行的片段当答案文本即时吐出，遇到换行再判定
该行是否是标记行——这就是 `mapper.ts` 里 `pending` 行缓冲的由来。

### 2.4 变更正文只能自己补

`Applied edit to <path>` 只给路径，**不给 diff**，与 codex 完全同构（codex.md §2.3）。
故沿用同一方案：turn 前 `git status --porcelain` 记基线，收到标记后对该路径跑 `git diff`
（未跟踪文件走 `git diff --no-index`）。全部只读，绝不动 index 或工作区。
补不到就让 `diff` 字段缺席，不造假空 diff。实现见 `src/aider/git-diff.ts`。

---

## 3. 退出码撒谎，而且撒得比前五家都彻底

这是本家的头号坑。实测退出码只有三个取值：

| 码 | 何时出现 | 实测 fixture |
|---|---|---|
| **0** | 正常跑完 **以及几乎所有失败** | 见下 |
| 1 | 进程被强杀（`taskkill /T /F`） | `real-killed.meta.json` |
| 2 | 命令行参数错误（argparse）。**usage 走 stderr，stdout 一个字节都没有** | `real-badargs.meta.json` + `.stderr.txt` |

**退出码 0 覆盖的失败场景（逐条实测）：**

1. **密钥错误**：`litellm.AuthenticationError: … Incorrect API key provided`，退出 **0**
   （`real-auth-invalid-key`）。
2. **密钥缺失**：`litellm.AuthenticationError: … The api_key client option must be set`，退出 **0**。
3. **端点整个不可达**：litellm 退避重试 **9 次**（0.2→0.5→1→2→4→8→16→32 秒，合计 ~64 秒），
   全败后退出 **0**，一个字都没改。
4. **编辑块匹配失败**：`# 1 SEARCH/REPLACE block failed to match!`，退出 **0**（`real-edit-failed`）。
5. **模型请求的命令被静默拒绝**：什么都没跑，退出 **0**（`real-shell-declined`，见 §4）。

结论：**`exitCode === 0` 不承载任何成功语义**，只有 1 与 2 有判据价值。
成败一律由扫描到的标记行裁定（`mapper.ts` 的 `finalize`）：
见到 `litellm.*Error` → failed 并把原文写进 message；见到编辑格式失败 / 命令被拒 →
攒进阻断证据、整轮 failed；都没有且至少有一条 `Applied edit to` 或答案文本 → completed。

**另记一条实测异常**：约 20 轮探测中出现过 **1 次** 启动即崩，退出码 `3221225477`
（`0xC0000005` 访问违例），stdout 只有第一行、零次模型调用。未能复现，故不作为
稳定行为写进映射表，但它是「流可能毫无预兆地断在任何位置」的又一个证据——
兜底信号只能是进程退出（与前五家同一条结论）。

---

## 4. 命令执行：headless 下结构性为零

模型在回答里请求跑命令时，aider 走 `handle_shell_commands`
（`coders/base_coder.py:2450`），它调 `io.confirm_ask(..., explicit_yes_required=True)`。
而 `io.py:867` 是：

```python
if self.yes is True:
    res = "n" if explicit_yes_required else "y"
```

**`--yes-always` 对「需要明示同意」的询问一律答「否」。** 于是：

- 命令**不会执行**（不会出现 `Running <command>` 标记行）；
- stdout 上唯一的痕迹是那行**裸命令文本**（confirm 的 subject），与模型正文无从区分；
- 退出码 0。

`real-shell-declined.stdout.txt` 实录尾部就是：

```text
Tokens: 2.4k sent, 16 received.

node -v
```

这正是四份 T2.0 调研共同点名的「权限拒绝伪装成功」在 aider 上的形态，而且比前五家更隐蔽:
**连一个结构化的 denied 状态都没有**。适配器的应对是 §2.2 里那条判据——
`Running <cmd>` 出现 = 真跑了，不出现 = 被静默拒了；后者若能识别出来（模型正文里出现了
被 aider 回显的裸命令行）就攒进阻断证据，让 Run 至少留下「本轮想跑命令但没跑成」的记录。

aider 自己的 lint / test 钩子（`--lint-cmd` / `--test-cmd`）**确实会**起子进程，但：
linter 只在非零退出时打印 `## Running: <cmd>` 且**不给退出码**；`cmd_test` 走 `cmd_run`，
**连命令标记行都不打印**（`commands.py:1003`），只把输出混进流里。

故 `commandEvents` 声明为 **no**，且 mapper **不把 `## Running:` 映射成 `command` 事件**
（只记 `raw` + note）。宁可声明为零并把证据留在 raw 日志里，也不要一边声明 partial
一边让编排层等一个永不到来、且无退出码可判的证据。

---

## 5. 会话恢复与密钥

### 5.1 恢复：有，但不是「原生会话 ID」

aider 没有会话 ID，也没有会话存储。续接的唯一机制是
`--chat-history-file <PATH>` + `--restore-chat-history`：aider 把整轮对话写成
**Markdown 流水**，下一轮从同一个文件把它解析回消息列表。

**真机验证（`real-restore-history.*`）**：第一轮告知一个随机口令，第二轮加
`--restore-chat-history` 追问。把假模型收到的请求体 dump 下来数：10 条消息，
其中 `[5]` 是首轮的 user 提示词、`[6]` 是首轮的 assistant 回答，口令逐字符一致。
**上下文确实回填了**，不是从「模型答对了」反推的。

四条限制，故声明 partial 而非 yes：

1. **没有 ID**。适配器把「会话」表达为它自己管理的那个 transcript 文件路径
   （落在系统临时目录的 per-session 目录，**不在用户仓库里**），`nativeSessionId` 就是这个路径。
   这是适配器造出来的凭据，不是 CLI 给的。
2. **transcript 是 Markdown，往返有损**。用户行带 `#### ` 前缀、aider 的状态行带 `> ` 前缀，
   解析回来时靠这些前缀分辨角色——回答正文里若出现同款前缀就会串味。
3. **全有或全无**。没有「从第 N 条续」，`--restore-chat-history` 恢复整个文件。
4. **transcript 必须跨轮存活**，与「轮次结束清理临时文件」直接冲突。
   取舍：提示词文件逐轮即删，transcript 按会话保留、会话结束才删（§8.2）。

**顺带一条红线证据**：transcript 里逐字记录了**完整命令行**（`real-restore-history` 的
`chat.md` 第 4 行即是）。这是「密钥永不进命令行」（§4.3）之外的又一条独立理由——
进了 argv 的东西会被 aider 自己抄进一个 Markdown 文件。

### 5.2 密钥：env 单通道成立

| 方式 | 说明 | 与本产品的关系 |
|---|---|---|
| `OPENAI_API_KEY` 等环境变量 | litellm 标准变量 | **首选且唯一采用**：正落在 §4.3「只经 env 下发、不落盘不进命令行」内 |
| `--openai-api-key` / `--api-key P=K` | 命令行 | **禁用**：进程列表可见 + 被抄进 transcript（§5.1） |
| `--env-file` / 仓库 `.env` | 文件 | **禁用（作为密钥通道）**：落盘。但它会主动生效，见 §7.3 坑 4 |

**aider 没有 `cli_login` 类型的登录态**：没有 `aider login`，没有自管凭证文件，
认证完全由 litellm 按 Provider 读环境变量。故 **auth-probe 不为 aider 加规则**，
`CLI_LOGIN_RUNTIMES` 也不增补 `aider`——那个模块探测的是「CLI 自管的登录态」，
aider 压根没有这个东西，加一条只能得到恒为 unknown 的假结论。
（Provider 侧的 API key 是否可用，由既有的 provider-probe 路径负责，与本单无关。）

---

## 6. 六项能力声明核对（对照设计文档 §5.1）

| # | 能力 | 结论 | 依据 |
|---|---|---|---|
| 1 | 原生会话恢复 | **部分** | `--restore-chat-history` 真机验证上下文回填成立；但无会话 ID、凭据是适配器自管的 transcript 文件路径、Markdown 往返有损、只能整份恢复（§5.1） |
| 2 | 流式输出 | **是** | token 级真增量，实测每个 SSE delta 即时落 stdout，时间戳与服务端发牌一一对应（§2.3） |
| 3 | 文件修改事件 | **部分** | `Applied edit to <path>` 给路径与成功事实，**不给 diff**；diff 由 git 快照自补（与 codex 同档）。失败路径无结构化标记，只有一段人类文本（§2.2 / §2.4） |
| 4 | 命令执行事件 | **否** | headless 下模型请求的命令**结构性地不执行**（`--yes-always` 对 explicit_yes_required 答否）；aider 自己的 lint/test 钩子无退出码、test 连标记行都没有（§4） |
| 5 | 权限请求转发 | **否** | 无审批回执通道。`--yes-always` 是进程级开关，且对「需明示同意」的项目自动答否，连拒绝事实都不结构化上报（§4） |
| 6 | 中途取消 | **部分** | 无优雅协议，只能树杀；退出码 1，无终止标记，已落盘的编辑不回滚（§7.5） |

**额外如实报一项：MCP 注入 = 否。** aider 0.86.2 **完全不支持 MCP**——`--help` 全文无
mcp 字样，随装源码里也没有对应模块。故 T6.6 的知识库只读检索工具**在本 Runtime 上不可用**，
适配器忽略 `ctx.mcpServers`。这与 grok-build 的「有 MCP 但只能改用户全局配置」不同：
这里是能力本身不存在，没有取舍空间。

---

## 7. 适配器实现建议

### 7.1 事件映射表

| aider stdout | → FF-pane AgentEvent |
|---|---|
| 开场横幅四行 + `Detected dumb terminal…` | `raw`（note 标注是横幅） |
| 模型答案增量（非标记行） | `text`（channel=answer, final=false），流末补一条 final |
| `Applied edit to <path>` | `file_change`（changeKind 由 git 基线判 add/update；diff 由 git 补） |
| `Did not apply edit to <path> (--dry-run)` | `file_change`（status=started，无 diff；dry-run 没真改） |
| `The LLM did not conform to the edit format.` / `# N SEARCH/REPLACE …` | `raw` + 攒进阻断证据 |
| `## Running: <cmd>`（aider 自己的 lint） | `raw`（**不**映射为 command，§4） |
| `Running <cmd>` | `command`（status=completed，无 exitCode；headless 下不会出现，留着是为了不说谎） |
| `Tokens: N sent, M received.` | 累加进 end 的 usage |
| `litellm.<X>Error: …` | 登记终止事实 → `end`(failed) |
| 收尾 | `session_start`（transcript 路径 + cwd）+ 恰好一条 `end` |

`session_start` 在**开头**就能发（与 grok 相反）：transcript 路径是适配器自己定的，
不用等 CLI 给 ID。这是 partial 恢复能力的一点便利。

### 7.2 提示词走 `--message-file`

`--message` 与 `--message-file` 都存在，选后者，三条理由：

1. 任务合同/交接包动辄数千字，作命令行参数要顶着 Windows 32767 字符上限；
2. 含换行、引号、`%VAR%`、反引号时转义风险高（实测一份含双引号/单引号/反引号/`%PATH%`/
   中文的多行提示词经 `--message-file` 原样送达）；
3. **`--message` 的内容会被 aider 抄进 transcript 的命令行那一行**（§5.1），
   `--message-file` 只抄一个路径。

临时文件落**系统临时目录**、轮次结束即删——用户的仓库不该因为跑过一轮而多出任何东西。

### 7.3 五个最关键的坑

**坑 1：无密钥启动会弹浏览器，而 `--yes-always` 会替用户点「是」。**

不给 `--model` 且环境里没有任何 API 密钥时，aider 进入 onboarding：

```text
No LLM model was specified and no API keys were provided.
OpenRouter provides free and paid access to many LLMs.
Please open this URL in your browser to connect Aider with OpenRouter:
https://openrouter.ai/auth?callback_url=http://localhost:8484/callback/aider&code_challenge=…
Waiting up to 5 minutes for you to finish in the browser...
```

它会**真的唤起默认浏览器**、在 localhost:8484 起一个回调服务端、然后**原地等最多 5 分钟**。
带着 `--yes-always`，那句「要不要用浏览器连 OpenRouter」被自动答成「是」，于是无人值守的
headless 进程变成了一个抢用户焦点、挂着不退的僵局（本次调研有一轮因此挂了 164 秒，
最后是被外部杀掉的——那个 exit 1 不是 aider 的失败形态，是在等浏览器授权）。

**这是本调研代价最大的一条教训，也是适配器的一条硬约束**：`--model` 与密钥 env
**两者必须同时下发**，缺一不可。help 里没有 `--no-onboarding` 一类的开关，
唯一的关闭方式就是「让它没有理由进 onboarding」。适配器在 `startTurn` 里对这两项
做**启动前快速失败**（`failFastTurn`），宁可一条 end(failed) 说清原因，
也不让一个会弹窗的进程起来。

**坑 2：标记行会被硬折行。** aider 用 rich 输出，按终端宽度折行。管道下 rich 取
`COLUMNS`，取不到按 80 算。实测 `COLUMNS=100` 时：

```text
litellm.AuthenticationError: AuthenticationError: OpenAIException - The api_key client option must
be set either by passing api_key to the client or by setting the OPENAI_API_KEY environment
variable
```

一条错误被切成三行。`COLUMNS=1000` 时同一条是完整一行。**扫描器认的是行首前缀，
折行会让第二段以后完全认不出来**（更糟：`Applied edit to <很长的路径>` 会被折断，
路径直接丢一半）。故 `COLUMNS=1000` 是必设项，不是调优项。

**坑 3：编辑格式决定正文长什么样，而围栏会撞坏解析器。**

- 未知模型（自定义 Provider 常见）落到默认 `whole` 格式：整份文件回传，
  形如「文件名一行 + ```` ``` ```` 围栏包住全文」。
- 已知模型多为 `diff` 格式：`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 三段块。
- **在 `whole` 格式下，模型回一个 ```` ```bash ```` 围栏会被当成「缺文件名的文件清单」**：
  实测报 `No filename provided before ``` in file listing` + `The LLM did not conform to the
  edit format.`，然后**白花一轮重试**。这也是 `--no-suggest-shell-commands` 该常开的原因之一。

横幅行 `Model: <m> with <fmt> edit format` 能读出实际格式，适配器把它记进 `raw` 的 note，
排障时不必猜。

**坑 4：用户仓库里的 `.env` 会覆盖 FF-pane 注入的环境变量。**

aider 启动时按顺序加载 `~/.env` → `<git 根>/.env` → `<cwd>/.env` → `--env-file` 指定的文件，
**每一个都用 `override=True`**。后果是：

- 仓库里有 `.env` 时，它的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` **压过**我们经 env 注入的值。
  实测（`real-repo-dotenv-hijack`）：注入指向一个无人监听的端口、仓库 `.env` 指向假模型，
  结果对话**真的从仓库 `.env` 那条路走通了**——即「Run 实际用的 Provider 与 Profile 配置不一致」。
- `--env-file` 是**追加**在搜索列表最后而非替换，故它指向的文件**能**压过仓库 `.env`；
  但那意味着把密钥写进一个文件，与 §4.3 相抵触，**不采用**。
- `--set-env K=V` 在 dotenv 加载**之后**才写 `os.environ`，故也能压过仓库 `.env`，
  且不落盘。**采用**：`ctx.configOverrides` 映射为 `--set-env`（与 codex 的 `-c` 同款
  「通用通道、按 Runtime 解释」）。但它进 argv，故适配器**拒绝**把任何名字命中
  `isApiKeyEnvName` 的键放进 `--set-env`（`command.ts` 里 `assertNoSecretInSetEnv` 快速失败）。

**结论与如实交代**：密钥这一环没有既不落盘、又能压过仓库 `.env` 的手段。
适配器的处置是**探测并留证**：spawn 前检查 `<cwd>/.env` 与 git 根 `.env` 是否存在，
存在就发一条 `raw` 诊断进事件流（Run 的 raw 日志因此留下「本轮环境可能被仓库 `.env` 改写」），
并在 `diagnostics()` 里列出。**不静默、不代替用户决定**。这一项列入 §9 待决策事项。

另附：`.aider.conf.yml`（HOME / git 根 / cwd 三处）与 `AIDER_*` 环境变量（**每个开关都有一个**）
也能改默认值，但优先级是「命令行 > 环境变量 > 配置文件 > 默认值」，实测下发
`--no-auto-commits` / `--map-tokens 0` 能压过仓库 `.aider.conf.yml` 里的 `auto-commits: true` /
`map-tokens: 4096`。**这就是 §1.2 那张表必须整套显式下发、不能依赖默认值的原因**：
默认值随时可能被用户仓库或用户 shell 改掉，而其中七条是红线。

**坑 5：新建文件会被 git add 进索引。**

即使 `--no-auto-commits`，aider 对它新建的文件仍会 `git add`。实测
（`real-success-newfile.meta.json`）：`git status --porcelain` 是

```text
AM notes/hello.md
 M readme.txt
```

`A` = 已进索引。这不是残留（文件本身就是任务产物），但**用户的 git 索引状态被改了**，
与「只读 git」的期望有出入，故如实记在此处：适配器不去撤销它（撤销才是真的乱动用户仓库），
但 diff 采集必须同时看工作区与索引两侧（`git diff` + `git diff --cached`），
否则新建文件的 diff 会取不到。

### 7.4 进程模型

- 一轮一 spawn，与 codex / grok 同构；续轮靠 transcript，故接口上不需要 `send()`。
- `aider.exe` 是 Python 控制台脚本垫片（PE 可执行，非 `.cmd`），无 npm 垫片那套多行参数
  截断问题；但 Windows PATH 解析（`Path` vs `PATH`）的坑仍在，沿用既有
  `findExecutableOnWindowsPath`。
- stdin 关闭。stderr 只在 argparse 报错时有内容（那时 stdout 为空），仍必须消费（背压约定）。
- 超时预算要覆盖：8 秒冷启动 + litellm 最坏 ~64 秒退避重试 + 模型本身耗时。

### 7.5 取消

无优雅取消协议。只能树杀（`taskkill /PID <pid> /T /F`）：

- 实测 stdout 停在横幅后，**无任何终止标记**，stderr 为空，退出码 **1**（`real-killed`）。
- 已落盘的编辑**不回滚**；`--no-auto-commits` 下它们留在工作区，用户可自行 checkout。
- transcript 里留着半截轮次，下一轮 `--restore-chat-history` 会把它一起恢复。

---

## 8. 仓库残留：红线与实测

### 8.1 默认值有多脏 vs 下发全套开关后有多干净

同一段提示词、同一个假模型脚本，两份真实录制的 `meta.json` 对照：

| | `real-defaults-residue`（只给最小参数） | `real-success-edit`（下发 §1.2 全套） |
|---|---|---|
| 仓库文件 | `.aider.chat.history.md`、`.aider.input.history`、`.aider.tags.cache.v4/`、**`.gitignore`**、`.git`、`readme.txt` | `.git`、`readme.txt` |
| git 历史 | `docs: append greeting to readme` ← **aider 自己造的 commit**、`init` | `init` |
| `git status` | `?? .gitignore` | ` M readme.txt`（就是任务产物） |
| `~/.aider/` | 存在 | **不存在** |

**最阴的一条**：aider 把 `.aider*` 写进 `.gitignore` 之后，那三个残留文件在
`git status` 里**就看不见了**。「跑完 `git status` 是干净的」不等于「仓库没多东西」——
这也是真机冒烟里「用户仓库无残留文件」那条判据要用 `dir` 列目录、而不是用
`git status` 来判的原因。

### 8.2 临时文件的生命周期

| 文件 | 落点 | 何时删 |
|---|---|---|
| 提示词 `ffpane-aider-prompt-*.txt` | 系统临时目录 | 轮次结束（正常/取消/消费方 break 都删） |
| transcript `chat.md` + `input.history` | 系统临时目录下 per-session 目录 | **会话结束**（跨轮存活，§5.1 限制 4） |

两者都**不在用户仓库内**。真机冒烟对这两项各有一条判据。

---

## 9. 需主管理员/用户决策的事项

1. **仓库 `.env` 覆盖注入 env（§7.3 坑 4）**：本单的处置是「探测 + 留证 + 不静默」。
   若要更强的隔离，只有把密钥写进适配器自管的 `--env-file` 一条路，代价是密钥落盘、
   与 §4.3 相抵触。是否为此开一个「用户显式确认后才启用」的设置项，请主管理员裁定。
2. **编辑格式不由适配器指定**：`--edit-format` 留空 = 用 aider 对该模型的默认判断。
   固定成 `diff` 能让正文更紧凑（省 token），但对未知模型可能超出其能力而反复重试。
   本单不替用户选，`AiderAdapterOptions.editFormat` 留作可选项。
3. **真实 Provider 后端未验**：本次全程走本地假模型端点（依主管理员指令，不做任何
   会弹窗/联网授权的探测）。真实后端特有的形态——`Tokens:` 行带 `Cost: $…`、
   缓存 token 的呈现、真实模型在 `diff` 格式下的编辑块——待用户提供可用 Provider 后补录，
   补录命令见 fixtures README。
