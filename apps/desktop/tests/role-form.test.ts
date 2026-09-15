/**
 * T8.4 自定义角色表单纯逻辑单测：表单态 ↔ 线上草稿（校验权威在 core，本层只构形）。
 * T9.5：applyRoleTemplate 选模板覆盖 / 回空白清空。
 */

import {
  type CustomRole,
  type CustomRoleId,
  DEFAULT_PERMISSION_PRESET,
  type PermissionEnvelope,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  applyRoleTemplate,
  buildRoleDraft,
  emptyRoleForm,
  formFromRole,
} from "../src/renderer/src/pages/settings/roles/role-form";

const PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: ["docs/**"],
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
};

describe("emptyRoleForm", () => {
  it("空名称/提示词 + 注入的默认权限预设", () => {
    const form = emptyRoleForm(PRESET);
    expect(form.name).toBe("");
    expect(form.systemPrompt).toBe("");
    expect(form.permission).toEqual(PRESET);
  });
});

describe("buildRoleDraft", () => {
  it("name / systemPrompt 去首尾空白，权限预设原样进草稿", () => {
    const draft = buildRoleDraft({
      name: "  文档撰写者 ",
      systemPrompt: "\n你是文档撰写者。\n",
      permission: PRESET,
    });
    expect(draft).toEqual({
      name: "文档撰写者",
      systemPrompt: "你是文档撰写者。",
      permissionPreset: PRESET,
    });
  });
});

describe("applyRoleTemplate", () => {
  const template = {
    systemPrompt: "你是规划者。只读澄清，把想法收敛成可核对的计划。",
    permissionPreset: PRESET,
  };

  it("选模板覆盖 name / systemPrompt / permission", () => {
    const form = applyRoleTemplate(template, "规划者", DEFAULT_PERMISSION_PRESET);
    expect(form.name).toBe("规划者");
    expect(form.systemPrompt).toBe(template.systemPrompt);
    expect(form.permission).toBe(template.permissionPreset);
  });

  it("回空白清空为 emptyRoleForm(DEFAULT_PERMISSION_PRESET)", () => {
    const filled = applyRoleTemplate(template, "规划者", DEFAULT_PERMISSION_PRESET);
    expect(filled.systemPrompt.length).toBeGreaterThan(0);
    expect(applyRoleTemplate(null, "规划者", DEFAULT_PERMISSION_PRESET)).toEqual(
      emptyRoleForm(DEFAULT_PERMISSION_PRESET),
    );
  });
});

describe("formFromRole round-trip", () => {
  it("CustomRole → 表单 → 草稿 保持等价（去 id 与时间戳）", () => {
    const role: CustomRole = {
      id: "role-a1b2c3d4e5f6" as CustomRoleId,
      name: "文档撰写者",
      systemPrompt: "你是文档撰写者。",
      permissionPreset: PRESET,
      createdAt: 1,
      updatedAt: 2,
    };
    const draft = buildRoleDraft(formFromRole(role));
    expect(draft).toEqual({
      name: role.name,
      systemPrompt: role.systemPrompt,
      permissionPreset: role.permissionPreset,
    });
  });
});
