/**
 * T11.4：评审台账读写。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatLedgerEntry, ledgerHeader } from "../src/main/workbench/plan-review";
import {
  appendLedgerEntries,
  parseLedgerRows,
  readReviewLedger,
  rejectedNumbersOf,
  roundsSoFar,
  setLedgerStatus,
} from "../src/main/workbench/review-ledger";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-review-"));
  dirs.push(dir);
  return dir;
}

const PLAN = ".ffpane/briefs/登录重构.md";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    level: "important" as const,
    layer: "boundary" as const,
    reviewer: "评审甲",
    round: 1,
    status: "待定" as const,
    location: "§3",
    suggestion: "补接口",
    ...overrides,
  };
}

describe("评审台账", () => {
  it("第一次写带表头，编号从 1 起；再追加接着编", async () => {
    const root = project();
    const first = await appendLedgerEntries({
      projectRoot: root,
      planPath: PLAN,
      header: ledgerHeader(PLAN),
      entries: [entry(), entry({ level: "blocking", evidence: "x.ts:1" })],
      format: formatLedgerEntry,
    });
    expect(first.map((item) => item.number)).toEqual([1, 2]);
    const second = await appendLedgerEntries({
      projectRoot: root,
      planPath: PLAN,
      header: ledgerHeader(PLAN),
      entries: [entry({ reviewer: "评审乙" })],
      format: formatLedgerEntry,
    });
    expect(second.map((item) => item.number)).toEqual([3]);
    const ledger = await readReviewLedger(root, PLAN);
    expect(ledger.rows).toHaveLength(3);
    // 表头只写一次
    expect(ledger.text.match(/# 计划评审台账/g)).toHaveLength(1);
  });

  it("按评审窗口算轮次，认出否决过的编号", async () => {
    const root = project();
    await appendLedgerEntries({
      projectRoot: root,
      planPath: PLAN,
      header: ledgerHeader(PLAN),
      entries: [entry(), entry({ reviewer: "评审乙", status: "否决" })],
      format: formatLedgerEntry,
    });
    const ledger = await readReviewLedger(root, PLAN);
    expect(roundsSoFar(ledger.rows, "评审甲")).toBe(1);
    expect(roundsSoFar(ledger.rows, "评审乙")).toBe(1);
    expect(roundsSoFar(ledger.rows, "没交过")).toBe(0);
    expect([...rejectedNumbersOf(ledger.rows)]).toEqual([2]);
  });

  it("改状态只动那一条", async () => {
    const root = project();
    await appendLedgerEntries({
      projectRoot: root,
      planPath: PLAN,
      header: ledgerHeader(PLAN),
      entries: [entry(), entry()],
      format: formatLedgerEntry,
    });
    expect(
      await setLedgerStatus({ projectRoot: root, planPath: PLAN, number: 2, status: "采纳" }),
    ).toBe(true);
    const ledger = await readReviewLedger(root, PLAN);
    expect(ledger.rows.map((row) => row.status)).toEqual(["待定", "采纳"]);
    expect(
      await setLedgerStatus({ projectRoot: root, planPath: PLAN, number: 99, status: "采纳" }),
    ).toBe(false);
  });

  it("没有台账时读出来是空的", async () => {
    const ledger = await readReviewLedger(project(), PLAN);
    expect(ledger.text).toBe("");
    expect(ledger.rows).toEqual([]);
    expect(parseLedgerRows("随便写点东西")).toEqual([]);
  });
});
