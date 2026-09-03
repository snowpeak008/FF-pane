/**
 * T8.4 core 侧单测：自定义角色草稿校验（设计文档 §3.1 / §7）。
 * 覆盖：合法通过、名称/提示词非空、§7 危险操作确认不可关闭（JSON 边界复核）、
 * shell 字面量复核、读/写路径不出项目根（绝对路径 / ~ / `..` 攀升逐条显式违规）、
 * 多处违规一次收齐、CustomRoleValidationError 封装。
 */

import type { PermissionEnvelope, ShellPolicy } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  type CustomRoleDraft,
  CustomRoleValidationError,
  type CustomRoleValidationResult,
  validateCustomRoleDraft,
} from "../src/index.js";

const SAFE_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: ["docs/**"],
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
};

function draft(overrides: Partial<CustomRoleDraft> = {}): CustomRoleDraft {
  return {
    name: "文档撰写者",
    systemPrompt: "你是文档撰写者。职责：只改 docs/ 下的文档，不碰源码。",
    permissionPreset: SAFE_PRESET,
    ...overrides,
  };
}

/** 断言校验失败且违规字段名（含顺序）完全匹配（与 profile.test.ts 同款助手）。 */
function expectViolationFields(
  result: CustomRoleValidationResult,
  fields: readonly string[],
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.violations.map((violation) => violation.field)).toEqual(fields);
  for (const violation of result.violations) {
    expect(violation.reason.length).toBeGreaterThan(0);
  }
}

describe("合法草稿通过", () => {
  it("名称 + 提示词 + 项目内预设：通过", () => {
    expect(validateCustomRoleDraft(draft())).toEqual({ ok: true });
  });

  it("空 readPaths / writePaths 合法（空数组 = 无该项权限，§7）", () => {
    const result = validateCustomRoleDraft(
      draft({ permissionPreset: { ...SAFE_PRESET, readPaths: [], writePaths: [] } }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("名称与提示词非空", () => {
  it("名称全空白：name 违规", () => {
    expectViolationFields(validateCustomRoleDraft(draft({ name: "   " })), ["name"]);
  });

  it("提示词全空白：systemPrompt 违规（空第 1 层不许建出来）", () => {
    expectViolationFields(validateCustomRoleDraft(draft({ systemPrompt: "\n\t " })), [
      "systemPrompt",
    ]);
  });
});

describe("§7 红线：危险操作确认物理不可关闭", () => {
  it("dangerousOpsRequireApproval 为 false（JSON / IPC 边界传入未收窄数据）：违规", () => {
    const result = validateCustomRoleDraft(
      draft({
        permissionPreset: {
          ...SAFE_PRESET,
          dangerousOpsRequireApproval: false as unknown as true,
        },
      }),
    );
    expectViolationFields(result, ["permissionPreset.dangerousOpsRequireApproval"]);
    if (!result.ok) {
      expect(result.violations[0]?.reason).toContain("§7");
    }
  });

  it("shell 字面量非法（JSON 边界复核）：违规", () => {
    expectViolationFields(
      validateCustomRoleDraft(
        draft({ permissionPreset: { ...SAFE_PRESET, shell: "sudo" as ShellPolicy } }),
      ),
      ["permissionPreset.shell"],
    );
  });
});

describe("路径不出项目根（宁窄勿宽升格为显式违规）", () => {
  it.each([
    ["盘符绝对路径", "C:\\Windows"],
    ["根斜杠", "/etc"],
    ["~ 展开", "~/secrets"],
    ["`..` 攀升出根", "../.."],
  ])("writePaths 含%s：违规", (_label, entry) => {
    expectViolationFields(
      validateCustomRoleDraft(draft({ permissionPreset: { ...SAFE_PRESET, writePaths: [entry] } })),
      ["permissionPreset.writePaths"],
    );
  });

  it("readPaths 的项目外条目同样违规，且每条各报一次", () => {
    const result = validateCustomRoleDraft(
      draft({ permissionPreset: { ...SAFE_PRESET, readPaths: ["src", "C:\\", "~/x"] } }),
    );
    expectViolationFields(result, ["permissionPreset.readPaths", "permissionPreset.readPaths"]);
  });

  it("项目内 glob 与子树条目不误报", () => {
    const result = validateCustomRoleDraft(
      draft({
        permissionPreset: { ...SAFE_PRESET, writePaths: ["docs/**", "src/*.md", "a/b/c"] },
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("多处违规一次收齐（不快速失败）", () => {
  it("空名 + 空提示词 + 关危险确认 + 越根路径：四类全部在列", () => {
    const result = validateCustomRoleDraft({
      name: "",
      systemPrompt: "",
      permissionPreset: {
        readPaths: ["**"],
        writePaths: ["../escape"],
        shell: "allowed",
        network: true,
        dangerousOpsRequireApproval: false as unknown as true,
      },
    });
    expectViolationFields(result, [
      "name",
      "systemPrompt",
      "permissionPreset.dangerousOpsRequireApproval",
      "permissionPreset.writePaths",
    ]);
  });
});

describe("CustomRoleValidationError（抛错通道封装，供宿主校验回调接线）", () => {
  it("携带全部违规，message 含字段名与违规数", () => {
    const result = validateCustomRoleDraft(draft({ name: "", systemPrompt: " " }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = new CustomRoleValidationError(result.violations);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CustomRoleValidationError");
    expect(error.violations).toEqual(result.violations);
    expect(error.message).toContain("name");
    expect(error.message).toContain("systemPrompt");
    expect(error.message).toContain("2 处违规");
  });
});
