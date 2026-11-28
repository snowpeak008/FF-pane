/**
 * T11.24：提醒与交接带账本。管理者看得到未完成，其他角色看不到。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkbenchRole } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildCoalescedReminder, buildNewMessageReminder } from "../src/main/workbench/remind";
import { resumeHandoffText } from "../src/main/workbench/resume-handoff";
import type { LedgerTask } from "../src/main/workbench/task-ledger";
import { updateLedger } from "../src/main/workbench/task-ledger-store";
import { ledgerListForManager, summarizeForManager } from "../src/main/workbench/task-tools";

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
  const dir = mkdtempSync(join(tmpdir(), "ffpane-handoff-"));
  dirs.push(dir);
  return dir;
}

function task(id: string, status: LedgerTask["status"], title: string): LedgerTask {
  return {
    id,
    title,
    detail: "",
    acceptance: "验收",
    status,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { windowId: "m1", title: "管理者", role: "manager" },
    events: [],
  };
}

describe("提醒文案带账本", () => {
  const body = { delivery: "attached" as const };

  it("给了就给管理者附在末尾，没给就不加", () => {
    const withLedger = buildNewMessageReminder({
      title: "执行甲",
      role: "worker" as WorkbenchRole,
      kind: "report",
      status: "done",
      body,
      ledger: "任务账本：未完成 3 条",
    });
    expect(withLedger).toContain("任务账本：未完成 3 条");
    const without = buildNewMessageReminder({
      title: "执行甲",
      role: "worker" as WorkbenchRole,
      kind: "report",
      status: "done",
      body,
    });
    expect(without).not.toContain("任务账本");
    expect(buildCoalescedReminder(4, body, "任务账本：未完成 3 条")).toContain("未完成 3 条");
    expect(buildCoalescedReminder(4, body)).not.toContain("任务账本");
  });
});

describe("管理者摘要", () => {
  it("按要处理的优先排序，指出最先看哪条", async () => {
    const root = project();
    await updateLedger(root, () => ({
      tasks: [
        task("t1", "todo", "普通活"),
        task("t2", "failed", "失败的活"),
        task("t3", "submitted", "等判定的活"),
      ],
    }));
    const line = await summarizeForManager(root);
    expect(line).toContain("未完成 3 条");
    expect(line).toContain("其中 2 条要你处理");
    expect(line).toContain("t2");
  });

  it("没有账本返回空", async () => {
    expect(await summarizeForManager(project())).toBeUndefined();
    expect(await ledgerListForManager(project())).toBeUndefined();
  });
});

describe("交接清单", () => {
  it("只列未完成，带状态和负责人，最多 20 条", async () => {
    const root = project();
    const many: LedgerTask[] = Array.from({ length: 25 }, (_, index) =>
      task(`t${index}`, "todo", `活 ${index}`),
    );
    await updateLedger(root, () => ({ tasks: many }));
    const list = (await ledgerListForManager(root)) ?? "";
    expect(list).toContain("未完成 25 条");
    expect(list).toContain("t0 [todo] 活 0");
    expect(list).toContain("还有 5 条");
    expect(list.split("；").length).toBeLessThan(26);
  });

  it("交接消息里带上清单", () => {
    const text = resumeHandoffText({
      reason: "takeover",
      title: "Claude 16",
      role: "manager" as WorkbenchRole,
      unread: 0,
      ledgerList: "未完成 2 条：t1 [doing] 甲 @执行一",
    });
    expect(text).toContain("任务账本（以它为准，别凭记忆）");
    expect(text).toContain("t1 [doing] 甲 @执行一");
  });

  it("没给清单时不出现那段", () => {
    const text = resumeHandoffText({
      reason: "restart",
      title: "Claude 16",
      role: "manager" as WorkbenchRole,
      unread: 0,
    });
    expect(text).not.toContain("任务账本");
  });
});
