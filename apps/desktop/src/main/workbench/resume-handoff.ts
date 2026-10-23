/**
 * 重开项目后续接窗口（用户 2026-10-23 定的规则）。
 *
 * - 旧窗口仍要用户点「续接」才启动，不自动拉起。
 * - 布局里没记会话编号时，用这个窗口自己记下的最近一次对话，不打开选择器：
 *   Codex 的选择器列出 CODEX_HOME 里所有会话，包括用户在 Codex 桌面版里的别的对话，
 *   回车一按就接到别人的对话上。
 * - Codex 会话被桌面版归档了（共用 CODEX_HOME，2026-10-22 21:14 监管者实录），
 *   先用 `codex unarchive` 放回来再续接；放不回来或找不到，就开新对话。
 * - 续接上之后平台补发一条交接，用户不用再打字。原对话找不到、换成新对话时，交接里写明
 *   「你不记得之前的事」，不再发「从停下的地方接着做」。
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { resolveDirectCliTarget } from "@ff-pane/adapters";
import type { WorkbenchConversationRecord, WorkbenchRole } from "@ff-pane/shared";
import { CODEX_INTERACTIVE_COMMAND } from "./cli-args";
import { codexArchivedRolloutPathFor, codexRolloutPathFor } from "./codex-rollout-watch";
import { stripControls } from "./remind";

/** `codex unarchive` 最多等这么久。 */
export const CODEX_UNARCHIVE_TIMEOUT_MS = 15_000;

/** 这个窗口记下的对话里最近用过的那一次。 */
export function latestConversationId(
  conversations: readonly WorkbenchConversationRecord[] | undefined,
): string | undefined {
  let best: WorkbenchConversationRecord | undefined;
  for (const item of conversations ?? []) {
    if (item.id.trim() === "") {
      continue;
    }
    if (best === undefined || item.lastActiveAt > best.lastActiveAt) {
      best = item;
    }
  }
  return best?.id;
}

/**
 * active：会话文件在 sessions 里，可以直接续接。
 * restored：原来在 archived_sessions，已经放回来。
 * missing：两处都没有。
 * failed：在归档里，但没能放回来。
 */
export type CodexSessionState = "active" | "restored" | "missing" | "failed";

export interface CodexRestoreDeps {
  readonly codexHome: string;
  readonly exists?: (path: string) => boolean;
  /** 跑 `codex unarchive <id>`。返回是否成功退出。 */
  readonly unarchive?: (threadId: string) => Promise<boolean>;
}

/** 续接前确认这个 Codex 会话还在；被归档了就放回来。 */
export async function ensureCodexSessionActive(
  threadId: string,
  deps: CodexRestoreDeps,
): Promise<CodexSessionState> {
  const sessionsDir = join(deps.codexHome, "sessions");
  if (codexRolloutPathFor(sessionsDir, threadId, deps.exists) !== undefined) {
    return "active";
  }
  const archived = codexArchivedRolloutPathFor(
    join(deps.codexHome, "archived_sessions"),
    threadId,
    deps.exists,
  );
  if (archived === undefined) {
    return "missing";
  }
  const unarchive = deps.unarchive ?? runCodexUnarchive;
  const ok = await unarchive(threadId).catch(() => false);
  if (ok && codexRolloutPathFor(sessionsDir, threadId, deps.exists) !== undefined) {
    return "restored";
  }
  return "failed";
}

/** 用和窗口同一个 codex 跑 `codex unarchive <id>`；不经 cmd.exe。 */
export function runCodexUnarchive(threadId: string): Promise<boolean> {
  const target = resolveDirectCliTarget(
    CODEX_INTERACTIVE_COMMAND,
    ["unarchive", threadId],
    process.env,
  );
  if (target === undefined) {
    return Promise.resolve(false);
  }
  return new Promise((resolvePromise) => {
    execFile(
      target.file,
      [...target.args],
      { timeout: CODEX_UNARCHIVE_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error !== null) {
          console.error(`[wb-codex] unarchive ${threadId} failed: ${error.message}`);
        }
        resolvePromise(error === null);
      },
    );
  });
}

export type ResumeHandoffReason = "restart" | "new-conversation";

export interface ResumePlan {
  readonly resume: boolean;
  readonly nativeSessionId?: string;
  /** 启动后要补发的交接。 */
  readonly handoff?: ResumeHandoffReason;
}

/**
 * 定这次启动怎么续接。
 * firstLaunchThisRun：应用这次运行里第一次启动这个窗口（重开项目后用户点了「续接」）。
 */
export async function planResume(
  input: {
    readonly kind: "claude" | "codex" | "grok" | "deepseek";
    readonly resume: boolean;
    readonly firstLaunchThisRun: boolean;
    readonly nativeSessionId?: string;
    readonly conversations?: readonly WorkbenchConversationRecord[] | undefined;
  },
  deps: CodexRestoreDeps,
): Promise<ResumePlan> {
  if (!input.resume) {
    return {
      resume: false,
      ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
    };
  }
  const id = input.nativeSessionId ?? latestConversationId(input.conversations);
  const restart = input.firstLaunchThisRun ? { handoff: "restart" as const } : {};
  if (input.kind !== "codex") {
    return { resume: true, ...(id !== undefined ? { nativeSessionId: id } : {}), ...restart };
  }
  if (id === undefined) {
    return { resume: false, handoff: "new-conversation" };
  }
  const state = await ensureCodexSessionActive(id, deps);
  if (state === "failed") {
    return { resume: false, handoff: "new-conversation" };
  }
  // missing 时照旧按编号续接：Codex 自己会说找不到，用户可以改点「开新对话」。
  return { resume: true, nativeSessionId: id, ...restart };
}

export interface ResumeHandoffInput {
  readonly reason: ResumeHandoffReason;
  readonly title: string;
  readonly role: WorkbenchRole;
  /** 开它的窗口标题。用户开的没有。 */
  readonly openerTitle?: string;
  /** 收件箱里还没读的条数。 */
  readonly unread: number;
  /** 管理者的待处理页（相对项目根），文件在才给。 */
  readonly digestPath?: string;
}

const ROLE_TEXT: Readonly<Record<WorkbenchRole, string>> = {
  manager: "管理者",
  supervisor: "监管者",
  worker: "执行",
  reviewer: "检查",
  planner: "规划",
  none: "普通窗口",
};

function name(text: string): string {
  return stripControls(text.replace(/[\r\n\t]+/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** 续接后补发的那一句。一行，不带换行。 */
export function resumeHandoffText(input: ResumeHandoffInput): string {
  const who = `你是「${name(input.title)}」，${ROLE_TEXT[input.role] ?? input.role}${
    input.openerTitle !== undefined ? `，由「${name(input.openerTitle)}」开启` : ""
  }`;
  const inbox =
    input.unread > 0
      ? `收件箱有 ${input.unread} 条没读，先调用 ffpane_read_inbox`
      : "收件箱没有未读消息";
  const digest =
    input.digestPath !== undefined
      ? `；你不在时团队的状态记在 ${input.digestPath}，先读这一页`
      : "";
  const tail = "然后接着做；做不了就用 ffpane_report blocked 说明原因。";
  if (input.reason === "new-conversation") {
    return `[交接] 原来的对话找不到了（可能在别处被归档或删除），这是一个新对话，你不记得之前的事。${who}。先用 ffpane_whoami、ffpane_list_windows 弄清现状；${inbox}${digest}；再读 .ffpane/briefs/ 里你自己写的近况和你的任务说明，${tail}`;
  }
  return `[交接] 软件重启过，用户刚把你续接上。${who}。重启期间各窗口都停着，你停下前在等的回应可能已经到了：${inbox}${digest}；用 ffpane_list_windows 看各窗口现在的状态，${tail}`;
}
