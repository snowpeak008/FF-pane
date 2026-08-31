/**
 * Aider 命令行组装（T7.3b）。
 *
 * 参数全部取自 docs/adapters/aider.md §1.2，并以本机 `aider --help`（0.86.2）复核。
 *
 * 与前五家最大的不同：**这里没有「输出格式」可选**。aider 不提供任何机器可读的
 * 输出模式（调研 §0），故命令行的职责不是「挑一个好解析的格式」，而是：
 *
 * 1. **让 headless 跑得起来**（`--message-file` + `--model` + `--yes-always`）；
 * 2. **拦住八条会动用户仓库与用户机器的默认行为**（§1.2 第二组，逐条实测见 §8.1）；
 * 3. **让行为确定、不额外花钱**（关掉 auto-lint 的自动修复轮与永远执行不了的命令建议）。
 *
 * 第 2 组每一条都是红线而非偏好：aider 默认会往用户仓库写三个 `.aider.*`、
 * 改写用户的 `.gitignore`、并且**自己 git commit**。而默认值随时可能被用户仓库里的
 * `.aider.conf.yml` 或用户 shell 里的 `AIDER_*` 变量改掉（§7.3 坑 4 附注），
 * 所以这一整套必须**显式下发**，不能依赖 aider 的默认值。
 */

import type { ModelId, RuntimeId } from "@ff-pane/shared";
import { isApiKeyEnvName } from "../process/index.js";

/** Runtime 注册键（adapter.ts KNOWN_RUNTIMES 之一）。 */
export const AIDER_RUNTIME: RuntimeId = "aider";

/** 默认可执行文件名（`uv tool install` / `pipx install` 均落地为 `aider`）。 */
export const DEFAULT_AIDER_COMMAND = "aider";

/**
 * 折行防线：aider 用 rich 输出，按终端宽度硬折行；管道下 rich 取 `COLUMNS`，
 * 取不到按 80 算。实测 `COLUMNS=100` 会把一条 litellm 错误切成三行、
 * 把 `Applied edit to <长路径>` 折断（调研 §7.3 坑 2）。扫描器认的是行首前缀，
 * 折行会让第二段以后完全认不出来，故这不是调优项而是必设项。
 */
export const AIDER_TERMINAL_COLUMNS = "1000";

/**
 * 注入给 aider 进程的固定环境变量（不含密钥，密钥由 ctx.env 经 §4.3 通道下发）。
 * `PYTHON*` 两项为中文提示词与中文文件内容而设；`NO_COLOR` 与 `--no-pretty` 同向。
 */
export const AIDER_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  COLUMNS: AIDER_TERMINAL_COLUMNS,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  NO_COLOR: "1",
});

/** `--set-env` 里出现密钥是装配 bug（值会进 argv 与 transcript），快速失败。 */
export class AiderSecretInArgvError extends Error {
  override readonly name = "AiderSecretInArgvError";
}

/** buildAiderArgs 的输入。 */
export interface AiderArgsInput {
  /** 提示词临时文件的绝对路径（`--message-file`）。 */
  readonly promptFile: string;
  /**
   * 会话 transcript 文件（`--chat-history-file`）。
   * **必须落在用户仓库之外**：默认值是 `<git 根>/.aider.chat.history.md`（§8.1）。
   */
  readonly chatHistoryFile: string;
  /** 输入历史文件（`--input-history-file`）。同上，默认值也在仓库里。 */
  readonly inputHistoryFile: string;
  /**
   * 模型 ID（`--model`）。**必给**：缺席会让 aider 进 onboarding 并唤起浏览器
   * 做 OpenRouter OAuth，而 `--yes-always` 会把那句询问自动答成「是」（§7.3 坑 1）。
   */
  readonly model: ModelId;
  /** 是否恢复上一轮对话（`--restore-chat-history`）。 */
  readonly restoreHistory?: boolean | undefined;
  /**
   * 编辑格式（`--edit-format`）。缺席 = 用 aider 对该模型的默认判断
   * （未知模型落 `whole`，已知模型多为 `diff`）。取舍见调研 §9 第 2 项。
   */
  readonly editFormat?: string | undefined;
  /** 预先纳入会话的可编辑文件（`--file`，可重复）。 */
  readonly files?: readonly string[] | undefined;
  /** 预先纳入会话的只读文件（`--read`，可重复）。 */
  readonly readOnlyFiles?: readonly string[] | undefined;
  /** `--reasoning-effort` 推理强度。 */
  readonly reasoningEffort?: string | undefined;
  /** 回答语言（`--chat-language`）；缺席 = aider 按系统区域自行注入一句。 */
  readonly chatLanguage?: string | undefined;
  /**
   * 是否允许模型建议 shell 命令（`--suggest-shell-commands`），默认 **false**。
   * headless 下命令永远执行不了（§4），开着只是白烧 token，且在 `whole` 编辑格式下
   * ```` ```bash ```` 围栏会被当成「缺文件名的文件清单」而撞坏编辑解析器（§7.3 坑 3）。
   */
  readonly suggestShellCommands?: boolean | undefined;
  /**
   * 是否开启编辑后自动 lint（`--auto-lint`），默认 **false**（aider 默认是开）。
   * 开着会起 `python -m flake8` 子进程，且有错就**自动再花一轮模型钱**去修（§1.2 第三组）。
   */
  readonly autoLint?: boolean | undefined;
  /** 是否在编辑后自动跑测试（`--auto-test`），默认 false（与 aider 默认一致，显式写上防配置漂移）。 */
  readonly autoTest?: boolean | undefined;
  /** `--lint-cmd`（可重复），仅在 autoLint 开启时有意义。 */
  readonly lintCommands?: readonly string[] | undefined;
  /** `--test-cmd`，仅在 autoTest 开启时有意义。 */
  readonly testCommand?: string | undefined;
  /**
   * 映射为 `--set-env K=V`（dotenv 加载之后才写 os.environ，故能压过用户仓库的
   * `.env`，见 §7.3 坑 4）。**不得放密钥**：值会进 argv，既在进程列表里可见，
   * 又会被 aider 抄进 transcript（§5.1）。命中 isApiKeyEnvName 一律快速失败。
   */
  readonly setEnv?: Readonly<Record<string, string>> | undefined;
  /** 原样追加的参数（逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
}

/**
 * `--set-env` 的密钥闸门。
 *
 * 这道检查放在组装期而不是文档里，因为「把密钥塞进一个通用键值通道」是个
 * 极自然的误用：codex 的 configOverrides 就长这样，而那边的值不进 transcript。
 * 让它在装配时炸掉，比在事后审 Run 日志时发现密钥泄进 Markdown 要好。
 */
export function assertNoSecretInSetEnv(setEnv: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(setEnv)) {
    if (isApiKeyEnvName(name)) {
      throw new AiderSecretInArgvError(
        `「${name}」命中密钥变量模式，不得经 --set-env 下发：` +
          "该值会进入命令行（进程列表可见），并被 aider 逐字抄进 chat history transcript。" +
          "密钥只能经 AdapterTurnContext.env 下发（设计文档 §4.3）",
      );
    }
  }
}

/**
 * 组装 aider headless 参数表（不含可执行文件本身）。
 * 纯函数，参数顺序稳定，便于单测与日志比对。
 */
export function buildAiderArgs(input: AiderArgsInput): string[] {
  const setEnv = input.setEnv ?? {};
  assertNoSecretInSetEnv(setEnv);

  const args: string[] = [
    "--model",
    input.model,
    "--message-file",
    input.promptFile,
    // headless 能跑起来的那一组（§1.2 第一组）。
    "--yes-always",
    "--no-pretty",
    "--no-fancy-input",
    "--no-check-update",
    "--no-show-release-notes",
    "--no-show-model-warnings",
    "--encoding",
    "utf-8",
    // 不许动用户仓库与用户机器的那一组（§1.2 第二组，八条红线；`--no-detect-urls`
    // 拦的是「扫提示词里的 URL 并在 --yes-always 下自动抓网页」这条联网默认行为）。
    "--no-gitignore",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-analytics",
    "--no-detect-urls",
    "--map-tokens",
    "0",
    "--chat-history-file",
    input.chatHistoryFile,
    "--input-history-file",
    input.inputHistoryFile,
  ];

  // 行为确定、不额外花钱的那一组（§1.2 第三组）。三项都用「显式给出正反面」
  // 而不是「默认不给」——aider 的默认值可被仓库 .aider.conf.yml 与 AIDER_* 环境
  // 变量改掉，只有写进命令行才压得住（§7.3 坑 4 附注）。
  args.push(input.autoLint === true ? "--auto-lint" : "--no-auto-lint");
  args.push(input.autoTest === true ? "--auto-test" : "--no-auto-test");
  args.push(
    input.suggestShellCommands === true
      ? "--suggest-shell-commands"
      : "--no-suggest-shell-commands",
  );

  if (input.restoreHistory === true) {
    args.push("--restore-chat-history");
  }
  if (input.editFormat !== undefined && input.editFormat !== "") {
    args.push("--edit-format", input.editFormat);
  }
  if (input.chatLanguage !== undefined && input.chatLanguage !== "") {
    args.push("--chat-language", input.chatLanguage);
  }
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== "") {
    args.push("--reasoning-effort", input.reasoningEffort);
  }
  for (const file of input.files ?? []) {
    args.push("--file", file);
  }
  for (const file of input.readOnlyFiles ?? []) {
    args.push("--read", file);
  }
  for (const command of input.lintCommands ?? []) {
    args.push("--lint-cmd", command);
  }
  if (input.testCommand !== undefined && input.testCommand !== "") {
    args.push("--test-cmd", input.testCommand);
  }
  // 键序固定（字典序），否则同一份输入会组装出不同的命令行，日志无法比对。
  for (const name of Object.keys(setEnv).sort()) {
    args.push("--set-env", `${name}=${setEnv[name] as string}`);
  }
  args.push(...(input.extraArgs ?? []));
  return args;
}
