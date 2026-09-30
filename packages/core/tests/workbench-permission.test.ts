/**
 * T10.5：权限映射表快照 + canDelegate / authorize 穷举 + 令牌注册表。
 */

import type { WorkbenchPermissionLevel } from "@ff-pane/shared";
import { WORKBENCH_PERMISSION_LEVELS } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  applyPermissionDowngrade,
  authorize,
  authorizeOpenChild,
  canDelegate,
  createWindowTokenRegistry,
  FF_PANE_WB_PIPE_ENV,
  FF_PANE_WB_PIPE_ENV_PLACEHOLDER,
  FF_PANE_WINDOW_TOKEN_ENV,
  FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER,
  generateWindowToken,
  getPermissionMapping,
  injectTokenIntoMcpServers,
  isDescendantOf,
  MAX_ANCESTOR_WALK_DEPTH,
  markChildrenParentClosed,
  resolveCaller,
  resolveLaunchPermission,
  resolvePermissionCliArgs,
  sanitizeWorkbenchAuthTree,
  WORKBENCH_PERMISSION_MAPPINGS,
  type WorkbenchAuthNode,
  walkAncestors,
} from "../src/workbench-permission/index.js";

describe("WORKBENCH_PERMISSION_MAPPINGS snapshots", () => {
  const clis = ["claude-code", "codex"] as const;
  const modes = [false, true] as const;

  for (const cli of clis) {
    for (const level of WORKBENCH_PERMISSION_LEVELS) {
      for (const resume of modes) {
        it(`${cli} × ${level} × ${resume ? "resume" : "fresh"}`, () => {
          expect(resolvePermissionCliArgs({ cli, level, resume })).toMatchSnapshot();
          expect(getPermissionMapping(cli, level).level).toBe(level);
        });
      }
    }
  }

  it("表穷尽 4×2", () => {
    expect(WORKBENCH_PERMISSION_MAPPINGS).toHaveLength(8);
  });
});

function node(
  id: string,
  permission: WorkbenchPermissionLevel,
  parentWindowId?: string,
  extras: Partial<WorkbenchAuthNode> = {},
): WorkbenchAuthNode {
  return {
    id,
    permission,
    openedBy: parentWindowId !== undefined ? { windowId: parentWindowId } : "user",
    ...(parentWindowId !== undefined ? { parentWindowId } : {}),
    ...extras,
  };
}

/** 树：user→M(edit-exec)→W(edit)→G(read-only)；旁支 S 与 W 同父。 */
function sampleTree(): Record<string, WorkbenchAuthNode> {
  return {
    M: node("M", "edit-exec"),
    W: node("W", "edit", "M"),
    G: node("G", "read-only", "W"),
    S: node("S", "edit", "M"),
    X: node("X", "yolo"),
  };
}

describe("canDelegate", () => {
  it("子 ≤ 父", () => {
    expect(canDelegate("edit", "read-only")).toBe(true);
    expect(canDelegate("edit", "edit")).toBe(true);
    expect(canDelegate("edit", "edit-exec")).toBe(false);
    expect(canDelegate("yolo", "edit-exec")).toBe(true);
  });
});

describe("authorize 穷举", () => {
  const tree = sampleTree();

  it("用户可对任意窗口控制/调权", () => {
    expect(
      authorize({
        actor: { kind: "user" },
        action: "adjust-permission",
        targetWindowId: "X",
        newPermission: "yolo",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "user" },
        action: "close",
        targetWindowId: "G",
        tree,
      }).ok,
    ).toBe(true);
  });

  it("自己：可关自己；不可调自己权；不可对自己发控制指令", () => {
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "close",
        targetWindowId: "W",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "adjust-permission",
        targetWindowId: "W",
        newPermission: "read-only",
        tree,
      }),
    ).toEqual({ ok: false, reason: "cannot-adjust-self" });
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "send-command",
        targetWindowId: "W",
        tree,
      }).ok,
    ).toBe(false);
  });

  it("父/祖先：仅 report；控制拒绝", () => {
    expect(
      authorize({
        actor: { kind: "window", windowId: "G" },
        action: "report",
        targetWindowId: "W",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "G" },
        action: "report",
        targetWindowId: "M",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "G" },
        action: "close",
        targetWindowId: "M",
        tree,
      }).ok,
    ).toBe(false);
    expect(
      authorize({
        actor: { kind: "window", windowId: "G" },
        action: "adjust-permission",
        targetWindowId: "M",
        newPermission: "read-only",
        tree,
      }),
    ).toEqual({ ok: false, reason: "cannot-adjust-ancestor" });
  });

  it("子/孙：控制与调权（不越级）允许", () => {
    expect(isDescendantOf("M", "G", tree)).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "M" },
        action: "read-output",
        targetWindowId: "G",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "M" },
        action: "adjust-permission",
        targetWindowId: "W",
        newPermission: "edit",
        tree,
      }).ok,
    ).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "M" },
        action: "adjust-permission",
        targetWindowId: "W",
        newPermission: "yolo",
        tree,
      }),
    ).toEqual({ ok: false, reason: "exceeds-caller-ceiling" });
  });

  it("兄弟 / 无关：默认拒绝", () => {
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "send-message",
        targetWindowId: "S",
        tree,
      }),
    ).toEqual({ ok: false, reason: "sibling-message-denied" });
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "close",
        targetWindowId: "X",
        tree,
      }).ok,
    ).toBe(false);
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "send-message",
        targetWindowId: "X",
        tree,
      }),
    ).toEqual({ ok: false, reason: "unrelated-denied" });
  });

  it("已关闭父级：仍可按 parentWindowId report", () => {
    const closed: Record<string, WorkbenchAuthNode> = {
      W: node("W", "edit", "M", { parentClosed: true }),
      G: node("G", "read-only", "W"),
    };
    expect(
      authorize({
        actor: { kind: "window", windowId: "W" },
        action: "report",
        targetWindowId: "M",
        tree: closed,
      }).ok,
    ).toBe(true);
  });

  it("open-child 封顶", () => {
    expect(
      authorizeOpenChild({
        actor: { kind: "window", windowId: "W" },
        parentWindowId: "W",
        childPermission: "edit-exec",
        tree,
      }),
    ).toEqual({ ok: false, reason: "exceeds-parent-ceiling" });
    expect(
      authorizeOpenChild({
        actor: { kind: "window", windowId: "W" },
        parentWindowId: "W",
        childPermission: "read-only",
        tree,
      }).ok,
    ).toBe(true);
  });

  it("降级后代标记需重启", () => {
    const next = applyPermissionDowngrade(tree, "M", "read-only");
    expect(next["M"]?.permission).toBe("read-only");
    expect(next["W"]?.permission).toBe("read-only");
    expect(next["W"]?.permissionNeedsDowngrade).toBe(true);
    expect(next["G"]?.permissionNeedsDowngrade).toBe(false);
  });

  it("关闭父级保留子并标记 parentClosed", () => {
    const next = markChildrenParentClosed(tree, "M");
    expect(next["M"]).toBeUndefined();
    expect(next["W"]?.parentClosed).toBe(true);
    expect(next["S"]?.parentClosed).toBe(true);
    expect(next["W"]?.parentWindowId).toBe("M");
  });
});

describe("window token registry", () => {
  it("签发 ≥32 字节、resolveCaller、吊销", () => {
    const registry = createWindowTokenRegistry();
    const token = registry.issue("win-1");
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(resolveCaller(registry, token)).toBe("win-1");
    registry.revoke("win-1");
    expect(resolveCaller(registry, token)).toBeNull();
  });

  it("generateWindowToken 拒绝过短", () => {
    expect(() => generateWindowToken(16)).toThrow(/32/);
  });

  it("Claude MCP 环境变量展开占位符；Codex 仅 env_vars 名；令牌明文不进配置", () => {
    const token = "a".repeat(64);
    const claude = injectTokenIntoMcpServers(
      { k: { command: "node", env: { A: "1" } } },
      token,
      "claude-env-expand",
    );
    expect(claude["k"]?.env?.[FF_PANE_WINDOW_TOKEN_ENV]).toBe(FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER);
    expect(claude["k"]?.env?.[FF_PANE_WB_PIPE_ENV]).toBe(FF_PANE_WB_PIPE_ENV_PLACEHOLDER);
    expect(JSON.stringify(claude)).not.toContain(token);

    const codex = injectTokenIntoMcpServers(
      { k: { command: "node", env: { A: "1" } } },
      token,
      "codex-forward",
    );
    expect(codex["k"]?.env?.[FF_PANE_WINDOW_TOKEN_ENV]).toBeUndefined();
    expect(codex["k"]?.env?.[FF_PANE_WB_PIPE_ENV]).toBeUndefined();
    expect(codex["k"]?.envVars).toContain(FF_PANE_WINDOW_TOKEN_ENV);
    expect(codex["k"]?.envVars).toContain(FF_PANE_WB_PIPE_ENV);
    expect(JSON.stringify(codex)).not.toContain(token);
  });
});

describe("authorize 环 / 自环 / 超深", () => {
  it("双向环：控制动作双向拒绝", () => {
    const cyclic: Record<string, WorkbenchAuthNode> = {
      A: node("A", "edit-exec", "B"),
      B: node("B", "edit", "A"),
    };
    expect(
      authorize({
        actor: { kind: "window", windowId: "A" },
        action: "close",
        targetWindowId: "B",
        tree: cyclic,
      }),
    ).toEqual({ ok: false, reason: "cycle-detected" });
    expect(
      authorize({
        actor: { kind: "window", windowId: "B" },
        action: "adjust-permission",
        targetWindowId: "A",
        newPermission: "read-only",
        tree: cyclic,
      }),
    ).toEqual({ ok: false, reason: "cycle-detected" });
  });

  it("自环拒绝", () => {
    const self: Record<string, WorkbenchAuthNode> = {
      A: node("A", "edit", "A"),
      B: node("B", "read-only", "A"),
    };
    expect(walkAncestors("A", self).cycle).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: "A" },
        action: "close",
        targetWindowId: "B",
        tree: self,
      }),
    ).toEqual({ ok: false, reason: "cycle-detected" });
  });

  it("超深祖先链拒绝", () => {
    const deep: Record<string, WorkbenchAuthNode> = {};
    const depth = MAX_ANCESTOR_WALK_DEPTH + 2;
    for (let i = 0; i < depth; i += 1) {
      const id = `n${i}`;
      const parent = i === 0 ? undefined : `n${i - 1}`;
      deep[id] = node(id, "edit", parent);
    }
    const leaf = `n${depth - 1}`;
    expect(walkAncestors(leaf, deep).truncated).toBe(true);
    expect(
      authorize({
        actor: { kind: "window", windowId: leaf },
        action: "close",
        targetWindowId: "n0",
        tree: deep,
      }),
    ).toEqual({ ok: false, reason: "ancestry-too-deep" });
  });
});

describe("sanitizeWorkbenchAuthTree / resolveLaunchPermission", () => {
  it("环断开并降为 read-only", () => {
    const cyclic: Record<string, WorkbenchAuthNode> = {
      A: node("A", "yolo", "B"),
      B: node("B", "edit-exec", "A"),
    };
    const result = sanitizeWorkbenchAuthTree(cyclic);
    expect(result.brokenCycleIds.length).toBeGreaterThan(0);
    for (const id of result.brokenCycleIds) {
      expect(result.windows[id]?.parentWindowId).toBeUndefined();
      expect(result.windows[id]?.permission).toBe("read-only");
      expect(result.windows[id]?.parentClosed).toBe(true);
    }
  });

  it("子高于父则封顶", () => {
    const tree: Record<string, WorkbenchAuthNode> = {
      P: node("P", "edit"),
      C: node("C", "yolo", "P"),
    };
    const result = sanitizeWorkbenchAuthTree(tree);
    expect(result.windows["C"]?.permission).toBe("edit");
    expect(result.cappedIds).toContain("C");
  });

  it("启动：有父则 min(请求, 祖先上限)；顶层按请求", () => {
    const tree: Record<string, WorkbenchAuthNode> = {
      P: node("P", "edit"),
      C: node("C", "edit", "P"),
    };
    expect(resolveLaunchPermission({ windowId: "C", requested: "yolo", tree }).effective).toBe(
      "edit",
    );
    expect(resolveLaunchPermission({ windowId: "C", requested: "yolo", tree }).capped).toBe(true);
    expect(resolveLaunchPermission({ windowId: "P", requested: "yolo", tree }).effective).toBe(
      "yolo",
    );
    expect(resolveLaunchPermission({ windowId: "P", requested: "yolo", tree }).capped).toBe(false);
  });

  it("伪造父级（缺失节点）不抬权：按自身登记", () => {
    const tree: Record<string, WorkbenchAuthNode> = {
      C: node("C", "edit", "ghost-parent"),
    };
    const launch = resolveLaunchPermission({ windowId: "C", requested: "yolo", tree });
    // 有 parentWindowId 字段 → 走封顶路径；父缺失时 ceiling=自身 edit
    expect(launch.effective).toBe("edit");
    expect(launch.capped).toBe(true);
  });
});
