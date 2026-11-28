/**
 * T11.4：计划评审的问题台账（计划 §3.5、§4.1）。
 *
 * 台账按计划分：`.ffpane/reviews/<计划名>.md`，由平台按评审提交生成，不靠模型手写格式。
 * 这里只做纯逻辑：校验一条评审该不该收、算第几轮、拼台账行；写盘由调用方做。
 */

import { stripControls } from "./remind";

export const REVIEW_LEVELS = ["blocking", "important", "detail"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export const REVIEW_LAYERS = ["goal", "boundary", "implementation"] as const;
export type ReviewLayer = (typeof REVIEW_LAYERS)[number];

export const REVIEW_VERDICTS = ["ok", "fix_then_ok", "cannot_start"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewFinding {
  readonly level: ReviewLevel;
  readonly layer: ReviewLayer;
  /** 计划里哪一节。 */
  readonly location: string;
  /** 阻断级必须附证据：读过的一行或实际跑出的输出。 */
  readonly evidence?: string;
  readonly suggestion: string;
  /** 第二轮引用第一轮哪一条。 */
  readonly refersTo?: number;
}

export interface ReviewLedgerEntry {
  readonly number: number;
  readonly level: ReviewLevel;
  readonly layer: ReviewLayer;
  readonly reviewer: string;
  readonly round: number;
  readonly status: "待定" | "采纳" | "否决" | "延后" | "交拍板";
  readonly location: string;
  readonly suggestion: string;
  readonly evidence?: string;
}

export type ReviewRejectReason =
  | "blocking_no_evidence"
  | "too_many_findings"
  | "new_finding_round2"
  | "round_limit"
  | "already_rejected";

export type ReviewValidation =
  | { readonly ok: true; readonly findings: readonly ReviewFinding[]; readonly round: number }
  | { readonly ok: false; readonly reason: ReviewRejectReason; readonly error: string };

const MAX_BLOCKING_PLUS_IMPORTANT = 5;

function isLevel(value: unknown): value is ReviewLevel {
  return typeof value === "string" && (REVIEW_LEVELS as readonly string[]).includes(value);
}

function isLayer(value: unknown): value is ReviewLayer {
  return typeof value === "string" && (REVIEW_LAYERS as readonly string[]).includes(value);
}

/** 实现层的问题自动降为细节（§3.3）。 */
function downgrade(finding: ReviewFinding): ReviewFinding {
  return finding.layer === "implementation" && finding.level !== "detail"
    ? { ...finding, level: "detail" }
    : finding;
}

/**
 * 校验一次评审。round 由调用方按「同一计划 + 同一评审窗口」已有轮次算出（第一轮 = 1）。
 * rejectedNumbers：否决过的条目编号，第二批又提出来要退回。
 */
export function validateReview(input: {
  readonly findings: readonly unknown[];
  readonly round: number;
  readonly rejectedNumbers: ReadonlySet<number>;
}): ReviewValidation {
  if (input.round > 2) {
    return {
      ok: false,
      reason: "round_limit",
      error: "同一计划同一评审最多交两轮。剩下的交管理者拍板，或写成执行注意事项。",
    };
  }
  const parsed: ReviewFinding[] = [];
  for (const [index, raw] of input.findings.entries()) {
    if (raw === null || typeof raw !== "object") {
      return {
        ok: false,
        reason: "blocking_no_evidence",
        error: `findings[${index}] 必须是对象，含 level、layer、location、suggestion。`,
      };
    }
    const record = raw as Record<string, unknown>;
    if (!isLevel(record["level"])) {
      return {
        ok: false,
        reason: "blocking_no_evidence",
        error: `findings[${index}].level 只能是 blocking、important、detail。`,
      };
    }
    if (!isLayer(record["layer"])) {
      return {
        ok: false,
        reason: "blocking_no_evidence",
        error: `findings[${index}].layer 只能是 goal、boundary、implementation。`,
      };
    }
    const location = typeof record["location"] === "string" ? record["location"].trim() : "";
    const suggestion = typeof record["suggestion"] === "string" ? record["suggestion"].trim() : "";
    if (location === "" || suggestion === "") {
      return {
        ok: false,
        reason: "blocking_no_evidence",
        error: `findings[${index}] 缺少 location 或 suggestion。`,
      };
    }
    const evidence =
      typeof record["evidence"] === "string" && record["evidence"].trim() !== ""
        ? record["evidence"].trim()
        : undefined;
    const refersTo =
      typeof record["refersTo"] === "number" && Number.isInteger(record["refersTo"])
        ? record["refersTo"]
        : undefined;
    parsed.push(
      downgrade({
        level: record["level"],
        layer: record["layer"],
        location: location.slice(0, 200),
        suggestion: suggestion.slice(0, 1000),
        ...(evidence !== undefined ? { evidence: evidence.slice(0, 1000) } : {}),
        ...(refersTo !== undefined ? { refersTo } : {}),
      }),
    );
  }
  const blocking = parsed.filter((finding) => finding.level === "blocking");
  if (blocking.some((finding) => finding.evidence === undefined)) {
    return {
      ok: false,
      reason: "blocking_no_evidence",
      error: "阻断级问题必须附证据（证据是实际读过的一行，或实际跑出的输出）。",
    };
  }
  const heavy = parsed.filter((finding) => finding.level !== "detail").length;
  if (heavy > MAX_BLOCKING_PLUS_IMPORTANT) {
    return {
      ok: false,
      reason: "too_many_findings",
      error: `每轮最多 ${MAX_BLOCKING_PLUS_IMPORTANT} 条阻断加重要，按严重程度排，名额有限。`,
    };
  }
  const repeated = parsed.find(
    (finding) => finding.refersTo !== undefined && input.rejectedNumbers.has(finding.refersTo),
  );
  if (repeated !== undefined) {
    return {
      ok: false,
      reason: "already_rejected",
      error: `第 ${repeated.refersTo} 条已经否决过，不重提；有分歧交管理者拍板。`,
    };
  }

  if (input.round >= 2 && parsed.some((finding) => finding.level !== "blocking")) {
    return {
      ok: false,
      reason: "new_finding_round2",
      error: "第二轮只核对第一轮改好没有，不提新的非阻断问题（带证据的阻断级除外）。",
    };
  }
  return { ok: true, findings: parsed, round: input.round };
}

const LEVEL_TEXT: Readonly<Record<ReviewLevel, string>> = {
  blocking: "阻断",
  important: "重要",
  detail: "细节",
};
const LAYER_TEXT: Readonly<Record<ReviewLayer, string>> = {
  goal: "目标",
  boundary: "边界",
  implementation: "实现",
};

/** 台账里的一行。 */
export function formatLedgerEntry(entry: ReviewLedgerEntry): string {
  const evidence = entry.evidence !== undefined ? `｜证据 ${entry.evidence}` : "";
  return `| ${entry.number} | ${LEVEL_TEXT[entry.level]} | ${LAYER_TEXT[entry.layer]} | ${entry.reviewer} | 第${entry.round}轮 | ${entry.status} | ${entry.location} | ${entry.suggestion} |${evidence} |`;
}

/** 台账文件的开头。 */
export function ledgerHeader(planPath: string): string {
  return [
    "# 计划评审台账",
    "",
    `计划：${planPath}`,
    "",
    "由平台按评审提交生成，不手改。状态：待定 / 采纳 / 否决 / 延后 / 交拍板。",
    "否决过的不许重提。",
    "",
    "| 编号 | 级别 | 所在层 | 提出者 | 轮次 | 状态 | 位置 | 建议 | 备注 |",
    "|---|---|---|---|---|---|---|---|---|",
  ].join("\n");
}

/** 台账文件名（不含目录）：去掉路径、控制字符和 Windows 不允许用于文件名的字符。 */
export function reviewLedgerFileName(planPath: string): string {
  const base = planPath.split(/[\\/]/).pop() ?? "plan";
  const stem = base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
  const safe = Array.from(stripControls(stem))
    .map((char) => ('<>:"|?*'.includes(char) ? "-" : char))
    .join("");
  return `${safe.slice(0, 80)}.md`;
}
