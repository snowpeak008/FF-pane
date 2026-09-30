/**
 * 工作台系统提示合成（T10.6）。
 * none 只有共同说明；其它角色是 base + 该角色说明书。覆盖副本由调用方事先选好再传入。
 */

import type { WorkbenchRole } from "@ff-pane/shared";

export interface ComposeWorkbenchSystemPromptInput {
  readonly base: string;
  /** 已解析的角色说明书正文。none 时忽略。 */
  readonly roleManual?: string;
  readonly role: WorkbenchRole;
}

/** 合成注入用的系统提示。统一成 LF，去掉首尾空白。 */
export function composeWorkbenchSystemPrompt(input: ComposeWorkbenchSystemPromptInput): string {
  const base = input.base.replace(/\r\n/g, "\n").trim();
  if (input.role === "none") {
    return base;
  }
  const manual = (input.roleManual ?? "").replace(/\r\n/g, "\n").trim();
  if (manual.length === 0) {
    return base;
  }
  return `${base}\n\n${manual}`;
}
