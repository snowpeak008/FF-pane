/**
 * T11.4：汇报必带检查结果。
 *
 * 借 superset 的「交接必须交固定格式」：执行报 done 时，要说清跑了什么、结果如何，
 * 管理者和监管者不用读正文猜。检查窗口报结论时同样要带。
 * 纯函数：只校验和拼摘要，不改收件箱。
 */

export const REPORT_CHECK_RESULTS = ["pass", "fail", "not_run"] as const;
export type ReportCheckResult = (typeof REPORT_CHECK_RESULTS)[number];

export interface ReportCheck {
  readonly command: string;
  /** pass 通过、fail 不通过、not_run 没跑。 */
  readonly result: ReportCheckResult;
  readonly note?: string;
}

export type ChecksParse =
  | { readonly ok: true; readonly checks: readonly ReportCheck[] }
  | { readonly ok: false; readonly error: string };

const MAX_CHECKS = 40;
const MAX_COMMAND_CHARS = 200;
const MAX_NOTE_CHARS = 200;

function isResult(value: unknown): value is ReportCheckResult {
  return typeof value === "string" && (REPORT_CHECK_RESULTS as readonly string[]).includes(value);
}

/** 解析 checks 参数。没传返回空数组。 */
export function parseChecks(raw: unknown): ChecksParse {
  if (raw === undefined) {
    return { ok: true, checks: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "checks 必须是数组，每条写 command 和 result。" };
  }
  if (raw.length > MAX_CHECKS) {
    return { ok: false, error: `checks 最多 ${MAX_CHECKS} 条。` };
  }
  const checks: ReportCheck[] = [];
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== "object") {
      return { ok: false, error: `checks[${index}] 必须是对象。` };
    }
    const record = item as Record<string, unknown>;
    const command = typeof record["command"] === "string" ? record["command"].trim() : "";
    if (command === "") {
      return { ok: false, error: `checks[${index}] 缺少 command。` };
    }
    if (!isResult(record["result"])) {
      return {
        ok: false,
        error: `checks[${index}].result 只能是 pass、fail 或 not_run。`,
      };
    }
    const note =
      typeof record["note"] === "string" && record["note"].trim() !== ""
        ? record["note"].trim().slice(0, MAX_NOTE_CHARS)
        : undefined;
    checks.push({
      command: command.slice(0, MAX_COMMAND_CHARS),
      result: record["result"],
      ...(note !== undefined ? { note } : {}),
    });
  }
  return { ok: true, checks };
}

/**
 * done 汇报必须有检查结果。执行窗口没有可跑的检查时，用 noChecksReason 说明；
 * 检查窗口、管理者报 done 可以不跑检查（他们的产物就是结论），但也要求写一句理由或结论在 summary 里，这里不拦。
 */
export function assertDoneChecks(input: {
  readonly status: string;
  readonly role: string;
  readonly checks: readonly ReportCheck[];
  readonly noChecksReason: string | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (input.status !== "done") {
    return { ok: true };
  }
  if (input.role !== "worker" && input.role !== "researcher") {
    return { ok: true };
  }
  const reason = input.noChecksReason?.trim() ?? "";
  if (input.checks.length > 0 || reason !== "") {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "报 done 必须带 checks：每条写 command 和 result（pass、fail、not_run）。确实没有可跑的检查，就用 noChecksReason 写一句原因。",
  };
}

const RESULT_TEXT: Readonly<Record<ReportCheckResult, string>> = {
  pass: "通过",
  fail: "不通过",
  not_run: "没跑",
};

/** 一条检查一行，附在摘要后面。 */
export function checksDigest(
  checks: readonly ReportCheck[],
  noChecksReason: string | undefined,
): string {
  if (checks.length > 0) {
    return checks
      .map(
        (check) =>
          `- ${check.command}：${RESULT_TEXT[check.result]}${check.note !== undefined ? `（${check.note}）` : ""}`,
      )
      .join("\n");
  }
  const reason = noChecksReason?.trim() ?? "";
  return reason !== "" ? `- 没有可跑的检查：${reason}` : "";
}
