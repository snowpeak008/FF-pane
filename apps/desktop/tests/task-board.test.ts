import type { Task } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { BOARD_STATUSES, groupTasksByStatus } from "../src/renderer/src/pages/tasks/task-board";

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    planVersion: 1,
    goal: `goal ${id}`,
    writeScope: [],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: [],
    status,
  } as unknown as Task;
}

describe("BOARD_STATUSES", () => {
  it("六列、不含 cancelled", () => {
    expect(BOARD_STATUSES).toEqual(["pending", "running", "blocked", "failed", "done", "accepted"]);
    expect(BOARD_STATUSES).not.toContain("cancelled");
  });
});

describe("groupTasksByStatus", () => {
  it("按状态归组、保持顺序", () => {
    const groups = groupTasksByStatus([
      task("a", "pending"),
      task("b", "done"),
      task("c", "pending"),
    ]);
    expect(groups.pending.map((t) => t.id)).toEqual(["a", "c"]);
    expect(groups.done.map((t) => t.id)).toEqual(["b"]);
    expect(groups.running).toEqual([]);
  });

  it("cancelled 任务归入 cancelled 组（看板不渲染该组）", () => {
    const groups = groupTasksByStatus([task("x", "cancelled")]);
    expect(groups.cancelled.map((t) => t.id)).toEqual(["x"]);
    for (const s of BOARD_STATUSES) {
      expect(groups[s]).toEqual([]);
    }
  });
});
