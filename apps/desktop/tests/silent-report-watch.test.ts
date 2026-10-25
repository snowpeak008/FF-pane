/**
 * T11.0b：监管者在线时没叫醒上级的汇报，过了宽限期交给调用方提醒一次。
 */

import { describe, expect, it } from "vitest";
import {
  buildSilentReportReminder,
  createSilentReportWatch,
  SILENT_REPORT_GRACE_MS,
} from "../src/main/workbench/silent-report-watch";

describe("没叫醒上级的汇报", () => {
  it("不到 10 分钟不交出，到点只交一次", () => {
    let now = 0;
    const watch = createSilentReportWatch({ now: () => now });
    watch.note("m1", "r1");
    now = SILENT_REPORT_GRACE_MS - 1;
    expect(watch.takeDue()).toEqual([]);
    now = SILENT_REPORT_GRACE_MS;
    expect(watch.takeDue()).toEqual([{ managerId: "m1", recordIds: ["r1"] }]);
    expect(watch.takeDue()).toEqual([]);
  });

  it("按上级分开记，各自到点；重复记同一条不重置时间", () => {
    let now = 0;
    const watch = createSilentReportWatch({ now: () => now, graceMs: 100 });
    watch.note("m1", "r1");
    now = 50;
    watch.note("m1", "r1");
    watch.note("m1", "r2");
    watch.note("m2", "r3");
    now = 100;
    expect(watch.takeDue()).toEqual([{ managerId: "m1", recordIds: ["r1"] }]);
    now = 150;
    expect(watch.takeDue()).toEqual([
      { managerId: "m1", recordIds: ["r2"] },
      { managerId: "m2", recordIds: ["r3"] },
    ]);
  });

  it("上级窗口没了就忘掉", () => {
    let now = 0;
    const watch = createSilentReportWatch({ now: () => now, graceMs: 10 });
    watch.note("m1", "r1");
    watch.forget("m1");
    now = 10;
    expect(watch.takeDue()).toEqual([]);
  });

  it("提醒是一行，以「[新消息]」开头", () => {
    const text = buildSilentReportReminder(2);
    expect(text.startsWith("[新消息]")).toBe(true);
    expect(text).toContain("2 条执行汇报");
    expect(text).not.toContain("\n");
    expect(buildSilentReportReminder(0)).toContain("1 条");
  });
});
