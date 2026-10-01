/**
 * 团队看板分列（纯函数）。
 * 进行中 = 最近汇报 progress，或没有汇报但窗口仍在运行。
 * 无汇报且未运行的窗口不进任何列。
 */

import type { WorkbenchPermissionLevel, WorkbenchRole } from "@ff-pane/shared";

export const BOARD_COLUMNS = ["progress", "blocked", "done", "failed"] as const;
export type BoardColumnId = (typeof BOARD_COLUMNS)[number];

export interface BoardReport {
  readonly status: BoardColumnId;
  readonly summary: string;
  readonly ts: string;
  readonly briefPath?: string;
}

export interface BoardMember {
  readonly id: string;
  readonly title: string;
  readonly role: WorkbenchRole;
  readonly permission: WorkbenchPermissionLevel;
  readonly parentWindowId?: string;
  readonly parentTitle?: string;
  readonly running: boolean;
  readonly report?: BoardReport;
}

export interface BoardGroup {
  readonly id: string;
  readonly title: string;
  readonly manager: boolean;
  readonly columns: Readonly<Record<BoardColumnId, readonly BoardMember[]>>;
}

export function columnOf(member: BoardMember): BoardColumnId | undefined {
  const status = member.report?.status;
  if (status === "blocked" || status === "done" || status === "failed" || status === "progress") {
    return status;
  }
  if (member.running) {
    return "progress";
  }
  return undefined;
}

function emptyColumns(): Record<BoardColumnId, BoardMember[]> {
  return { progress: [], blocked: [], done: [], failed: [] };
}

function teamAnchor(
  id: string,
  byId: ReadonlyMap<string, BoardMember>,
): { readonly id: string; readonly title: string; readonly manager: boolean } {
  const seen = new Set<string>();
  let current: string | undefined = id;
  let managerId: string | undefined;
  let top = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    top = current;
    const node = byId.get(current);
    if (node?.role === "manager") {
      managerId = current;
    }
    const parent = node?.parentWindowId?.trim() ?? "";
    current = parent.length > 0 ? parent : undefined;
  }
  const anchor = managerId ?? top;
  const node = byId.get(anchor);
  return {
    id: anchor,
    title: node?.title ?? anchor,
    manager: node?.role === "manager",
  };
}

function byRecency(a: BoardMember, b: BoardMember): number {
  const at = a.report?.ts ?? "";
  const bt = b.report?.ts ?? "";
  if (at !== bt) {
    return bt.localeCompare(at);
  }
  return a.title.localeCompare(b.title);
}

/** 按最上层管理者分组。没有管理者的窗口单独成组。空列保留，空组去掉。 */
export function groupTeamBoard(members: readonly BoardMember[]): readonly BoardGroup[] {
  const byId = new Map(members.map((member) => [member.id, member]));
  const groups = new Map<string, BoardGroup & { columns: Record<BoardColumnId, BoardMember[]> }>();
  for (const member of members) {
    const column = columnOf(member);
    if (column === undefined) {
      continue;
    }
    const anchor = teamAnchor(member.id, byId);
    let group = groups.get(anchor.id);
    if (group === undefined) {
      group = {
        id: anchor.id,
        title: anchor.title,
        manager: anchor.manager,
        columns: emptyColumns(),
      };
      groups.set(anchor.id, group);
    }
    group.columns[column].push(member);
  }
  const list = [...groups.values()];
  for (const group of list) {
    for (const column of BOARD_COLUMNS) {
      group.columns[column].sort(byRecency);
    }
  }
  list.sort((a, b) => Number(b.manager) - Number(a.manager) || a.title.localeCompare(b.title));
  return list;
}
