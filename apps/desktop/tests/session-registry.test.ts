/**
 * T8.4b 多实例装配单测：createDesktopAdapterRegistry 的按 Profile 解析。
 *
 * 钉住四件事：
 * 1. 零配置 runtime（codex / claude-code / gemini-cli / grok-build）经
 *    resolveForProfile 拿到的就是裸键单例本身（实例同一性）——复合键装配对它们
 *    逐字不变；
 * 2. generic-exec 按 Profile 实例化：同 Profile 复用缓存、配置变更按指纹重建、
 *    不同 Profile 各持实例；配置缺失 / 非法给人可读拒绝（不再是「Runtime 未注册」）；
 * 3. aider 按 Profile 注入 tempDir = <agentSessionsDir>/<profileId>（经 AiderTurn
 *    的 sessionFile 路径观察）；
 * 4. shared 镜像常量与 adapters 权威值一致（GENERIC_EXEC_DELIVERIES /
 *    GENERIC_EXEC_TASK_PLACEHOLDER，见 shared/domain/profile.ts 注释的钉住承诺）。
 */

import { sep } from "node:path";
import { type AiderTurn, GENERIC_EXEC_TASK_DELIVERIES, TASK_PLACEHOLDER } from "@ff-pane/adapters";
import type { AgentProfile, GenericExecProfileConfig, ProfileId } from "@ff-pane/shared";
import { GENERIC_EXEC_DELIVERIES, GENERIC_EXEC_TASK_PLACEHOLDER } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { createDesktopAdapterRegistry } from "../src/main/session/registry";

const SESSIONS_DIR = ["C:", "fake-root", "agent-sessions"].join(sep);

function makeRegistry() {
  return createDesktopAdapterRegistry({ agentSessionsDir: SESSIONS_DIR });
}

function profile(overrides: Partial<Record<keyof AgentProfile, unknown>>): AgentProfile {
  return {
    id: "profile-aaa111" as ProfileId,
    name: "P",
    runtime: "codex",
    providerId: "prov-1",
    defaultRole: "worker",
    permissionPreset: {
      readPaths: ["**"],
      writePaths: [],
      shell: "forbidden",
      network: false,
      dangerousOpsRequireApproval: true,
    },
    ...overrides,
  } as unknown as AgentProfile;
}

const GX: GenericExecProfileConfig = {
  command: "mytool",
  args: ["--run", "{task}"],
  taskDelivery: "argv",
};

describe("零配置 runtime：裸键单例逐字不变", () => {
  it.each(["codex", "claude-code", "gemini-cli", "grok-build"])(
    "%s：resolveForProfile 返回 registry.get 的同一实例",
    (runtime) => {
      const registry = makeRegistry();
      const resolution = registry.resolveForProfile(profile({ runtime }));
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        expect(resolution.adapter).toBe(registry.get(runtime));
      }
    },
  );

  it("未注册 runtime：拒绝文案与既有「Runtime 未注册」一致", () => {
    const registry = makeRegistry();
    const resolution = registry.resolveForProfile(profile({ runtime: "opencode" }));
    expect(resolution).toEqual({ ok: false, reason: "Runtime 未注册：opencode" });
  });
});

describe("generic-exec 按 Profile 实例化（复合键 <runtime>@<profileId>）", () => {
  it("带合法配置：解析成功，displayName 取 Profile 名，裸键仍未注册", () => {
    const registry = makeRegistry();
    const resolution = registry.resolveForProfile(
      profile({ runtime: "generic-exec", name: "回声工具", genericExec: GX }),
    );
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.adapter.runtime).toBe("generic-exec");
      expect(resolution.adapter.displayName).toBe("回声工具");
    }
    // 复合键是注册表内部寻址：裸键 get / list 不受污染
    expect(registry.get("generic-exec")).toBeUndefined();
    expect(registry.list().map((a) => a.runtime)).not.toContain("generic-exec");
  });

  it("同 Profile 重复解析复用缓存实例；配置变更按指纹重建", () => {
    const registry = makeRegistry();
    const p = profile({ runtime: "generic-exec", genericExec: GX });
    const first = registry.resolveForProfile(p);
    const second = registry.resolveForProfile(p);
    expect(first.ok && second.ok && first.adapter === second.adapter).toBe(true);

    const updated = profile({
      runtime: "generic-exec",
      genericExec: { ...GX, command: "othertool" },
    });
    const third = registry.resolveForProfile(updated);
    expect(third.ok).toBe(true);
    if (first.ok && third.ok) {
      expect(third.adapter).not.toBe(first.adapter);
    }
  });

  it("两个 Profile 各持实例（复合键按 profileId 隔离）", () => {
    const registry = makeRegistry();
    const a = registry.resolveForProfile(
      profile({ id: "profile-aaa111", runtime: "generic-exec", genericExec: GX }),
    );
    const b = registry.resolveForProfile(
      profile({ id: "profile-bbb222", runtime: "generic-exec", genericExec: GX }),
    );
    expect(a.ok && b.ok && a.adapter !== b.adapter).toBe(true);
  });

  it("配置缺失（旁路写入）：人可读拒绝，指向设置页修复入口", () => {
    const registry = makeRegistry();
    const resolution = registry.resolveForProfile(
      profile({ runtime: "generic-exec", name: "残缺配置" }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain("残缺配置");
      expect(resolution.reason).toContain("设置页");
      expect(resolution.reason).not.toContain("Runtime 未注册");
    }
  });

  it("配置非法（旁路写入，argv 模式无占位符）：GenericExecConfigError 概要作为拒绝原因", () => {
    const registry = makeRegistry();
    const resolution = registry.resolveForProfile(
      profile({
        runtime: "generic-exec",
        genericExec: { command: "mytool", args: [], taskDelivery: "argv" },
      }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain("generic-exec 配置非法");
    }
  });
});

describe("aider 按 Profile 注入 tempDir（候选②，T8.2b-a 登记的 transcript 出 tmpdir）", () => {
  it("transcript 会话目录落 <agentSessionsDir>/<profileId>/ 之下", () => {
    const registry = makeRegistry();
    const resolution = registry.resolveForProfile(
      profile({ id: "profile-aid001", runtime: "aider" }),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    // 缺 model 的 startTurn 走 fail-fast（不 spawn 进程），但 sessionFile 已按
    // tempDir 派生——这正是要钉的观察点：<agentSessionsDir>/<profileId>/…/chat-history.md
    const turn = resolution.adapter.startTurn({ cwd: "C:\\proj", prompt: "hi" }) as AiderTurn;
    expect(turn.sessionFile.startsWith([SESSIONS_DIR, "profile-aid001"].join(sep) + sep)).toBe(
      true,
    );
    expect(turn.sessionFile.endsWith("chat-history.md")).toBe(true);
  });

  it("同 Profile 复用实例；不同 Profile 的 tempDir 互相隔离", () => {
    const registry = makeRegistry();
    const p = profile({ id: "profile-aid001", runtime: "aider" });
    const first = registry.resolveForProfile(p);
    const second = registry.resolveForProfile(p);
    expect(first.ok && second.ok && first.adapter === second.adapter).toBe(true);

    const other = registry.resolveForProfile(profile({ id: "profile-aid002", runtime: "aider" }));
    expect(other.ok).toBe(true);
    if (!other.ok) {
      return;
    }
    const turn = other.adapter.startTurn({ cwd: "C:\\proj", prompt: "hi" }) as AiderTurn;
    expect(turn.sessionFile).toContain(`${sep}profile-aid002${sep}`);
  });

  it("裸键 aider 单例仍注册（registry.get 既有行为不变）", () => {
    const registry = makeRegistry();
    expect(registry.get("aider")).toBeDefined();
  });
});

describe("shared 镜像常量与 adapters 权威值一致（shared/domain/profile.ts 的钉住承诺）", () => {
  it("投递方式字面量集合一致", () => {
    expect([...GENERIC_EXEC_DELIVERIES]).toEqual([...GENERIC_EXEC_TASK_DELIVERIES]);
  });

  it("任务占位符一致", () => {
    expect(GENERIC_EXEC_TASK_PLACEHOLDER).toBe(TASK_PLACEHOLDER);
  });
});
