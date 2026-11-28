/**
 * T11.4：汇报必带检查结果。只测校验和摘要，不碰收件箱。
 */

import { describe, expect, it } from "vitest";
import { assertDoneChecks, checksDigest, parseChecks } from "../src/main/workbench/report-checks";

describe("parseChecks", () => {
  it("没传就当作空", () => {
    expect(parseChecks(undefined)).toEqual({ ok: true, checks: [] });
  });

  it("解析正常条目，去掉首尾空白", () => {
    const parsed = parseChecks([
      { command: " pnpm test ", result: "pass" },
      { command: "biome", result: "fail", note: "两个警告" },
    ]);
    expect(parsed).toEqual({
      ok: true,
      checks: [
        { command: "pnpm test", result: "pass" },
        { command: "biome", result: "fail", note: "两个警告" },
      ],
    });
  });

  it("缺 command、结果不在枚举里都退回并指出第几条", () => {
    expect(parseChecks([{ result: "pass" }])).toMatchObject({ ok: false });
    const bad = parseChecks([{ command: "x", result: "ok" }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("checks[0].result");
    }
    expect(parseChecks("not an array")).toMatchObject({ ok: false });
  });
});

describe("assertDoneChecks", () => {
  it("执行报 done 没有 checks 也没有理由：退回", () => {
    expect(
      assertDoneChecks({ status: "done", role: "worker", checks: [], noChecksReason: undefined }),
    ).toMatchObject({ ok: false });
  });

  it("有 checks 放行；有 noChecksReason 也放行", () => {
    expect(
      assertDoneChecks({
        status: "done",
        role: "worker",
        checks: [{ command: "pnpm test", result: "pass" }],
        noChecksReason: undefined,
      }),
    ).toEqual({ ok: true });
    expect(
      assertDoneChecks({
        status: "done",
        role: "worker",
        checks: [],
        noChecksReason: "只改了文档，没有可跑的检查",
      }),
    ).toEqual({ ok: true });
  });

  it("不是 done 就不拦；管理者、检查者报 done 也不拦", () => {
    expect(
      assertDoneChecks({
        status: "blocked",
        role: "worker",
        checks: [],
        noChecksReason: undefined,
      }),
    ).toEqual({ ok: true });
    expect(
      assertDoneChecks({
        status: "done",
        role: "reviewer",
        checks: [],
        noChecksReason: undefined,
      }),
    ).toEqual({ ok: true });
  });
});

describe("checksDigest", () => {
  it("一条一行，结果写中文", () => {
    const text = checksDigest(
      [
        { command: "pnpm test", result: "pass" },
        { command: "biome", result: "fail", note: "两个警告" },
        { command: "e2e", result: "not_run", note: "太慢" },
      ],
      undefined,
    );
    expect(text.split("\n")).toEqual([
      "- pnpm test：通过",
      "- biome：不通过（两个警告）",
      "- e2e：没跑（太慢）",
    ]);
  });

  it("没有检查时写理由；都没有就空", () => {
    expect(checksDigest([], "只改文档")).toBe("- 没有可跑的检查：只改文档");
    expect(checksDigest([], undefined)).toBe("");
  });
});
