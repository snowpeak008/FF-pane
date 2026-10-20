/**
 * 新消息提醒文案（T10.7a）。
 * 固定模板。标题先消毒再拼进一行。
 * 正文本身不进 PTY：Claude 窗口由 UserPromptSubmit hook 把正文作为附加上下文交给模型；
 * 没有这类 hook 的窗口（Codex、Grok）只在提醒行里带一段消毒、截断后的摘要。
 */

import type { WorkbenchRole } from "@ff-pane/shared";

export const REPORT_STATUSES = ["done", "blocked", "failed", "progress"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const WORKBENCH_ROLE_LABEL: Readonly<Record<WorkbenchRole, string>> = {
  manager: "管理者",
  planner: "规划",
  worker: "执行",
  reviewer: "检查",
  supervisor: "监管者",
  none: "普通",
};

const TITLE_MAX = 32;
export const REMINDER_SUMMARY_MAX = 200;
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/;

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

/**
 * 提醒行里的摘要：换行和控制字符收成空格，去掉「」、方括号、双引号和反引号，截到 200 字。
 * 摘要放在「」里，前面已写明来自哪个窗口；去掉「」免得伪造边界。
 */
export function sanitizeReminderSummary(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0x1b) {
      out += " ";
      continue;
    }
    if ('「」[]"`'.includes(char)) {
      out += " ";
      continue;
    }
    out += char;
  }
  const collapsed = out.replace(/\s+/g, " ").trim();
  const chars = [...collapsed];
  if (chars.length <= REMINDER_SUMMARY_MAX) {
    return collapsed;
  }
  return `${chars.slice(0, REMINDER_SUMMARY_MAX).join("")}…`;
}

export interface ReminderBody {
  /** 最新一条的 id。 */
  readonly id?: string;
  /** 有 hook 附上正文的窗口为 attached；否则带摘要。 */
  readonly delivery: "attached" | "summary";
  readonly summary?: string;
}

function reminderTail(body: ReminderBody | undefined): string {
  const id = body?.id !== undefined && MESSAGE_ID.test(body.id) ? `，id ${body.id}` : "";
  if (body?.delivery === "attached") {
    return `${id}。正文已附在本条之后；没看到就调用 ffpane_read_inbox。`;
  }
  const summary = body?.summary !== undefined ? sanitizeReminderSummary(body.summary) : "";
  const part = summary !== "" ? `摘要：「${summary}」。` : "";
  return `${id}。${part}请调用 ffpane_read_inbox 查看全文。`;
}

export function buildNewMessageReminder(input: {
  readonly title: string;
  readonly role: WorkbenchRole;
  readonly kind: "message" | "report";
  readonly status?: ReportStatus;
  readonly body?: ReminderBody;
}): string {
  const title = sanitizeReminderTitle(input.title);
  const role = WORKBENCH_ROLE_LABEL[input.role];
  const what = input.kind === "report" ? `汇报:${input.status ?? "progress"}` : "消息";
  return `[新消息] 来自 ${title}（${role}）：${what}${reminderTail(input.body)}`;
}

export function buildCoalescedReminder(count: number, body?: ReminderBody): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const latest =
    body?.id !== undefined && MESSAGE_ID.test(body.id) ? `，最新一条 id ${body.id}` : "";
  const tail = reminderTail(
    body === undefined
      ? undefined
      : {
          delivery: body.delivery,
          ...(body.summary !== undefined ? { summary: body.summary } : {}),
        },
  );
  return `[新消息] 你有 ${n} 条新消息${latest}${tail}`;
}
