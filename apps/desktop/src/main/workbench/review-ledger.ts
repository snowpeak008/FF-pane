/**
 * T11.4：评审台账的读写（`<项目>/.ffpane/reviews/<计划名>.md`）。
 *
 * 台账由平台生成，不靠模型手写格式。取轮次靠「提出者 + 第几轮」数出来；
 * 否决过的编号从台账里解析，用来拦重提。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ReviewLedgerEntry, reviewLedgerFileName } from "./plan-review";

export const REVIEWS_DIR_NAME = ".ffpane";

export function reviewsDir(projectRoot: string): string {
  return join(resolve(projectRoot), REVIEWS_DIR_NAME, "reviews");
}

export function reviewLedgerPath(projectRoot: string, planPath: string): string {
  return join(reviewsDir(projectRoot), reviewLedgerFileName(planPath));
}

/** 台账里的一条（解析回来的）。 */
export interface ParsedLedgerRow {
  readonly number: number;
  readonly reviewer: string;
  readonly round: number;
  readonly status: string;
}

const ROW =
  /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*第(\d+)轮\s*\|\s*([^|]*?)\s*\|/;

/** 从台账正文解析已有编号、轮次、状态。解析不了的列跳过。 */
export function parseLedgerRows(text: string): readonly ParsedLedgerRow[] {
  const rows: ParsedLedgerRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (match === null) {
      continue;
    }
    const number = Number(match[1]);
    const round = Number(match[5]);
    if (!Number.isInteger(number) || !Number.isInteger(round)) {
      continue;
    }
    rows.push({ number, reviewer: match[4] ?? "", round, status: match[6] ?? "" });
  }
  return rows;
}

/** 同一计划、同一评审窗口已经交过几轮。 */
export function roundsSoFar(rows: readonly ParsedLedgerRow[], reviewer: string): number {
  let max = 0;
  for (const row of rows) {
    if (row.reviewer === reviewer && row.round > max) {
      max = row.round;
    }
  }
  return max;
}

/** 否决过的编号。 */
export function rejectedNumbersOf(rows: readonly ParsedLedgerRow[]): ReadonlySet<number> {
  return new Set(rows.filter((row) => row.status === "否决").map((row) => row.number));
}

export interface ReviewLedger {
  readonly path: string;
  readonly text: string;
  readonly rows: readonly ParsedLedgerRow[];
}

export async function readReviewLedger(
  projectRoot: string,
  planPath: string,
): Promise<ReviewLedger> {
  const path = reviewLedgerPath(projectRoot, planPath);
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = "";
  }
  return { path, text, rows: parseLedgerRows(text) };
}

/** 追加一批条目（编号从已有最大 +1 起）。返回写入的条目。 */
export async function appendLedgerEntries(input: {
  readonly projectRoot: string;
  readonly planPath: string;
  readonly header: string;
  readonly entries: readonly Omit<ReviewLedgerEntry, "number">[];
  readonly format: (entry: ReviewLedgerEntry) => string;
}): Promise<readonly ReviewLedgerEntry[]> {
  const ledger = await readReviewLedger(input.projectRoot, input.planPath);
  const start = ledger.rows.reduce((max, row) => Math.max(max, row.number), 0) + 1;
  const numbered: ReviewLedgerEntry[] = input.entries.map((entry, index) => ({
    ...entry,
    number: start + index,
  }));
  const base = ledger.text.trim() === "" ? input.header : ledger.text.replace(/\s*$/, "");
  const text = `${base}\n${numbered.map(input.format).join("\n")}\n`;
  await mkdir(reviewsDir(input.projectRoot), { recursive: true });
  await writeFile(ledger.path, text, "utf8");
  return numbered;
}

/** 改一条的状态（采纳 / 否决 / 延后 / 交拍板）。返回是否找到。 */
export async function setLedgerStatus(input: {
  readonly projectRoot: string;
  readonly planPath: string;
  readonly number: number;
  readonly status: ReviewLedgerEntry["status"];
}): Promise<boolean> {
  const ledger = await readReviewLedger(input.projectRoot, input.planPath);
  const lines = ledger.text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    const match = ROW.exec(line);
    if (match === null || Number(match[1]) !== input.number) {
      return line;
    }
    found = true;
    return line.replace(
      /^(\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|)\s*([^|]*?)(\s*\|)/,
      `$1 ${input.status} $3`,
    );
  });
  if (!found) {
    return false;
  }
  await writeFile(ledger.path, next.join("\n"), "utf8");
  return true;
}
