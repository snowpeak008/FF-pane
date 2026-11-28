/**
 * T11.24：任务账本存储。真写临时目录，钉住 active / 归档 / 备份 / 恢复 / 串行。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTransition, type LedgerTask } from "../src/main/workbench/task-ledger";
import {
  activeLedgerPath,
  archiveFileName,
  LEDGER_BACKUP_KEEP,
  ledgerViewPath,
  parseActiveLedger,
  readOpenLedger,
  renderLedgerView,
  tasksDir,
  updateLedger,
} from "../src/main/workbench/task-ledger-store";

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
  const dir = mkdtempSync(join(tmpdir(), "ffpane-ledger-"));
  dirs.push(dir);
  return dir;
}

function task(id: string, over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    id,
    title: `任务 ${id}`,
    detail: "内容",
    acceptance: "验收",
    status: "todo",
    createdAt: 1,
    updatedAt: 1,
    createdBy: { windowId: "w1", title: "管理者", role: "manager" },
    events: [],
    ...over,
  };
}

describe("读写", () => {
  it("没有文件是空账本", async () => {
    const root = project();
    expect(await readOpenLedger(root)).toEqual({ tasks: [], recovered: false });
  });

  it("写入后 active.json 和人读视图都在，再读回来一致", async () => {
    const root = project();
    await updateLedger(root, () => ({ tasks: [task("a"), task("b", { status: "doing" })] }));
    const read = await readOpenLedger(root);
    expect(read.tasks.map((item) => item.id)).toEqual(["a", "b"]);
    expect(readFileSync(ledgerViewPath(root), "utf8")).toContain("任务 a");
    expect(readFileSync(activeLedgerPath(root), "utf8")).toContain('"tasks"');
  });

  it("人读视图按管理者顺序，没有任务时说明", () => {
    const text = renderLedgerView([task("a"), task("b", { status: "failed" })]);
    expect(text.indexOf("任务 b")).toBeLessThan(text.indexOf("任务 a"));
    expect(renderLedgerView([])).toContain("没有未完成");
  });
});

describe("归档", () => {
  it("完成和取消的移进当月归档，只留未完成的在 active", async () => {
    const root = project();
    const at = new Date(2026, 10, 28, 12).getTime();
    await updateLedger(
      root,
      () => ({ tasks: [task("a"), task("b"), task("c")] }),
      () => at,
    );
    const result = await updateLedger(
      root,
      (open) => ({
        tasks: open.map((item) => {
          if (item.id === "a") {
            const moved = applyTransition(item, "cancelled", "w1", "不做了", at);
            return moved.ok ? moved.task : item;
          }
          return item;
        }),
      }),
      () => at,
    );
    expect(result.archived.map((item) => item.id)).toEqual(["a"]);
    expect(result.open.map((item) => item.id)).toEqual(["b", "c"]);
    const archive = readFileSync(join(tasksDir(root), "archive", archiveFileName(at)), "utf8");
    expect(archive.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(archive.trim()).id).toBe("a");
    expect(archiveFileName(at)).toBe("2026-11.jsonl");
  });

  it("归档只追加，不改已有的行", async () => {
    const root = project();
    const at = new Date(2026, 10, 28).getTime();
    const closed = (id: string): LedgerTask => task(id, { status: "cancelled" });
    await updateLedger(
      root,
      () => ({ tasks: [closed("x")] }),
      () => at,
    );
    await updateLedger(
      root,
      () => ({ tasks: [closed("y")] }),
      () => at + 1,
    );
    const lines = readFileSync(join(tasksDir(root), "archive", archiveFileName(at)), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["x", "y"]);
  });
});

describe("备份和恢复", () => {
  it("每次写之前存上一版，只留最近 20 份", async () => {
    const root = project();
    for (let index = 0; index < LEDGER_BACKUP_KEEP + 5; index += 1) {
      await updateLedger(
        root,
        () => ({ tasks: [task(`t${index}`)] }),
        () => 1000 + index,
      );
    }
    const backups = readdirSync(join(tasksDir(root), "backup"));
    expect(backups).toHaveLength(LEDGER_BACKUP_KEEP);
    // 留下的是最新的 20 份，最老的几份被删
    expect(backups).not.toContain("active-1000.json");
    expect(backups).toContain(`active-${1000 + LEDGER_BACKUP_KEEP + 3}.json`);
  });

  it("active.json 坏了就用最近一份备份恢复，并标出来", async () => {
    const root = project();
    await updateLedger(
      root,
      () => ({ tasks: [task("old")] }),
      () => 1,
    );
    await updateLedger(
      root,
      () => ({ tasks: [task("new")] }),
      () => 2,
    );
    writeFileSync(activeLedgerPath(root), "{坏了", "utf8");
    const read = await readOpenLedger(root);
    expect(read.recovered).toBe(true);
    // 最近一份备份是第二次写之前的那一版（里面是 old）
    expect(read.tasks.map((item) => item.id)).toEqual(["old"]);
  });

  it("坏了又没有备份：空账本，仍标 recovered", async () => {
    const root = project();
    mkdirSync(tasksDir(root), { recursive: true });
    writeFileSync(activeLedgerPath(root), "not json", "utf8");
    expect(await readOpenLedger(root)).toEqual({ tasks: [], recovered: true });
  });

  it("有一条不合格整份都算坏", () => {
    expect(parseActiveLedger(JSON.stringify({ tasks: [task("a"), { id: "b" }] }))).toBeUndefined();
    expect(parseActiveLedger(JSON.stringify({ tasks: [task("a")] }))).toHaveLength(1);
    expect(parseActiveLedger("[]")).toBeUndefined();
  });
});

describe("串行", () => {
  it("同项目的并发读改写不丢更新", async () => {
    const root = project();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        updateLedger(root, (open) => ({ tasks: [...open, task(`n${index}`)] })),
      ),
    );
    const read = await readOpenLedger(root);
    expect(read.tasks).toHaveLength(12);
    expect(new Set(read.tasks.map((item) => item.id)).size).toBe(12);
  });
});
