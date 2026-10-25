/**
 * 没叫醒上级的汇报（T11.0b）。
 *
 * 监管者在线时，执行的 done / progress 只进上级收件箱、不叫醒它，由监管者核对后转交。
 * 这里记下这些汇报；超过宽限期还没处理的交给调用方，调用方看上级读没读，没读就提醒它一次。
 * 每条只交出一次。只在内存里记，应用重启就清：重启后的交接会让管理者看未读。
 */

export const SILENT_REPORT_GRACE_MS = 10 * 60_000;

export interface SilentReportDue {
  readonly managerId: string;
  readonly recordIds: readonly string[];
}

export interface SilentReportWatch {
  note(managerId: string, recordId: string): void;
  /** 到期的条目，按上级分组。交出后就不再记着。 */
  takeDue(): readonly SilentReportDue[];
  forget(managerId: string): void;
}

export function createSilentReportWatch(deps: {
  readonly now: () => number;
  readonly graceMs?: number;
}): SilentReportWatch {
  const grace = deps.graceMs ?? SILENT_REPORT_GRACE_MS;
  const pending = new Map<string, Map<string, number>>();
  return {
    note(managerId, recordId) {
      const records = pending.get(managerId) ?? new Map<string, number>();
      if (!records.has(recordId)) {
        records.set(recordId, deps.now());
      }
      pending.set(managerId, records);
    },
    takeDue() {
      const now = deps.now();
      const due: SilentReportDue[] = [];
      for (const [managerId, records] of pending) {
        const recordIds = [...records]
          .filter(([, at]) => now - at >= grace)
          .map(([recordId]) => recordId);
        if (recordIds.length === 0) {
          continue;
        }
        for (const recordId of recordIds) {
          records.delete(recordId);
        }
        if (records.size === 0) {
          pending.delete(managerId);
        }
        due.push({ managerId, recordIds });
      }
      return due;
    },
    forget(managerId) {
      pending.delete(managerId);
    },
  };
}

/** 提醒上级的一句话。以「[新消息]」开头，hook 会照常把收件箱正文附上。 */
export function buildSilentReportReminder(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return `[新消息] 有 ${n} 条执行汇报 10 分钟没人转交给你（监管者在线，但没有汇报）。请调用 ffpane_read_inbox 查看，再决定下一步。`;
}
