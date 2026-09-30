/**
 * 新消息提醒文案（T10.7a）。
 * 固定模板，正文绝不进 PTY。标题先消毒再拼进一行。
 */

import type { WorkbenchRole } from "@ff-pane/shared";

export const REPORT_STATUSES = ["done", "blocked", "failed", "progress"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const WORKBENCH_ROLE_LABEL: Readonly<Record<WorkbenchRole, string>> = {
  manager: "管理者",
  planner: "规划",
  worker: "执行",
  reviewer: "检查",
  none: "普通",
};

const TITLE_MAX = 32;

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

/** 去掉 C0 控制字符和 DEL。 */
export function stripControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += char;
  }
  return out;
}

export function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 人读正文：保留换行，去掉其它 C0 与 DEL，把 \\r\\n / \\r 收成 \\n。
 * 调用方再把每一行写成引用，避免正文伪造 Markdown 标题。
 */
export function sanitizeThreadBody(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let out = "";
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += "\n";
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += char;
  }
  return out;
}

export function quoteThreadBody(text: string): string {
  const clean = sanitizeThreadBody(text);
  const lines = clean.length === 0 ? [""] : clean.split("\n");
  return lines.map((line) => `> ${line}`).join("\n");
}

/** 去掉控制字符、ESC、换行，只留字母数字与少量标点，并限制长度。 */
export function sanitizeReminderTitle(title: string): string {
  const withoutControls = stripControls(title);
  const kept = withoutControls.replace(/[^\p{L}\p{N} ._\-·]/gu, "");
  const trimmed = kept.trim().slice(0, TITLE_MAX);
  return trimmed.length > 0 ? trimmed : "窗口";
}

export function sanitizeThreadText(text: string): string {
  return stripControls(text);
}

export function buildNewMessageReminder(input: {
  readonly title: string;
  readonly role: WorkbenchRole;
  readonly kind: "message" | "report";
  readonly status?: ReportStatus;
}): string {
  const title = sanitizeReminderTitle(input.title);
  const role = WORKBENCH_ROLE_LABEL[input.role];
  const what = input.kind === "report" ? `汇报:${input.status ?? "progress"}` : "消息";
  return `[新消息] 来自 ${title}（${role}）：${what}。请调用 ffpane_read_inbox 查看。`;
}

export function buildCoalescedReminder(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return `[新消息] 你有 ${n} 条新消息。请调用 ffpane_read_inbox 查看。`;
}
