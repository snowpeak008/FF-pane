import type { WorkbenchAuthNode } from "@ff-pane/core";
import type { WorkbenchRole } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
} from "../src/main/workbench/cli-args";
import {
  canSetModelEffort,
  createModelEffortController,
  decideModelEffort,
  MODEL_EFFORT_AUTO_MESSAGE,
  MODEL_EFFORT_CONFIRM_MESSAGE,
  MODEL_EFFORT_DEFERRED_MESSAGE,
  parseModelEffortArgs,
  withModelEffortOverrides,
} from "../src/main/workbench/model-effort";

function node(id: string, role: WorkbenchRole, parentId?: string): WorkbenchAuthNode {
  return {
    id,
    permission: role === "manager" && parentId === undefined ? "edit" : "edit",
    openedBy: parentId === undefined ? "user" : { windowId: parentId },
    role,
    ...(parentId !== undefined ? { parentWindowId: parentId } : {}),
  };
}

function tree(): Record<string, WorkbenchAuthNode> {
  return {
    mgr: node("mgr", "manager"),
    plan: node("plan", "planner", "mgr"),
    work: node("work", "worker", "plan"),
    review: node("review", "reviewer", "mgr"),
    watch: node("watch", "supervisor", "mgr"),
    plain: node("plain", "none", "mgr"),
    other: node("other", "manager", "mgr"),
    stranger: node("stranger", "worker"),
    worker: node("worker", "worker", "mgr"),
  };
}

describe("canSetModelEffort", () => {
  const nodes = tree();

  it("管理者可以改自己和后代里的写计划、执行、监管者、检查、普通窗口", () => {
    for (const targetId of ["mgr", "plan", "work", "review", "watch", "plain"] as const) {
      const allowed = canSetModelEffort({
        callerId: "mgr",
        callerGranted: true,
        targetId,
        targetRole: nodes[targetId]?.role ?? "none",
        tree: nodes,
      });
      expect(allowed.ok, targetId).toBe(true);
    }
  });

  it("不能改别的管理者，非管理者不能改别人，也不能改无关窗口", () => {
    expect(
      canSetModelEffort({
        callerId: "mgr",
        callerGranted: true,
        targetId: "other",
        targetRole: "manager",
        tree: nodes,
      }).ok,
    ).toBe(false);
    expect(
      canSetModelEffort({
        callerId: "worker",
        callerGranted: false,
        targetId: "work",
        targetRole: "worker",
        tree: nodes,
      }).ok,
    ).toBe(false);
    expect(
      canSetModelEffort({
        callerId: "worker",
        callerGranted: false,
        targetId: "worker",
        targetRole: "worker",
        tree: nodes,
      }).ok,
    ).toBe(false);
    expect(
      canSetModelEffort({
        callerId: "mgr",
        callerGranted: true,
        targetId: "stranger",
        targetRole: "worker",
        tree: nodes,
      }).ok,
    ).toBe(false);
  });
});

describe("parseModelEffortArgs", () => {
  it("拒绝空白、换行、超长和档位以外的强度", () => {
    expect(parseModelEffortArgs({ model: undefined, reasoningEffort: undefined }).ok).toBe(false);
    expect(parseModelEffortArgs({ model: " \n ", reasoningEffort: undefined }).ok).toBe(false);
    expect(parseModelEffortArgs({ model: "a".repeat(200), reasoningEffort: undefined }).ok).toBe(
      false,
    );
    expect(parseModelEffortArgs({ model: "drop table", reasoningEffort: "high" }).ok).toBe(false);
    expect(parseModelEffortArgs({ model: undefined, reasoningEffort: "ultra" }).ok).toBe(false);
    expect(parseModelEffortArgs({ model: undefined, reasoningEffort: "high\nlow" }).ok).toBe(false);
  });

  it("接受白名单里的模型和档位", () => {
    const parsed = parseModelEffortArgs({ model: " opus ", reasoningEffort: " high " });
    expect(parsed).toEqual({ ok: true, model: "opus", reasoningEffort: "high" });
  });
});

describe("withModelEffortOverrides", () => {
  it("覆盖优先，没有覆盖就用配置，都没有就不传", () => {
    const both = withModelEffortOverrides(
      { model: "sonnet", reasoningEffort: "low" },
      { modelOverride: "opus", effortOverride: "high" },
    );
    expect(both).toEqual({ model: "opus", reasoningEffort: "high" });
    const claude = buildInteractiveClaudeArgs({
      ...(both.model !== undefined ? { model: both.model } : {}),
      ...(both.reasoningEffort !== undefined ? { effort: both.reasoningEffort } : {}),
      resumeSessionId: "sess-1",
      permission: "edit",
    });
    expect(claude).toEqual(
      expect.arrayContaining(["--resume", "sess-1", "--model", "opus", "--effort", "high"]),
    );
    expect(claude.join(" ")).not.toContain("drop table");

    const configOnly = withModelEffortOverrides({ model: "sonnet", reasoningEffort: "medium" }, {});
    expect(configOnly).toEqual({ model: "sonnet", reasoningEffort: "medium" });

    const effortOnly = withModelEffortOverrides(
      { model: "sonnet", reasoningEffort: "low" },
      { effortOverride: "xhigh" },
    );
    expect(effortOnly).toEqual({ model: "sonnet", reasoningEffort: "xhigh" });

    const none = withModelEffortOverrides({}, {});
    const bare = buildInteractiveClaudeArgs({
      ...(none.model !== undefined ? { model: none.model } : {}),
      ...(none.reasoningEffort !== undefined ? { effort: none.reasoningEffort } : {}),
      sessionId: "sess-2",
      permission: "edit",
    });
    expect(bare).not.toContain("--model");
    expect(bare).not.toContain("--effort");

    const codex = buildInteractiveCodexArgs({
      cwd: "C:\\proj",
      ...(both.model !== undefined ? { model: both.model } : {}),
      resume: true,
      resumeSessionId: "tid",
      permission: "edit",
      configOverrides: {
        ...(both.reasoningEffort !== undefined
          ? { model_reasoning_effort: JSON.stringify(both.reasoningEffort) }
          : {}),
      },
    });
    expect(codex).toEqual(
      expect.arrayContaining([
        "resume",
        "tid",
        "-m",
        "opus",
        "-c",
        'model_reasoning_effort="high"',
      ]),
    );
  });
});

describe("model effort queue", () => {
  it("忙时排队，新请求覆盖旧请求，空闲才续接", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    const first = queue.request("w", {
      running: true,
      phase: "busy",
      canResume: true,
      needsConfirm: false,
    });
    expect(first.message).toBe(MODEL_EFFORT_AUTO_MESSAGE);
    expect(first.launch).toBe(false);
    const replaced = queue.request("w", {
      running: true,
      phase: "busy",
      canResume: true,
      needsConfirm: false,
    });
    expect(replaced.launch).toBe(false);
    queue.onPossibleIdle("w", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);
    queue.onPossibleIdle("w", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);
  });

  it("管理者和全放开窗口空闲后要确认，不直接续接", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(`${notice.action}:${notice.reason}`);
      },
    });
    const decision = decideModelEffort({
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: true,
    });
    expect(decision.message).toBe(MODEL_EFFORT_CONFIRM_MESSAGE);
    expect(decision.launch).toBe(false);
    queue.request("mgr", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: true,
    });
    expect(actions).toContain("confirm:confirm");
    expect(actions.some((action) => action.startsWith("resume"))).toBe(false);
  });

  it("无法续接时不重启，之后空闲也不再自动续接", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    const decision = queue.request("codex", {
      running: true,
      phase: "idle",
      canResume: false,
      needsConfirm: false,
    });
    expect(decision.message).toBe(MODEL_EFFORT_DEFERRED_MESSAGE);
    expect(decision.launch).toBe(false);
    queue.onPossibleIdle("codex", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    expect(actions).not.toContain("resume");
  });

  it("续接失败后不自动重试，窗口退出时清空排队", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    queue.request("w", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    queue.settled("w", false, "启动失败");
    queue.onPossibleIdle("w", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);

    actions.length = 0;
    queue.request("gone", {
      running: true,
      phase: "busy",
      canResume: true,
      needsConfirm: false,
    });
    queue.drop("gone");
    queue.onPossibleIdle("gone", {
      running: true,
      phase: "idle",
      canResume: true,
      needsConfirm: false,
    });
    expect(actions).not.toContain("resume");
  });

  it("空闲时连发两次只续接一次，参数是第二次的值", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    const idle = {
      running: true,
      phase: "idle" as const,
      canResume: true,
      needsConfirm: false,
    };
    queue.request("w", idle, { model: "sonnet", effort: "low" });
    queue.request("w", idle, { model: "opus", effort: "high" });
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);
    const captured = queue.noteLaunchRead("w", queue.generation("w"));
    expect(captured).toEqual({ model: "opus", effort: "high" });
    const args = buildInteractiveClaudeArgs({
      ...(captured?.model !== undefined ? { model: captured.model } : {}),
      ...(captured?.effort !== undefined ? { effort: captured.effort } : {}),
      resumeSessionId: "sess",
      permission: "edit",
    });
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).not.toContain("sonnet");
    expect(args).not.toContain("low");
    queue.settled("w", true);
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);
  });

  it("续接进行中再发一次，结束后再续接一次且用最后的值，不会并发", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    const idle = {
      running: true,
      phase: "idle" as const,
      canResume: true,
      needsConfirm: false,
    };
    queue.request("w", idle, { effort: "low" });
    const started = queue.generation("w");
    queue.noteLaunchRead("w", started);
    queue.request("w", idle, { effort: "high" });
    expect(actions.filter((action) => action === "resume")).toEqual(["resume"]);
    queue.settled("w", true);
    expect(actions.filter((action) => action === "resume")).toEqual(["resume", "resume"]);
    const captured = queue.noteLaunchRead("w", queue.generation("w"));
    expect(captured?.effort).toBe("high");
    const args = buildInteractiveClaudeArgs({
      ...(captured?.effort !== undefined ? { effort: captured.effort } : {}),
      resumeSessionId: "sess",
      permission: "edit",
    });
    expect(args).toContain("high");
    expect(args).not.toContain("low");
    queue.settled("w", true);
    expect(actions.filter((action) => action === "resume")).toEqual(["resume", "resume"]);
  });

  it("要确认的窗口连发两次只确认一轮，框里是最后的值", () => {
    const actions: string[] = [];
    const queue = createModelEffortController({
      onChange: (notice) => {
        actions.push(notice.action);
      },
    });
    const waiting = {
      running: true,
      phase: "idle" as const,
      canResume: true,
      needsConfirm: true,
    };
    queue.request("mgr", waiting, { effort: "low" });
    queue.request("mgr", waiting, { effort: "high" });
    expect(actions.filter((action) => action === "resume")).toEqual([]);
    expect(actions.filter((action) => action === "confirm")).toEqual(["confirm", "confirm"]);
    const captured = queue.noteLaunchRead("mgr", queue.generation("mgr"));
    expect(captured?.effort).toBe("high");
    queue.settled("mgr", true);
    expect(actions.filter((action) => action === "resume")).toEqual([]);
  });
});
