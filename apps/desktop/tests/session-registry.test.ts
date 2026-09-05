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
import {
  type AiderTurn,
  GENERIC_EXEC_TASK_DELIVERIES,
  OPENCODE_CLI_FALLBACK_CAPABILITIES,
  OPENCODE_SERVER_CAPABILITIES,
  type OpenCodeAdapter,
  type OpenCodeServer,
  type OpenCodeServerState,
  type OpenCodeServerStatus,
  TASK_PLACEHOLDER,
} from "@ff-pane/adapters";
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
  // opencode 自 T8.5c 起并入零配置裸键单例（server 惰性，注册即轻量闭包）
  it.each(["codex", "claude-code", "gemini-cli", "grok-build", "opencode"])(
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
    // qwen-code 归 T8.6a，当前确实未注册——恰作未注册样例（T8.5c 前此处用 opencode）
    const resolution = registry.resolveForProfile(profile({ runtime: "qwen-code" }));
    expect(resolution).toEqual({ ok: false, reason: "Runtime 未注册：qwen-code" });
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

  it("同 Profile 重复解析复用缓存实例", () => {
    const registry = makeRegistry();
    const p = profile({ runtime: "generic-exec", genericExec: GX });
    const first = registry.resolveForProfile(p);
    const second = registry.resolveForProfile(p);
    expect(first.ok && second.ok && first.adapter === second.adapter).toBe(true);
  });

  // T8.4b 验收 §2-2 补钉：指纹须收 GenericExecProfileConfig 全部三字段——任何一维
  // 单独变更都要触发重建，不得复用旧实例（反向自证过：registry.ts 指纹削掉
  // taskDelivery / args 时对应维恰红，已还原）。taskDelivery 维只改这一个字段
  // （argv 与 stdin 对 {task} 占位符的要求相斥，合法配置不可能只差该维），重建被
  // 触发的观察点是「构造期校验拒绝」——若指纹漏收 taskDelivery，会静默复用旧的
  // argv 实例（ok 且同实例），恰是要防的缺陷形态。
  it.each<[keyof GenericExecProfileConfig, Partial<GenericExecProfileConfig>, "重建" | "拒绝"]>([
    ["command", { command: "othertool" }, "重建"],
    ["args", { args: ["--run", "--verbose", "{task}"] }, "重建"],
    ["taskDelivery", { taskDelivery: "stdin" }, "拒绝"],
  ])("配置变更按指纹重建：改 %s 不复用旧实例（观察点：%s）", (_dimension, patch, outcome) => {
    const registry = makeRegistry();
    const first = registry.resolveForProfile(profile({ runtime: "generic-exec", genericExec: GX }));
    expect(first.ok).toBe(true);
    const changed = registry.resolveForProfile(
      profile({ runtime: "generic-exec", genericExec: { ...GX, ...patch } }),
    );
    if (outcome === "重建") {
      expect(changed.ok).toBe(true);
      if (first.ok && changed.ok) {
        expect(changed.adapter).not.toBe(first.adapter);
      }
      return;
    }
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.reason).toContain("generic-exec 配置非法");
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

describe("OpenCode 注册接入（T8.5c：裸键单例 + 进程级共享 server 惰性 + 退出收敛）", () => {
  it("注册即就绪但 server 惰性：注册后 server 状态为 stopped（零 spawn）", () => {
    const registry = makeRegistry();
    const adapter = registry.get("opencode") as OpenCodeAdapter | undefined;
    expect(adapter).toBeDefined();
    // 惰性合同：createDesktopAdapterRegistry 不触发 ensureReady，serve 进程不存在
    expect(adapter?.server.status().state).toBe("stopped");
    expect(adapter?.server.status().pid).toBeUndefined();
  });

  it("能力声明选路：注册的是 Server 路径六项全 yes（CLI 降级声明不被采用）", () => {
    const registry = makeRegistry();
    const adapter = registry.get("opencode");
    expect(adapter?.capabilities()).toEqual(OPENCODE_SERVER_CAPABILITIES);
    expect(adapter?.capabilities()).not.toEqual(OPENCODE_CLI_FALLBACK_CAPABILITIES);
  });

  it("hasRuntimeResources：server 从未起过 → false；closeRuntimes 幂等且置 closed", async () => {
    const registry = makeRegistry();
    expect(registry.hasRuntimeResources()).toBe(false);
    await registry.closeRuntimes();
    await registry.closeRuntimes(); // 幂等
    const adapter = registry.get("opencode") as OpenCodeAdapter;
    expect(adapter.server.status().state).toBe("closed");
    // closed 也是「无需关停」——退出路径不会为一个已收尾的 server 拦截退出
    expect(registry.hasRuntimeResources()).toBe(false);
  });

  it("hasRuntimeResources：以替身注入观察 ready / crashed 均判定需要关停", async () => {
    const states: OpenCodeServerState[] = [];
    let closes = 0;
    function stubAdapter(state: () => OpenCodeServerState): OpenCodeAdapter {
      const server: OpenCodeServer = {
        status: () =>
          ({
            state: state(),
            activeTurns: 0,
            restarts: 0,
            strippedEnvNames: [],
            recentOutput: [],
          }) as OpenCodeServerStatus,
        ensureReady: () => Promise.reject(new Error("stub")),
        acquire: () => undefined,
        release: () => undefined,
        restart: () => Promise.reject(new Error("stub")),
        close: async () => {
          closes += 1;
        },
      };
      return {
        runtime: "opencode",
        displayName: "stub",
        capabilities: () => OPENCODE_SERVER_CAPABILITIES,
        startTurn: () => {
          throw new Error("stub");
        },
        server,
        close: () => server.close(),
      };
    }
    let current: OpenCodeServerState = "ready";
    const registry = createDesktopAdapterRegistry({
      agentSessionsDir: SESSIONS_DIR,
      openCodeAdapter: stubAdapter(() => current),
    });
    for (const state of ["starting", "ready", "crashed"] as const) {
      current = state;
      states.push(state);
      expect(registry.hasRuntimeResources()).toBe(true);
    }
    for (const state of ["stopped", "closed"] as const) {
      current = state;
      expect(registry.hasRuntimeResources()).toBe(false);
    }
    await registry.closeRuntimes();
    expect(closes).toBe(1);
    expect(states).toHaveLength(3);
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
