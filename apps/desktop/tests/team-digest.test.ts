/**
 * 「待处理」：管理者暂停期间的事记在一页里，每个窗口一行、只留最新；处理过的划掉；只提醒一次。
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTeamDigest, digestRelativePath } from "../src/main/workbench/team-digest";

describe("待处理", () => {
  it("每个窗口一行，后来的覆盖前面的；文件在项目的 .ffpane/briefs 里", async () => {
    const root = mkdtempSync(join(tmpdir(), "ffpane-digest-"));
    const digest = createTeamDigest({ now: () => Date.UTC(2026, 9, 22, 2, 0) });
    await digest.note({
      managerId: "m",
      projectRoot: root,
      windowId: "w1",
      title: "执行一",
      text: "汇报 done",
    });
    await digest.note({
      managerId: "m",
      projectRoot: root,
      windowId: "w2",
      title: "执行二",
      text: "限流停下",
    });
    const result = await digest.note({
      managerId: "m",
      projectRoot: root,
      windowId: "w1",
      title: "执行一",
      text: "又汇报了\n一次 blocked",
    });
    expect(result).toEqual({ count: 2, relativePath: digestRelativePath("m") });
    const body = readFileSync(join(root, digestRelativePath("m")), "utf8");
    expect(body).toContain("执行一（w1）：又汇报了 一次 blocked");
    expect(body).not.toContain("汇报 done");
    expect(body).toContain("执行二（w2）：限流停下");
  });

  it("处理过的划掉；全划掉就删文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "ffpane-digest-"));
    const digest = createTeamDigest({ now: () => 0 });
    await digest.note({ managerId: "m", projectRoot: root, windowId: "w1", title: "a", text: "x" });
    await digest.clear("m", "w1");
    expect(digest.count("m")).toBe(0);
    expect(existsSync(join(root, digestRelativePath("m")))).toBe(false);
  });

  it("同一版只提醒一次，有新事再提醒", async () => {
    const root = mkdtempSync(join(tmpdir(), "ffpane-digest-"));
    const digest = createTeamDigest({ now: () => 0 });
    expect(digest.takeAnnouncement("m")).toBe(false);
    await digest.note({ managerId: "m", projectRoot: root, windowId: "w1", title: "a", text: "x" });
    expect(digest.takeAnnouncement("m")).toBe(true);
    expect(digest.takeAnnouncement("m")).toBe(false);
    await digest.note({ managerId: "m", projectRoot: root, windowId: "w2", title: "b", text: "y" });
    expect(digest.takeAnnouncement("m")).toBe(true);
  });
});
