/**
 * T9.5 角色模板预填：5 套编译期常量的校验、去合同化、权限接缝。
 */

import { describe, expect, it } from "vitest";
import {
  getRoleTemplate,
  ROLE_DEFAULT_ENVELOPES,
  ROLE_DEFINITIONS,
  ROLE_TEMPLATE_IDS,
  ROLE_TEMPLATES,
  type RoleTemplateId,
  validateCustomRoleDraft,
} from "../src/index.js";

const CONTRACT_BANNED_TERMS = [
  "工作合同",
  "任务合同",
  "write_scope",
  "verify_cmd",
  "结构化澄清请求",
  "权限层拦截",
  "批准计划",
  "派发任务",
] as const;

const BUILTIN_TEMPLATE_IDS = [
  "planner",
  "worker",
  "reviewer",
] as const satisfies readonly RoleTemplateId[];

describe("ROLE_TEMPLATE_IDS / ROLE_TEMPLATES", () => {
  it("5 套稳定 id 齐全，且每套 id 与表项一致", () => {
    expect([...ROLE_TEMPLATE_IDS]).toEqual([
      "planner",
      "worker",
      "reviewer",
      "docs-writer",
      "test-engineer",
    ]);
    for (const id of ROLE_TEMPLATE_IDS) {
      expect(getRoleTemplate(id).id).toBe(id);
      expect(ROLE_TEMPLATES[id]?.id).toBe(id);
    }
  });
});

describe("5 套模板各过 validateCustomRoleDraft + 去合同化 + 不复制内置第 1 层", () => {
  it.each(ROLE_TEMPLATE_IDS)("%s：名称非空草稿通过、禁词不出现、与 ROLE_DEFINITIONS 不等", (id) => {
    const template = getRoleTemplate(id);
    expect(
      validateCustomRoleDraft({
        name: "非空",
        systemPrompt: template.systemPrompt,
        permissionPreset: template.permissionPreset,
      }),
    ).toEqual({ ok: true });

    for (const term of CONTRACT_BANNED_TERMS) {
      expect(template.systemPrompt.includes(term), `${id} 含禁词 ${term}`).toBe(false);
    }

    for (const builtin of ["planner", "worker", "reviewer"] as const) {
      expect(template.systemPrompt).not.toBe(ROLE_DEFINITIONS[builtin]);
    }
  });
});

describe("权限快照接缝", () => {
  it.each(BUILTIN_TEMPLATE_IDS)("%s 复用 ROLE_DEFAULT_ENVELOPES 同一对象", (id) => {
    expect(getRoleTemplate(id).permissionPreset).toBe(ROLE_DEFAULT_ENVELOPES[id]);
  });

  it("docs-writer：read ** / write docs/** / shell forbidden / network false / dangerous true", () => {
    expect(getRoleTemplate("docs-writer").permissionPreset).toEqual({
      readPaths: ["**"],
      writePaths: ["docs/**"],
      shell: "forbidden",
      network: false,
      dangerousOpsRequireApproval: true,
    });
  });

  it("test-engineer：read ** / write tests/** / shell allowed / network false / dangerous true", () => {
    expect(getRoleTemplate("test-engineer").permissionPreset).toEqual({
      readPaths: ["**"],
      writePaths: ["tests/**"],
      shell: "allowed",
      network: false,
      dangerousOpsRequireApproval: true,
    });
  });
});
