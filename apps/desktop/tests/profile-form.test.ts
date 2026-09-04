import type { AgentProfile, PermissionEnvelope } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildProfileDraft,
  emptyProfileForm,
  formFromProfile,
  type ProfileFormState,
  parseGenericExecArgs,
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

  it("非 generic-exec：genericExec 不进草稿（即使表单留有残值）", () => {
    const draft = buildProfileDraft(
      form({ name: "P", runtime: "codex", providerId: "provider-x", gxCommand: "leftover" }),
    );
    expect("genericExec" in draft).toBe(false);
  });

  it("generic-exec：命令去空白、参数按行拆分、投递方式随表单（T8.4b）", () => {
    const draft = buildProfileDraft(
      form({
        name: "回声",
        runtime: "generic-exec",
        providerId: "provider-x",
        gxCommand: " node ",
        gxArgs: "-e\nconsole.log(1)\n\n  {task}  \n",
        gxDelivery: "argv",
      }),
    );
    expect(draft.genericExec).toEqual({
      command: "node",
      args: ["-e", "console.log(1)", "{task}"],
      taskDelivery: "argv",
    });
  });
});

describe("parseGenericExecArgs", () => {
  it("按行拆分、去首尾空白、丢弃空行；CRLF 同样处理", () => {
    expect(parseGenericExecArgs("a\r\n  b  \r\n\r\nc\n")).toEqual(["a", "b", "c"]);
    expect(parseGenericExecArgs("")).toEqual([]);
    expect(parseGenericExecArgs("  \n \n")).toEqual([]);
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

  it("generic-exec Profile（含命令配置）round-trip（T8.4b）", () => {
    const profile = {
      id: "profile-3",
      name: "回声工具",
      runtime: "generic-exec",
      providerId: "provider-1",
      defaultRole: "worker",
      permissionPreset: PRESET,
      genericExec: { command: "node", args: ["-e", "{task}"], taskDelivery: "argv" },
    } as unknown as AgentProfile;
    const draft = buildProfileDraft(formFromProfile(profile));
    const { id: _id, ...rest } = profile;
    expect(draft).toEqual(rest);
  });

  it("自定义角色 ID 作为 defaultRole 同样 round-trip（T8.4）", () => {
    const profile = {
      id: "profile-2",
      name: "文档 Agent",
      runtime: "codex",
      providerId: "provider-1",
      defaultRole: "role-a1b2c3d4e5f6",
      permissionPreset: PRESET,
    } as AgentProfile;
    const form = formFromProfile(profile);
    expect(form.defaultRole).toBe("role-a1b2c3d4e5f6");
    const draft = buildProfileDraft(form);
    expect(draft.defaultRole).toBe("role-a1b2c3d4e5f6");
  });
});
