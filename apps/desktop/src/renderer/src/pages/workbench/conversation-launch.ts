/**
 * 窗口上的对话操作：续接当前、开新对话、从历史里选一段。
 * 没有编号时只打开选择器。
 */

export type ConversationLaunchPlan =
  | { readonly kind: "fresh" }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "picker" };

export function planConversationLaunch(input: {
  readonly action: "fresh" | "resume-current" | "resume-history";
  readonly currentId?: string;
  readonly historyId?: string;
  readonly unidentified?: boolean;
}): ConversationLaunchPlan {
  if (input.action === "fresh") {
    return { kind: "fresh" };
  }
  if (input.action === "resume-history") {
    const historyId = input.historyId?.trim() ?? "";
    if (historyId === "") {
      return { kind: "picker" };
    }
    return { kind: "resume", sessionId: historyId };
  }
  const currentId = input.currentId?.trim() ?? "";
  if (input.unidentified === true || currentId === "") {
    return { kind: "picker" };
  }
  return { kind: "resume", sessionId: currentId };
}
