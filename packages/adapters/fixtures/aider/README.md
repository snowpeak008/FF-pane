# Aider fixtures（真机录制，模型端为本地假服务）

- **CLI 版本：** aider 0.86.2，`uv tool install aider-chat --python 3.12` 隔离安装
  （venv 在 `%APPDATA%\uv\tools\aider-chat\`，垫片 `~/.local/bin/aider.exe`）
- **录制日期：** 2026-08-31
- **录制环境：** Windows 11，Python 3.12.4，Node v24.15.0
- **录制目录：** `%TEMP%\aiderprobe\rec-repo`（系统临时目录，**非本仓库**；每份录制前重新 `git init` + 一次 `init` 提交）
- **调研文档：** `docs/adapters/aider.md`

## 性质说明：什么是真的，什么是假的

aider 没有任何机器可读的输出格式（见调研文档 §0），所以这里录的是 **stdout 的原始文本流水**
（`.stdout.txt`）+ **进程与仓库的事实**（`.meta.json`：退出码、实际参数、仓库文件列表、
git 历史、git status、HOME 残留、目标文件内容）。单测同时消费两者。

模型这一环用 `packages/adapters/fixtures/tools/fake-openai-server.mjs` 替换
（本地 OpenAI 兼容端点，经 `OPENAI_BASE_URL` 接入）。于是：

- **真的**：stdout 的每一行、标记行的确切措辞、退出码、仓库残留、git 提交与索引状态、
  `.gitignore` 被改写、transcript 的 Markdown 结构、强杀后的截断形态、
  仓库 `.env` 对注入 env 的覆盖。这些全部出自 aider 本体。
- **假的**：模型说了什么。回话由脚本决定，故同样的脚本永远录出同样的流。
- **未覆盖**：真实 Provider 后端特有的形态——`Tokens:` 行带 `Cost: $…`、缓存 token 的呈现、
  真实模型在 `diff` 编辑格式下的编辑块。补录命令见文末。

## 安全纪律（本次录制的硬约束）

1. **每一次调用都同时给 `--model` 与 `OPENAI_API_KEY`**。缺任一项 aider 会进 onboarding
   并**唤起浏览器**做 OpenRouter OAuth，且 `--yes-always` 会把那句询问自动答成「是」
   （调研文档 §7.3 坑 1）。本目录**没有任何一份 fixture 是无密钥录的**，
   复现时也不要这么试——该事实已经有完整证据，无需再实测。
2. 用临时 `HOME` / `USERPROFILE` 录制，用户的 `~/.aider*`、`~/.aider.conf.yml`
   **分毫未动**（各份 `meta.json` 的 `homeFiles` 即当轮 HOME 的全量清单）。
3. 录制目录在系统临时目录，不在本仓库内。

## 文件清单

| 文件 | 内容 | 退出码 |
|---|---|---|
| `real-success-edit.*` | 成功改一个已有文件。横幅 → 裸文件名行 → 模型正文回显 → `Tokens:` → **`Applied edit to readme.txt`**。仓库只剩 `.git` + `readme.txt`，git 历史只有 `init` | 0 |
| `real-success-newfile.*` | 新建 `notes/hello.md`（含中文正文）+ 改 `readme.txt`，两条 `Applied edit to`。`git status` 为 `AM notes/hello.md` —— **新建文件被 git add 进索引**（§7.3 坑 5） | 0 |
| `real-edit-failed.*` | `diff` 格式下 SEARCH 块匹配不上：`The LLM did not conform to the edit format.` + `# 1 SEARCH/REPLACE block failed to match!` + `SearchReplaceNoExactMatch`，aider **自动重试一轮**，文件未改 | **0** |
| `real-shell-declined.*` | 模型请求跑 `node -v`。**命令没执行**，无 `Running` 标记行，stdout 末尾只剩一行裸 `node -v`（confirm 的 subject）。`--yes-always` 对 explicit_yes_required 答否（§4） | **0** |
| `real-auth-invalid-key.*` | 端点回 401：`litellm.AuthenticationError: … Incorrect API key provided`。**一个字没改** | **0** |
| `real-killed.*` | 轮次进行中 `taskkill /T /F`：stdout 停在横幅后，**无任何终止标记**，stderr 为空 | 1 |
| `real-badargs.*` | 未知参数：**stdout 0 字节**，argparse usage 全在 stderr | 2 |
| `real-autolint-fix.*` | `--auto-lint`（默认值）下写了个语法错误的 `bad.py`：aider 起 `python -m flake8` 子进程（`## Running: …`），**自动再花一轮模型钱**修好 | 0 |
| `real-repo-dotenv-hijack.*` | 仓库里有 `.env` 指向假模型、注入的 env 指向无人监听的端口。**对话从仓库 `.env` 走通了** —— 仓库 `.env` 覆盖注入 env（§7.3 坑 4） | 0 |
| `real-restore-history.*` | 两轮。`turn1.stdout.txt` 是第一轮（告知口令）；`stdout.txt` 是第二轮加 `--restore-chat-history`，输出 `Restored previous conversation history.` 且**答出了第一轮的口令**；`chat-history.md` 是 aider 写的 transcript 原文（注意它**逐字记录了完整命令行**，§5.1） | 0 |
| `real-defaults-residue.*` | **只给最小参数**（不下发任何残留控制开关）：仓库多出 `.aider.chat.history.md`、`.aider.input.history`、`.aider.tags.cache.v4/`、被改写的 `.gitignore`，git 历史多出一条 aider 自造的 commit。与 `real-success-edit` 对照即 §8.1 那张表 | 0 |

## 脱敏说明

- 录制目录 → `<REPO>`；临时文件目录 → `<SIDE>`；临时 HOME → `<HOME>`。
- `C:\Users\admin` → `C:\Users\USER`（含正斜杠形态）。
- 除上述替换外**未做任何增删改**，包括行尾（CRLF）与空行——录制证据逐字节保真。为此有两道设置：
  - 本目录已排除出 Biome 格式化（`biome.json` 的 `!packages/adapters/fixtures`）；
  - `.gitattributes` 对本目录的 `*.stdout.txt` / `*.stderr.txt` / `*.chat-history.md`
    显式 `-text`——仓库默认 `* text=auto eol=lf` 会把 aider 在 Windows 上输出的 CRLF
    归一成 LF，而「适配器要剥掉行尾 `\r`」正是这些录制要证明的行为之一
    （`scanner.ts` 与逐字节回放单测都依赖它）。`*.meta.json` 不在豁免内（那是本脚本生成的 JSON，
    本就该按仓库规矩用 LF）。

## 复现录制

前置：`uv tool install aider-chat --python 3.12`
（本机 pypi.org 直连超时，加 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`）。

```bash
# 1) 起假模型端点（脚本按 fixture 逐份不同，见下表「模型脚本」列的语义）
node packages/adapters/fixtures/tools/fake-openai-server.mjs --port 8188 --script <脚本.json>

# 2) 在一个临时 git 仓库里跑一轮。密钥与端点经 env 下发；--model 必给（否则弹浏览器）
#    参数集与 src/aider/command.ts 的 buildAiderArgs 输出一一对应
HOME=<临时HOME> USERPROFILE=<临时HOME> COLUMNS=1000 NO_COLOR=1 \
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
OPENAI_API_KEY=fixture-key OPENAI_BASE_URL=http://127.0.0.1:8188/v1 \
  aider --model openai/ffpane-fixture-model \
        --message-file <临时目录>/prompt.txt \
        --yes-always --no-pretty --no-fancy-input \
        --no-check-update --no-show-release-notes --no-show-model-warnings \
        --no-gitignore --no-auto-commits --no-dirty-commits \
        --no-analytics --no-detect-urls --no-auto-lint --no-auto-test \
        --no-suggest-shell-commands --map-tokens 0 \
        --chat-history-file <临时目录>/chat.md \
        --input-history-file <临时目录>/input.history \
        --encoding utf-8
```

各份的差异只在：模型脚本内容、少数附加参数（`--edit-format diff`、`--file`、
`--auto-lint`、`--restore-chat-history`、`--suggest-shell-commands`）、
以及是否强杀 / 是否预置仓库 `.env`。逐份的实际参数**已原样记在各自的 `meta.json.args` 里**，
照抄即可复现。

补录真实 Provider 后端的前置条件（用户介入项）：提供一个可用的 Provider 与密钥后，
去掉 `OPENAI_BASE_URL` 与 `--model openai/ffpane-fixture-model`、换成真实模型名重跑第 2 步。
届时应重点核对：`Tokens:` 行是否出现 `Cost: $…`、缓存 token 的呈现方式、
以及真实模型在 `diff` 编辑格式下 `Applied edit to` 的批量形态。

## 注意

- `real-badargs.stdout.txt` 是**空文件**，这本身就是被断言的事实（argparse 错误时 stdout 无输出）。
- stderr 只有 `real-badargs` 一份非空；其余各份 stderr 全空（aider 的日志与错误都走 stdout）。
- 各份 `meta.json` 的 `homeFiles` 为空数组即「本轮没往 HOME 写任何东西」——
  这是 `--no-analytics` 的效果，`real-defaults-residue` 可作对照。
