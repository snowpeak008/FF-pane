/**
 * Aider stdout → 统一 AgentEvent 映射器（T7.3b）。
 *
 * 纯映射、零 I/O：输入是 stdout 的字节块（已解码为字符串），输出是 AgentEvent 数组，
 * 故可直接用 fixtures/aider/*.stdout.txt 回放（tests/aider.test.ts）。
 * diff 自补是 I/O，与 codex 同一分工：留在适配器层给 file_change 补字段（git-diff.ts）。
 *
 * ## 三条硬约定
 *
 * 1. **退出码不承载成功语义**（调研 §3，头号坑）。aider 的退出码只有 0/1/2 三个取值，
 *    而 0 覆盖了「密钥错」「端点全挂」「编辑块匹配失败」「命令被静默拒绝」在内的
 *    几乎所有失败。故 end.reason 由**扫描到的标记行**裁定，退出码只在 1（被杀）与
 *    2（参数错）两种情形下参与判断。
 *
 * 2. **命令被静默拒绝要留证**（调研 §4）。headless 下 `--yes-always` 对「需明示同意」
 *    的询问一律答否，模型请求的命令**永不执行**，stdout 上唯一痕迹是一行裸命令文本
 *    ——与模型正文无从区分。故本 mapper 不去猜哪行是被拒的命令，而是：见到
 *    `Running <cmd>`（真跑了）才发 command 事件；一轮结束时若模型正文里出现过
 *    命令建议的迹象则不做推断——**宁可少报一条，不可凭空造一条证据**。
 *    真正的防线是 command.ts 默认下发 `--no-suggest-shell-commands`，
 *    让模型压根不提这类建议。
 *
 * 3. **end 恰好一条且在最后**（adapter.ts 约定）。终止事实到达时只登记，
 *    由 finalize() 统一收尾。
 *
 * ## 流式与「可能成为标记」的行
 *
 * aider 的答案文本是**真 token 级增量、不带换行**（调研 §2.3），而标记行只能在
 * 整行到齐后才判得出。两者共用一条流，于是有一个取舍：等换行再吐，流式就没了；
 * 立刻吐，就可能把半行标记当成答案发出去。
 *
 * 解法是利用「标记一定在行首」这个性质：一行未完成的文本，只要它的开头**已经不可能**
 * 成为任何标记的前缀（`couldBecomeMarkerPrefix` 为假），它就永远不会变成标记，
 * 可以当场吐出去。普通散文（不以 `Applied edit to ` / `Tokens:` … 开头）因此保有
 * 完整的 token 级流式；只有极少数「碰巧像标记开头」的行会被压到行末才吐。
 * 这样既不牺牲流式，也不会误报证据。
 */

import type { ModelId, NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type {
  AgentEvent,
  EndEvent,
  FileChangeEvent,
  FileChangeKind,
  SessionStartEvent,
  TokenUsage,
} from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import { AIDER_RUNTIME } from "./command.js";
import { type AiderLine, parseEditFormat, parseTokenCount, scanAiderLine } from "./scanner.js";

/**
 * 所有标记行的行首字面量。**必须与 scanner.ts 的判定保持同源**——
 * 这里少一条，对应的标记行就会在流式路径上被提前当成答案文本吐出去。
 * 单测 `scanner 的每种标记都在 MARKER_PREFIXES 里有对应前缀` 守着这条一致性。
 */
const MARKER_PREFIXES: readonly string[] = [
  "Applied edit to ",
  "Did not apply edit to ",
  "Committing ",
  "Commit ",
  "Running ",
  "## Running: ",
  "The LLM did not conform to the edit format.",
  "Restored previous conversation history.",
  "Tokens:",
  "litellm.",
  "# ",
  "Aider v",
  "Model: ",
  "Git repo: ",
  "Repo-map: ",
  "Detected dumb terminal",
  "Added ",
  "You can skip this check with",
  "Analytics have been",
  "Initial repo scan",
];

/** 阻断证据摘要最多列出的条目数。 */
const BLOCKAGE_EXCERPT_COUNT = 3;

/** 摘要里命令/消息原文的截断长度。 */
const EXCERPT_LENGTH = 80;

/**
 * 这半行还可能长成某个标记吗？
 * 两个方向都算：`s` 是某标记的前半截（还没打完），或 `s` 已经以某标记开头。
 */
export function couldBecomeMarkerPrefix(partialLine: string): boolean {
  if (partialLine === "") {
    return true;
  }
  return MARKER_PREFIXES.some(
    (prefix) => prefix.startsWith(partialLine) || partialLine.startsWith(prefix),
  );
}

/** 流结束时的进程终局（由适配器从 AgentProcessExit 翻译而来）。 */
export interface AiderStreamOutcome {
  /** 是否为适配器主动取消（cancel() 或 timeoutMs 到期树杀）。 */
  readonly cancelled: boolean;
  /** 进程根本没起来。 */
  readonly spawnFailed: boolean;
  /** 进程退出码；未知为 null。 */
  readonly exitCode: number | null;
  /** 进程级错误原文 / stderr 尾巴，无则 null。 */
  readonly error: string | null;
}

/** 已登记但尚未吐出的终止事实。 */
interface PendingTerminal {
  readonly reason: RunEndReason;
  readonly message: string;
}

/** Aider 事件映射器。有状态，一个实例只服务一轮。 */
export interface AiderEventMapper {
  /** 吃一块 stdout 文本，返回 0..n 条统一事件。 */
  push(chunk: string): readonly AgentEvent[];
  /** 流结束收尾：补 session_start + 恰好一条 end。 */
  finalize(outcome: AiderStreamOutcome): readonly AgentEvent[];
  /** 本轮 `Applied edit to` 报出的路径（适配器据此补 diff）。 */
  editedPaths(): readonly string[];
  /** 本轮攒到的阻断证据（诊断用，事件流外）。 */
  blockages(): readonly string[];
  /** 横幅里读到的实际编辑格式（排障用）。 */
  editFormat(): string | undefined;
  /** 是否见到过 litellm 错误行（诊断用）。 */
  sawModelError(): boolean;
}

/** createAiderEventMapper 的可选项。 */
export interface AiderEventMapperOptions {
  /** 本轮工作目录，与 transcript 路径成对构成 NativeSessionBinding。 */
  readonly cwd: string;
  /**
   * 会话凭据：本轮的 transcript 文件路径。
   * aider 没有原生会话 ID，续接靠 `--chat-history-file` + `--restore-chat-history`
   * （调研 §5.1），故「会话 ID」是适配器自管的这个路径。
   */
  readonly sessionId: string;
  /** 本轮请求的模型；aider 横幅里有但形态是自己的别名，以调用方给的为准。 */
  readonly model?: ModelId | undefined;
  /**
   * 该路径在 turn 前是否已被 git 跟踪（git-diff.ts 的 wasTrackedBeforeTurn）。
   * 用来判 add / update：aider 的标记行不带变更类型，而「文件此刻存在」
   * 说明不了它本来在不在。返回 undefined = 判不出，此时记 update
   * （`Applied edit to` 的语义偏向「改了」，且猜错方向只影响展示不影响证据成立）。
   */
  readonly wasTracked?: ((path: string) => boolean | undefined) | undefined;
}

function excerpt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= EXCERPT_LENGTH ? single : `${single.slice(0, EXCERPT_LENGTH)}…`;
}

/** 创建映射器。 */
export function createAiderEventMapper(options: AiderEventMapperOptions): AiderEventMapper {
  const { cwd, sessionId, model, wasTracked } = options;

  /** 当前未完成的行。 */
  let pending = "";
  /** pending 里已经作为答案文本吐出去的字符数。 */
  let pendingEmitted = 0;

  let sawAnswerText = false;
  const appliedEdits: string[] = [];
  const blocked: string[] = [];
  let terminal: PendingTerminal | null = null;
  let detectedEditFormat: string | undefined;
  let modelErrorSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawTokens = false;

  function raw(native: unknown, note: string): AgentEvent {
    return toRawEvent(AIDER_RUNTIME, native, note);
  }

  function changeKindOf(filePath: string): FileChangeKind {
    return wasTracked?.(filePath) === false ? "add" : "update";
  }

  /** 一条完整的行 → 事件。 */
  function mapLine(line: AiderLine, rawText: string): readonly AgentEvent[] {
    switch (line.kind) {
      case "answer": {
        // 行内已吐出的部分不重复吐；补上剩余部分与换行（TextEvent 是追加语义）。
        const remainder = rawText.slice(pendingEmitted);
        if (remainder === "" && !sawAnswerText) {
          // 流开头的空行是横幅与正文之间的间隔，不作为答案文本的开始。
          return [];
        }
        sawAnswerText = true;
        return [{ kind: "text", content: `${remainder}\n`, final: false, channel: "answer" }];
      }

      case "banner": {
        detectedEditFormat ??= parseEditFormat(rawText);
        return [raw(rawText, "aider 开场横幅 / 自述行，非模型输出")];
      }

      case "applied-edit": {
        appliedEdits.push(line.path);
        const event: FileChangeEvent = {
          kind: "file_change",
          path: line.path,
          changeKind: changeKindOf(line.path),
          status: "completed",
        };
        // diff 刻意不在这里补：那是 git I/O，归适配器层（与 codex 同一分工）。
        return [event];
      }

      case "dry-run-edit":
        // --dry-run 下什么都没真改，故 status 是 started 而不是 completed：
        // 报成 completed 会让一次空转满足任务 done 的证据门槛。
        return [
          {
            kind: "file_change",
            path: line.path,
            changeKind: changeKindOf(line.path),
            status: "started",
          },
          raw(rawText, "--dry-run：编辑未落盘"),
        ];

      case "committing":
        // `--no-dirty-commits` 应当已拦住它。真出现了说明开关没生效
        // （仓库 .aider.conf.yml / AIDER_* 环境变量覆盖），属红线告警。
        blocked.push(`aider 在编辑前提交了「${line.path}」：--no-dirty-commits 未生效`);
        return [raw(rawText, "红线告警：aider 在用户仓库里造了提交（--no-dirty-commits 未生效）")];

      case "commit":
        blocked.push(
          `aider 在用户仓库里造了提交（${excerpt(line.text)}）：--no-auto-commits 未生效`,
        );
        return [raw(rawText, "红线告警：aider 造了 git 提交（--no-auto-commits 未生效）")];

      case "command-ran":
        // headless 下不该出现（§4）。真出现了就如实报——它确实执行了。
        // 无退出码可取：aider 不打印，故 exitCode 字段缺席（events/types.ts 允许）。
        return [
          { kind: "command", command: line.command, status: "completed" },
          raw(rawText, "模型请求的命令真的执行了（headless 下罕见，见 aider.md §4）"),
        ];

      case "lint-command":
        // aider 自己的 lint 子进程。**不映射为 command 事件**：无退出码、
        // 且能力声明里 commandEvents 为 no，一边声明零一边发事件是自相矛盾。
        return [
          raw(
            rawText,
            `aider 自身的 lint 子进程：${excerpt(line.command)}（无退出码，只记原始日志）`,
          ),
        ];

      case "edit-format-failure":
        blocked.push("模型输出不符合编辑格式，aider 自动重试了一轮");
        return [raw(rawText, "编辑格式失败，aider 将自动重试（多花一轮模型调用）")];

      case "search-replace-failure":
        blocked.push(`编辑块匹配失败：${excerpt(line.text)}`);
        return [raw(rawText, "SEARCH/REPLACE 块未能匹配到目标文件内容")];

      case "restored-history":
        return [raw(rawText, "已从 transcript 恢复上一轮对话")];

      case "tokens": {
        sawTokens = true;
        // 一轮里可能有多条（编辑格式重试、auto-lint 修复轮），累加才是本轮总量。
        inputTokens += parseTokenCount(line.sent) ?? 0;
        outputTokens += parseTokenCount(line.received) ?? 0;
        return [raw(rawText, "token 统计行")];
      }

      case "litellm-error": {
        modelErrorSeen = true;
        const message = `aider 的模型调用失败：litellm.${line.errorName}${
          line.message === "" ? "" : `：${line.message}`
        }`;
        // 只登记第一条：litellm 重试会连报多条同类错误，末条与首条同因。
        terminal ??= { reason: "failed", message };
        return [raw(rawText, "litellm 错误行（注意：此时进程退出码仍是 0）")];
      }
    }
  }

  return {
    push(chunk: string): readonly AgentEvent[] {
      const events: AgentEvent[] = [];
      let rest = chunk;
      while (rest !== "") {
        const newlineIndex = rest.indexOf("\n");
        if (newlineIndex === -1) {
          pending += rest;
          rest = "";
          break;
        }
        pending += rest.slice(0, newlineIndex);
        rest = rest.slice(newlineIndex + 1);
        const line = scanAiderLine(pending);
        // scanAiderLine 会剥掉行尾 \r，答案文本的 slice 也要按剥掉后的长度算。
        const text = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
        events.push(...mapLine(line, text));
        pending = "";
        pendingEmitted = 0;
      }

      // 未完成的这半行：已不可能成为标记时当场吐出，保住 token 级流式（见模块头）。
      //
      // 行尾的 `\r` 刻意扣住不发（Windows 上 aider 输出 CRLF，`\r` 总是紧贴换行）：
      // 整行判定时它会被剥掉，若在流式路径上先发出去，同一份输入就会因为分块边界
      // 不同而产出不同的文本（"…\r\n" vs "…\n"）。扣住一个字符无损流式，
      // 却让「逐字节喂与整块喂结果一致」这条性质成立。
      if (pending !== "" && !couldBecomeMarkerPrefix(pending)) {
        const flushable = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
        const remainder = flushable.slice(pendingEmitted);
        if (remainder !== "") {
          sawAnswerText = true;
          events.push({ kind: "text", content: remainder, final: false, channel: "answer" });
          pendingEmitted = flushable.length;
        }
      }
      return events;
    },

    finalize(outcome: AiderStreamOutcome): readonly AgentEvent[] {
      const events: AgentEvent[] = [];

      // 收尾时把最后一行不带换行的残留吐掉（aider 正常收尾时 stdout 以换行结束，
      // 但强杀会断在任意位置）。
      if (pending !== "") {
        const line = scanAiderLine(pending);
        const text = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
        events.push(...mapLine(line, text));
        pending = "";
        pendingEmitted = 0;
      }

      if (sawAnswerText) {
        // aider 的答案文本没有「这条消息说完了」的标记，故收尾时补一条空 final
        // （events/types.ts 的追加语义）。
        events.push({ kind: "text", content: "", final: true, channel: "answer" });
      }

      // session_start 可以在任何时候发：会话凭据是适配器自己定的 transcript 路径，
      // 不用等 CLI 给 ID（与 grok 相反，那家只有 end 里才有 sessionId）。
      const start: SessionStartEvent = {
        kind: "session_start",
        native: { nativeSessionId: sessionId as NativeSessionId, cwd },
        ...(model === undefined ? {} : { model }),
      };
      events.push(start);

      const usage: TokenUsage | undefined = sawTokens
        ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
        : undefined;
      const exitCode = outcome.exitCode === null ? {} : { exitCode: outcome.exitCode };
      const withEnd = (reason: RunEndReason, message?: string): readonly AgentEvent[] => {
        const end: EndEvent = {
          kind: "end",
          reason,
          ...(usage === undefined ? {} : { usage }),
          ...(message === undefined ? {} : { message }),
          ...exitCode,
        };
        events.push(end);
        return events;
      };

      if (outcome.cancelled) {
        return withEnd(
          "cancelled",
          "本轮被取消（树杀）。aider 无优雅取消协议，已落盘的编辑不回滚" +
            "（--no-auto-commits 下它们留在工作区）",
        );
      }
      if (outcome.spawnFailed) {
        return withEnd(
          "failed",
          `aider 进程未能启动${outcome.error === null ? "" : `：${outcome.error}`}`,
        );
      }
      // 参数错误：argparse 把 usage 全打到 stderr，stdout 一个字节都没有（§3）。
      if (outcome.exitCode === 2) {
        return withEnd(
          "failed",
          "aider 拒绝了命令行参数（argparse 退出码 2）" +
            `${outcome.error === null ? "" : `：${excerpt(outcome.error)}`}`,
        );
      }
      if (terminal !== null) {
        return withEnd(terminal.reason, terminal.message);
      }
      // 退出码 1 = 被信号/taskkill 终止。适配器没主动取消却收到 1，是外部干预或崩溃。
      if (outcome.exitCode === 1) {
        return withEnd(
          "crashed",
          "aider 进程以退出码 1 结束但未报出任何错误（事件流被截断）" +
            `${outcome.error === null ? "" : `：${excerpt(outcome.error)}`}`,
        );
      }
      if (blocked.length > 0) {
        const listed = blocked.slice(0, BLOCKAGE_EXCERPT_COUNT).join("；");
        const more = blocked.length > BLOCKAGE_EXCERPT_COUNT ? ` 等 ${blocked.length} 项` : "";
        return withEnd("failed", `aider 正常退出，但本轮有动作被阻断或失败：${listed}${more}`);
      }
      if (appliedEdits.length > 0 || sawAnswerText) {
        return withEnd("completed");
      }
      // 退出码 0 且什么都没产出：aider 最常见的失败形态就长这样（§3）。
      return withEnd(
        "failed",
        "aider 以退出码 0 结束，但既没有答案文本也没有文件变更——" +
          "aider 的退出码不承载成功语义（见 aider.md §3），故判为失败而非成功",
      );
    },

    editedPaths(): readonly string[] {
      return [...appliedEdits];
    },

    blockages(): readonly string[] {
      return [...blocked];
    },

    editFormat(): string | undefined {
      return detectedEditFormat;
    },

    sawModelError(): boolean {
      return modelErrorSeen;
    },
  };
}
