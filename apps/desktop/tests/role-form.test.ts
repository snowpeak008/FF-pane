/**
 * T8.4 自定义角色表单纯逻辑单测：表单态 ↔ 线上草稿（校验权威在 core，本层只构形）。
 */

import type { CustomRole, CustomRoleId, PermissionEnvelope } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
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
