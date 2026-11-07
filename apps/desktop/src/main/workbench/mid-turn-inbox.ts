/**
 * 干活中途收消息（T11.7，Tony 2026-11-07 定）。纯函数，不碰文件和终端。
 *
 * Claude 每调用完一个工具，PostToolUse hook 问一次平台：有没有该现在就看的新消息。
 * 只有上级和用户本人（拍板结果）的消息插进来；下级汇报、平级消息照旧等这一轮结束再提醒，免得打断。
 * - 未读全是该插的：把正文插进去（读出即标记已读，空闲时的提醒随之撤掉）。
 * - 未读里还夹着不急的：只插一句「谁发来几条，做完这一步先读收件箱」，不标已读。
 * 同一批消息只说一次：最新那条该插的消息没变，就不再说。
 */

export interface MidTurnMessage {
  readonly id: string;
  /** 用户本人（拍板结果）或调用方的上级。 */
  readonly fromAbove: boolean;
  /** 给模型看的来源名字，如「用户本人」「管理者 Claude 1」。 */
  readonly sender: string;
}

export type MidTurnPlan =
  | { readonly kind: "none" }
  | { readonly kind: "digest"; readonly announceId: string }
  | { readonly kind: "notice"; readonly announceId: string; readonly text: string };

/** 一句提示里最多列这么多个来源。 */
const MID_TURN_MAX_SENDERS = 3;

export function planMidTurnInbox(
  unread: readonly MidTurnMessage[],
  lastAnnouncedId: string | undefined,
): MidTurnPlan {
  const urgent = unread.filter((message) => message.fromAbove);
  const newest = urgent.at(-1);
  if (newest === undefined || newest.id === lastAnnouncedId) {
    return { kind: "none" };
  }
  if (urgent.length === unread.length) {
    return { kind: "digest", announceId: newest.id };
  }
  const senders = [...new Set(urgent.map((message) => message.sender))];
  const from =
    senders.slice(0, MID_TURN_MAX_SENDERS).join("、") +
    (senders.length > MID_TURN_MAX_SENDERS ? " 等" : "");
  return {
    kind: "notice",
    announceId: newest.id,
    text: `[平台] 你干活时收到 ${from} 发来的 ${urgent.length} 条新消息（收件箱里共 ${unread.length} 条未读）。做完当前这一步就调用 ffpane_read_inbox 看完；要改方向就改，再接着做。`,
  };
}

/** 插正文时放在最前面的一句，说明这是工具调用之间插进来的。 */
export const MID_TURN_DIGEST_INTRO =
  "[平台] 你干活时收到上级或用户本人的新消息，插在这里给你看。先看完；要改方向就改，再接着做。";
