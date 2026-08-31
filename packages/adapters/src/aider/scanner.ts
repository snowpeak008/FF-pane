/**
 * Aider stdout 行扫描器（T7.3b）。
 *
 * aider 没有任何机器可读的输出模式（调研 §0）：stdout 是**给人看的终端流水**，
 * aider 自己的状态行与模型回答正文混在同一条流里、**没有前缀也没有分隔符**。
 * 本模块把一行文本判成「某种标记」或「答案正文」，是整个适配器唯一的语义来源。
 *
 * ## 为什么是手写扫描器而不是正则
 *
 * 仓库纪律：不写行内正则处理 CLI 输出里**可嵌套、可重复**的结构（gemini 适配器
 * 踩过回溯炸弹）。这里的诱惑是去解析模型正文里的编辑块——```` ``` ```` 围栏与
 * `<<<<<<< SEARCH` 三段块——但那正是最该躲开的东西：
 *
 * - 围栏可嵌套（Markdown 代码块里可以再有围栏），可重复（一轮多个文件）；
 * - aider 会把模型正文**原样回显**，于是同一段编辑块在流里出现两次，
 *   一次是模型说的、一次是 aider 抄的，靠正文无从区分；
 * - 真相根本不在正文里：文件到底改没改，看 `Applied edit to` 标记行与 git。
 *
 * 故本模块只做**行首前缀匹配 + 定长切片**，没有一处多行或带回溯的正则。
 * 唯一用到的两个正则（`TOKENS_LINE` / `LITELLM_ERROR_LINE`）都是行锚定、
 * 无嵌套量词的固定形状，且只在前缀已命中后才跑。
 *
 * ## 标记来源
 *
 * 每条标记的措辞都对着随装源码核过（文件:行号见下方各常量注释），
 * 不是从某次输出里眼看抄来的——措辞随版本漂移时，源码位置比记忆可靠。
 */

/** `Applied edit to <path>`（`coders/base_coder.py:2334`）：唯一可靠的「改动已落盘」标记。 */
const APPLIED_EDIT_PREFIX = "Applied edit to ";

/** `Did not apply edit to <path> (--dry-run)`（同上 `:2332`）。 */
const DRY_RUN_EDIT_PREFIX = "Did not apply edit to ";

/** `--dry-run` 标记行的尾巴，用于把路径切出来。 */
const DRY_RUN_EDIT_SUFFIX = " (--dry-run)";

/** `Committing <path> before applying edits.`（同上 `:2188`）。`--no-dirty-commits` 已拦掉，留着是为了发现它没被拦住。 */
const COMMITTING_PREFIX = "Committing ";

/** `Commit <sha> <message>`（`repo.py`，auto-commit 路径）。`--no-auto-commits` 已拦掉，同上。 */
const COMMIT_PREFIX = "Commit ";

/** `Running <command>`（`coders/base_coder.py:2472`）：模型请求的命令**真的执行了**。headless 下不出现（调研 §4）。 */
const RUNNING_PREFIX = "Running ";

/** `## Running: <command>`（`linter.py:65,148`）：aider 自己的 lint 子进程，无退出码。 */
const LINT_RUNNING_PREFIX = "## Running: ";

/** 编辑格式失败（`coders/base_coder.py:2310`）：随后 aider 会自动重试一轮。 */
const EDIT_FORMAT_FAILURE = "The LLM did not conform to the edit format.";

/** 编辑块匹配失败明细（`coders/editblock_coder.py:84`）。 */
const SEARCH_REPLACE_FAILURE_PREFIX = "# ";
const SEARCH_REPLACE_FAILURE_MARKER = "SEARCH/REPLACE block";

/** transcript 恢复成功（`main.py`）。 */
const RESTORED_HISTORY = "Restored previous conversation history.";

/** 开场横幅：这些行是 aider 的自述，不是模型说的话。 */
const BANNER_PREFIXES = [
  "Aider v",
  "Model: ",
  "Git repo: ",
  "Repo-map: ",
  "Detected dumb terminal",
  "Added ",
  "You can skip this check with",
  "Analytics have been",
  "Initial repo scan",
] as const;

/**
 * `Tokens: 672 sent, 23 received.` / `Tokens: 2.4k sent, 16 received.`
 * （**会用 k 缩写**，见 fixtures/aider/real-shell-declined.stdout.txt）。
 * 行锚定、无嵌套量词。
 */
const TOKENS_LINE = /^Tokens:\s+([\d.]+k?)\s+sent,\s+([\d.]+k?)\s+received\./;

/**
 * `litellm.AuthenticationError: …` / `litellm.BadGatewayError: …`
 * litellm 直出的错误行。**退出码仍是 0**（调研 §3），故这条是判失败的主要依据。
 */
const LITELLM_ERROR_LINE = /^litellm\.(\w+):\s*(.*)$/;

/** 扫描结果的判别值。 */
export type AiderLineKind =
  | "answer"
  | "banner"
  | "applied-edit"
  | "dry-run-edit"
  | "committing"
  | "commit"
  | "command-ran"
  | "lint-command"
  | "edit-format-failure"
  | "search-replace-failure"
  | "restored-history"
  | "tokens"
  | "litellm-error";

/** 一行 stdout 的扫描结果。 */
export type AiderLine =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "banner"; readonly text: string }
  | { readonly kind: "applied-edit"; readonly path: string }
  | { readonly kind: "dry-run-edit"; readonly path: string }
  | { readonly kind: "committing"; readonly path: string }
  | { readonly kind: "commit"; readonly text: string }
  | { readonly kind: "command-ran"; readonly command: string }
  | { readonly kind: "lint-command"; readonly command: string }
  | { readonly kind: "edit-format-failure" }
  | { readonly kind: "search-replace-failure"; readonly text: string }
  | { readonly kind: "restored-history" }
  | { readonly kind: "tokens"; readonly sent: string; readonly received: string }
  | { readonly kind: "litellm-error"; readonly errorName: string; readonly message: string };

/** `2.4k` → 2400；`672` → 672；解析不了返回 undefined（不猜）。 */
export function parseTokenCount(raw: string): number | undefined {
  const isThousands = raw.endsWith("k");
  const numeric = Number.parseFloat(isThousands ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return isThousands ? Math.round(numeric * 1000) : numeric;
}

/**
 * 判定一行 stdout 的语义。
 *
 * **顺序即优先级**：标记行先判，判不出的一律当答案正文。这个兜底方向是刻意的
 * ——把一行标记误当正文，症状是「界面上多了一行噪声」；把一行正文误当标记，
 * 症状是「凭空多出一条文件变更证据」。后者会污染 Run 的证据链，前者不会。
 *
 * 注意 `text` 保留原样（不 trim）：答案正文的缩进是内容的一部分。
 */
export function scanAiderLine(line: string): AiderLine {
  // aider 的输出在 Windows 上是 CRLF，行尾的 \r 由调用方切行时留下。
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;

  if (text === EDIT_FORMAT_FAILURE) {
    return { kind: "edit-format-failure" };
  }
  if (text === RESTORED_HISTORY) {
    return { kind: "restored-history" };
  }
  if (text.startsWith(LINT_RUNNING_PREFIX)) {
    return { kind: "lint-command", command: text.slice(LINT_RUNNING_PREFIX.length) };
  }
  if (text.startsWith(APPLIED_EDIT_PREFIX)) {
    const path = text.slice(APPLIED_EDIT_PREFIX.length).trim();
    if (path !== "") {
      return { kind: "applied-edit", path };
    }
  }
  if (text.startsWith(DRY_RUN_EDIT_PREFIX) && text.endsWith(DRY_RUN_EDIT_SUFFIX)) {
    const path = text
      .slice(DRY_RUN_EDIT_PREFIX.length, text.length - DRY_RUN_EDIT_SUFFIX.length)
      .trim();
    if (path !== "") {
      return { kind: "dry-run-edit", path };
    }
  }
  if (text.startsWith(COMMITTING_PREFIX) && text.endsWith(" before applying edits.")) {
    const path = text
      .slice(COMMITTING_PREFIX.length, text.length - " before applying edits.".length)
      .trim();
    if (path !== "") {
      return { kind: "committing", path };
    }
  }
  if (text.startsWith(COMMIT_PREFIX)) {
    // `Commit <sha> <message>`：sha 形状不校验（git 短 sha 长度可配），
    // 这条只用于红线核查「本轮是不是造了 commit」，不解析内容。
    const rest = text.slice(COMMIT_PREFIX.length).trim();
    if (rest !== "" && rest.includes(" ")) {
      return { kind: "commit", text: rest };
    }
  }
  if (text.startsWith(RUNNING_PREFIX)) {
    const command = text.slice(RUNNING_PREFIX.length).trim();
    if (command !== "") {
      return { kind: "command-ran", command };
    }
  }
  if (
    text.startsWith(SEARCH_REPLACE_FAILURE_PREFIX) &&
    text.includes(SEARCH_REPLACE_FAILURE_MARKER)
  ) {
    return { kind: "search-replace-failure", text };
  }

  const tokens = TOKENS_LINE.exec(text);
  if (tokens !== null) {
    return { kind: "tokens", sent: tokens[1] as string, received: tokens[2] as string };
  }

  const litellm = LITELLM_ERROR_LINE.exec(text);
  if (litellm !== null) {
    return {
      kind: "litellm-error",
      errorName: litellm[1] as string,
      message: litellm[2] as string,
    };
  }

  for (const prefix of BANNER_PREFIXES) {
    if (text.startsWith(prefix)) {
      return { kind: "banner", text };
    }
  }

  return { kind: "answer", text };
}

/** 从横幅行 `Model: <m> with <fmt> edit format` 里读出编辑格式；读不出返回 undefined。 */
export function parseEditFormat(bannerLine: string): string | undefined {
  if (!bannerLine.startsWith("Model: ")) {
    return undefined;
  }
  const suffix = " edit format";
  if (!bannerLine.endsWith(suffix)) {
    return undefined;
  }
  const withIndex = bannerLine.lastIndexOf(" with ");
  if (withIndex === -1) {
    return undefined;
  }
  const format = bannerLine.slice(withIndex + " with ".length, bannerLine.length - suffix.length);
  return format === "" ? undefined : format;
}
