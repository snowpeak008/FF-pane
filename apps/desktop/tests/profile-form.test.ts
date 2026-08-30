import type { AgentProfile, PermissionEnvelope } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildProfileDraft,
  emptyProfileForm,
  formFromProfile,
  type ProfileFormState,
} from "../src/renderer/src/pages/settings/profiles/profile-form";

const PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
};

describe("emptyProfileForm", () => {
  it("默认 worker 角色 + 注入的权限预设", () => {
    const form = emptyProfileForm(PRESET);
    expect(form.defaultRole).toBe("worker");
    expect(form.permission).toEqual(PRESET);
    expect(form.model).toBe("");
  });
});

describe("buildProfileDraft", () => {
  function form(overrides: Partial<ProfileFormState>): ProfileFormState {
    return { ...emptyProfileForm(PRESET), ...overrides };
  }

  it("完整：带 model 与 outputLanguage", () => {
    const draft = buildProfileDraft(
      form({
        name: "  Claude 执行者 ",
        runtime: "claude-code",
        providerId: "provider-abc",
        model: " claude-sonnet ",
        defaultRole: "worker",
        outputLanguage: "zh-CN",
      }),
    );
    expect(draft).toEqual({
      name: "Claude 执行者",
      runtime: "claude-code",
      providerId: "provider-abc",
      model: "claude-sonnet",
      defaultRole: "worker",
      permissionPreset: PRESET,
      outputLanguage: "zh-CN",
    });
  });

  it("model / outputLanguage 空串则省略（缺省语义）", () => {
    const draft = buildProfileDraft(
      form({ name: "P", runtime: "codex", providerId: "provider-x" }),
    );
    expect("model" in draft).toBe(false);
    expect("outputLanguage" in draft).toBe(false);
  });
});

describe("formFromProfile round-trip", () => {
  it("Profile → 表单 → 草稿 保持等价（去 id）", () => {
    const profile = {
      id: "profile-1",
      name: "P",
      runtime: "opencode",
      providerId: "provider-1",
      model: "m1",
      defaultRole: "planner",
      permissionPreset: PRESET,
      outputLanguage: "en-US",
    } as AgentProfile;
    const draft = buildProfileDraft(formFromProfile(profile));
    const { id: _id, ...rest } = profile;
    expect(draft).toEqual(rest);
  });
});
