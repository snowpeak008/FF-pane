/**
 * W2.7b 测试：适配器侧运行时权限拦截桥接。
 *
 * 全部用手工构造的假 AdapterTurn（脚本化 AsyncIterable）驱动，不起子进程——
 * 被测的是"事件流 → run-guard 裁决 → 应答/取消/审计"这条接线本身。
 *
 * cwd 用 POSIX 形态的绝对路径，因为 resolveRunPath 是纯词法解析，
 * 这样同一份断言在 Windows 与 POSIX 上都成立。
 */

import type { PermissionEnvelope } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import type {
  AdapterTurn,
  AgentEvent,
  EndEvent,
  GuardedTurn,
  GuardTurnContext,
  PermissionDecision,
} from "../src/index.js";
import {
  buildGuardedEnv,
  guardTurn,
  isGuardProducedEvent,
  isSelfProducedRequestId,
  judgeGuardPayload,
  maskGuardEvent,
  SELF_PRODUCED_REQUEST_PREFIX,
  toGuardJudgeContext,
  toStoredRunEvidence,
} from "../src/index.js";

const CWD = "/repo/project";

const ENVELOPE: PermissionEnvelope = {
  readPaths: ["src/**", "docs/**"],
  writePaths: ["src/**"],
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
};

function contextOf(overrides: Partial<GuardTurnContext> = {}): GuardTurnContext {
  return { cwd: CWD, envelope: ENVELOPE, ...overrides };
}

interface FakeTurn extends AdapterTurn {
  /** 内层收到的原生回执（顺序即调用顺序）。 */
  readonly responses: readonly (readonly [string, PermissionDecision])[];
  cancelCount(): number;
}

interface FakeTurnOptions {
  /** 是否具备原生权限回执通道（claude / opencode 为 true）。 */
  readonly nativeChannel?: boolean;
  /** 收尾 end；null = 内层流不吐 end（测兜底合成）。 */
  readonly end?: EndEvent | null;
}

/**
 * 脚本化的假 turn。被取消后立刻停止吐剩余脚本事件，并以 end(cancelled) 收尾——
 * 这正是真实适配器"树杀后由 finalize 兜底"的行为。
 */
function createFakeTurn(script: readonly AgentEvent[], options: FakeTurnOptions = {}): FakeTurn {
  const responses: (readonly [string, PermissionDecision])[] = [];
  let cancels = 0;
  let cancelled = false;
  const end: EndEvent | null =
    options.end === undefined ? { kind: "end", reason: "completed" } : options.end;

  async function* events(): AsyncGenerator<AgentEvent> {
    for (const event of script) {
      if (cancelled) {
        break;
      }
      yield event;
      // 让出微任务：真实流是异步的，外部回执有机会插进来。
      await Promise.resolve();
    }
    if (end !== null) {
      yield cancelled ? { kind: "end", reason: "cancelled" } : end;
    }
  }

  const cancel = async (): Promise<void> => {
    cancels += 1;
    cancelled = true;
  };
  const base = {
    events: events(),
    cancel,
    responses,
    cancelCount: () => cancels,
  };
  if (options.nativeChannel !== true) {
    return base;
  }
  return {
    ...base,
    respondPermission: async (nativeRequestId: string, decision: PermissionDecision) => {
      responses.push([nativeRequestId, decision]);
    },
  };
}

async function collect(guarded: GuardedTurn): Promise<AgentEvent[]> {
  const received: AgentEvent[] = [];
  for await (const event of guarded.events) {
    received.push(event);
  }
  return received;
}

/** 边收边回执：对每条上浮的权限请求按 decide 的返回值回执。 */
async function collectAndRespond(
  guarded: GuardedTurn,
  decide: (event: AgentEvent) => PermissionDecision | undefined,
): Promise<AgentEvent[]> {
  const received: AgentEvent[] = [];
  for await (const event of guarded.events) {
    received.push(event);
    if (event.kind === "permission_request") {
      const decision = decide(event);
      if (decision !== undefined) {
        await guarded.respondPermission(event.nativeRequestId, decision);
      }
    }
  }
  return received;
}

function guardTypes(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "raw" && event.nativeType !== undefined && isGuardProducedEvent(event)
      ? [event.nativeType]
      : [],
  );
}

function endOf(events: readonly AgentEvent[]): EndEvent {
  const last = events.at(-1);
  if (last?.kind !== "end") {
    throw new Error("事件流必须以 end 收尾");
  }
  return last;
}

describe("原生权限请求的三态自动应答", () => {
  it("allowed 自动 allow、violation 自动 deny、needs_approval 原样上浮", async () => {
    const turn = createFakeTurn(
      [
        {
          kind: "permission_request",
          nativeRequestId: "req-allow",
          payload: { kind: "write_path", path: `${CWD}/src/a.ts` },
        },
        {
          kind: "permission_request",
          nativeRequestId: "req-violation",
          payload: { kind: "write_path", path: "/etc/passwd" },
        },
        {
          kind: "permission_request",
          nativeRequestId: "req-approval",
          payload: { kind: "write_path", path: `${CWD}/docs/plan.md` },
        },
      ],
      { nativeChannel: true },
    );
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    expect(turn.responses).toStrictEqual([
      ["req-allow", "allow"],
      ["req-violation", "deny"],
    ]);
    expect(guardTypes(events)).toStrictEqual([
      "guard.request_auto_allowed",
      "guard.request_auto_denied",
      "guard.audit_result",
    ]);

    // 自动应答过的请求不再上浮：只有 needs_approval 那条留给编排层。
    const surfaced = events.filter((event) => event.kind === "permission_request");
    expect(surfaced).toStrictEqual([
      {
        kind: "permission_request",
        nativeRequestId: "req-approval",
        payload: { kind: "write_path", path: `${CWD}/docs/plan.md` },
      },
    ]);

    const outcomes = guarded.interceptions().map((entry) => [entry.decision, entry.outcome]);
    expect(outcomes).toStrictEqual([
      ["violation", "auto_denied"],
      ["needs_approval", "pending"],
    ]);
    expect(guarded.interceptions()[0]?.violation?.code).toBe("path_outside_project");
  });

  it("批准原生请求：回执 allow 并把批准并入本轮信封", async () => {
    const turn = createFakeTurn(
      [
        {
          kind: "permission_request",
          nativeRequestId: "req-1",
          payload: { kind: "write_path", path: `${CWD}/docs/plan.md` },
        },
      ],
      { nativeChannel: true },
    );
    const guarded = guardTurn(turn, contextOf());
    const events = await collectAndRespond(guarded, () => "allow");

    expect(turn.responses).toStrictEqual([["req-1", "allow"]]);
    expect(guarded.envelope().writePaths).toStrictEqual(["src/**", "docs/plan.md"]);
    expect(guardTypes(events)).toContain("guard.request_approved");
    expect(guarded.interceptions()[0]?.outcome).toBe("approved");
    expect(endOf(events).reason).toBe("completed");
  });

  it("拒绝原生请求：回执 deny 且不取消整轮", async () => {
    const turn = createFakeTurn(
      [
        {
          kind: "permission_request",
          nativeRequestId: "req-1",
          payload: { kind: "write_path", path: `${CWD}/docs/plan.md` },
        },
        { kind: "text", content: "换个思路", final: true, channel: "answer" },
      ],
      { nativeChannel: true },
    );
    const guarded = guardTurn(turn, contextOf());
    const events = await collectAndRespond(guarded, () => "deny");

    expect(turn.responses).toStrictEqual([["req-1", "deny"]]);
    expect(turn.cancelCount()).toBe(0);
    expect(events.some((event) => event.kind === "text")).toBe(true);
    expect(endOf(events).reason).toBe("completed");
  });

  it("读与网络载荷由桥接层直判（run-guard 只覆盖写与命令）", () => {
    const judgeContext = toGuardJudgeContext(contextOf(), ENVELOPE);
    expect(
      judgeGuardPayload({ kind: "read_path", path: "/etc/shadow" }, judgeContext),
    ).toMatchObject({ decision: "violation" });
    expect(
      judgeGuardPayload({ kind: "read_path", path: `${CWD}/src/a.ts` }, judgeContext),
    ).toMatchObject({ decision: "allowed" });
    expect(judgeGuardPayload({ kind: "network" }, judgeContext)).toMatchObject({
      decision: "needs_approval",
    });
    expect(
      judgeGuardPayload(
        { kind: "network" },
        toGuardJudgeContext(contextOf(), { ...ENVELOPE, network: true }),
      ),
    ).toMatchObject({ decision: "allowed" });
  });
});

describe("自产请求（无原生转发通道）", () => {
  it("needs_approval 合成 permission_request 上浮，ID 带 self-produced 前缀", async () => {
    const turn = createFakeTurn([
      {
        kind: "file_change",
        path: `${CWD}/docs/plan.md`,
        changeKind: "add",
        status: "started",
        actionId: "act-1",
      },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    const request = events.find((event) => event.kind === "permission_request");
    if (request?.kind !== "permission_request") {
      throw new Error("应合成一条 permission_request");
    }
    expect(request.nativeRequestId).toBe(`${SELF_PRODUCED_REQUEST_PREFIX}1`);
    expect(isSelfProducedRequestId(request.nativeRequestId)).toBe(true);
    expect(isGuardProducedEvent(request)).toBe(true);
    expect(request.payload).toStrictEqual({ kind: "write_path", path: "docs/plan.md" });
    // 原生事件恒排在 guard 的反应之前。
    expect(events.map((event) => event.kind).slice(0, 2)).toStrictEqual([
      "file_change",
      "permission_request",
    ]);
  });

  it("violation 留档并按 cancelOnViolation 默认取消整轮", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: "/etc/hosts", changeKind: "update", status: "started" },
      { kind: "text", content: "本条不该出现", final: true, channel: "answer" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    expect(turn.cancelCount()).toBe(1);
    expect(guardTypes(events)).toContain("guard.action_violation");
    expect(guardTypes(events)).toContain("guard.cancelled");
    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(endOf(events).reason).toBe("cancelled");
    expect(endOf(events).message).toContain("FF-pane 权限层");
  });

  it("cancelOnViolation=false：不取消，但 end 仍不得为 completed", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: "/etc/hosts", changeKind: "update", status: "started" },
      { kind: "text", content: "继续跑", final: true, channel: "answer" },
    ]);
    const guarded = guardTurn(turn, contextOf({ options: { cancelOnViolation: false } }));
    const events = await collect(guarded);

    expect(turn.cancelCount()).toBe(0);
    expect(events.some((event) => event.kind === "text")).toBe(true);
    expect(endOf(events).reason).toBe("failed");
  });

  it("用户拒绝自产请求：按 cancelOnDeny 默认取消整轮（Runtime 收不到 deny）", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/docs/plan.md`, changeKind: "add", status: "started" },
      { kind: "text", content: "本条不该出现", final: true, channel: "answer" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collectAndRespond(guarded, () => "deny");

    expect(turn.cancelCount()).toBe(1);
    expect(guardTypes(events)).toContain("guard.request_denied");
    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(endOf(events).reason).toBe("cancelled");
    expect(guarded.interceptions()[0]?.outcome).toBe("denied");
  });

  it("cancelOnDeny=false：不取消，拒绝只留档", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/docs/plan.md`, changeKind: "add", status: "started" },
      { kind: "text", content: "继续跑", final: true, channel: "answer" },
    ]);
    const guarded = guardTurn(turn, contextOf({ options: { cancelOnDeny: false } }));
    const events = await collectAndRespond(guarded, () => "deny");

    expect(turn.cancelCount()).toBe(0);
    expect(events.some((event) => event.kind === "text")).toBe(true);
  });

  it("未登记的回执 ID 抛 GuardError（无原生通道时无处转发）", async () => {
    const turn = createFakeTurn([]);
    const guarded = guardTurn(turn, contextOf());
    await expect(guarded.respondPermission("不存在的 ID", "allow")).rejects.toThrow(
      /未登记的权限请求 ID/,
    );
    await collect(guarded);
  });
});

describe("危险操作的逐次确认与事后审计（提醒 ⑤）", () => {
  const script: readonly AgentEvent[] = [
    {
      kind: "file_change",
      path: `${CWD}/legacy/old.ts`,
      changeKind: "delete",
      status: "started",
      actionId: "act-del",
    },
    {
      kind: "file_change",
      path: `${CWD}/legacy/old.ts`,
      changeKind: "delete",
      status: "completed",
      actionId: "act-del",
      diff: "--- a/legacy/old.ts\n+++ /dev/null\n",
    },
  ];

  it("批准后放行的危险操作在事后审计里被豁免，不计违规", async () => {
    const turn = createFakeTurn(script);
    const guarded = guardTurn(turn, contextOf());
    const events = await collectAndRespond(guarded, () => "allow");

    expect(guarded.approvals()).toStrictEqual([
      { operation: "delete_outside_write_scope", detail: "legacy/old.ts" },
    ]);
    const audit = guarded.auditResult();
    expect(audit?.violations).toStrictEqual([]);
    expect(audit?.waived).toHaveLength(1);
    expect(audit?.ok).toBe(true);
    expect(endOf(events).reason).toBe("completed");
    expect(endOf(events).message).toBeUndefined();
  });

  it("未批准时同一序列在事后审计里记为违规，end 降级为 failed", async () => {
    const turn = createFakeTurn(script);
    const guarded = guardTurn(turn, contextOf({ options: { cancelOnDeny: false } }));
    const events = await collect(guarded);

    const audit = guarded.auditResult();
    expect(audit?.violations).toHaveLength(1);
    expect(audit?.violations[0]?.code).toBe("dangerous_operation_unapproved");
    expect(audit?.ok).toBe(false);
    expect(endOf(events).reason).toBe("failed");
    expect(endOf(events).message).toContain("事后审计发现 1 项越界");
  });

  it("批准写路径扩展后，后续同目录写入直接放行", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/docs/a.md`, changeKind: "add", status: "started" },
      { kind: "file_change", path: `${CWD}/docs/a.md`, changeKind: "add", status: "completed" },
      { kind: "file_change", path: `${CWD}/docs/a.md`, changeKind: "update", status: "started" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collectAndRespond(guarded, () => "allow");

    // 第二次写同一路径不再送审（信封已被本轮批准放宽）。
    expect(events.filter((event) => event.kind === "permission_request")).toHaveLength(1);
    expect(guarded.auditResult()?.violations).toStrictEqual([]);
    expect(endOf(events).reason).toBe("completed");
  });
});

describe("Runtime 的 denied 不作为放行依据（提醒 ⑥）", () => {
  it("被 Runtime 自称拒绝的越界动作照样记入拦截清单，end 不得为 completed", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: "/etc/hosts", changeKind: "update", status: "denied" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    // denied 动作不入证据（Runtime 自称未执行），但裁决照做。
    expect(guarded.evidence().fileChanges).toStrictEqual([]);
    expect(guarded.evidence().runtimeBlockages).toHaveLength(1);
    expect(guarded.interceptions().map((entry) => [entry.decision, entry.outcome])).toStrictEqual([
      ["violation", "recorded"],
    ]);
    expect(turn.cancelCount()).toBe(0);
    expect(endOf(events).reason).toBe("failed");
    expect(endOf(events).message).toContain("事前拦截 1 项恒拒");
  });

  it("Runtime 拒绝了本层允许的动作：属环境阻断，不算权限违规", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/src/a.ts`, changeKind: "update", status: "denied" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    expect(guarded.interceptions()).toStrictEqual([]);
    expect(guarded.evidence().runtimeBlockages[0]).toContain("Runtime 自称已拒绝");
    expect(guardTypes(events)).toContain("guard.runtime_denied");
    // 阻断证据只进 message 侧的诊断，reason 的判定权归适配器，guard 不重复降级。
    expect(endOf(events).reason).toBe("completed");
  });

  it("Runtime 拒绝一条未获批准的危险命令：记为未批准尝试", async () => {
    const turn = createFakeTurn([
      { kind: "command", command: "git push origin main", status: "denied" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    await collect(guarded);

    expect(guarded.evidence().commands).toStrictEqual([]);
    expect(guarded.interceptions().map((entry) => [entry.decision, entry.outcome])).toStrictEqual([
      ["needs_approval", "recorded"],
    ]);
  });
});

describe("证据收集与收尾审计", () => {
  it("completed / failed 入证据，started / denied 不入；审计口径与证据一致", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/src/a.ts`, changeKind: "add", status: "started" },
      {
        kind: "file_change",
        path: `${CWD}/src/a.ts`,
        changeKind: "add",
        status: "completed",
        diff: "--- /dev/null\n+++ b/src/a.ts\n",
      },
      { kind: "file_change", path: `${CWD}/src/b.ts`, changeKind: "update", status: "failed" },
      { kind: "command", command: "pnpm test", status: "completed", exitCode: 0 },
      { kind: "command", command: "pnpm lint", status: "failed" },
      { kind: "command", command: "pnpm build", status: "denied" },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    const evidence = guarded.evidence();
    expect(evidence.fileChanges).toStrictEqual([
      { path: `${CWD}/src/a.ts`, changeKind: "add", diff: "--- /dev/null\n+++ b/src/a.ts\n" },
      { path: `${CWD}/src/b.ts`, changeKind: "update" },
    ]);
    expect(evidence.commands).toStrictEqual([
      { command: "pnpm test", exitCode: 0 },
      { command: "pnpm lint" },
    ]);
    expect(evidence.runtimeBlockages).toHaveLength(3);

    const audit = guarded.auditResult();
    expect(audit?.checkedFileChanges).toBe(2);
    expect(audit?.checkedCommands).toBe(2);
    expect(audit?.ok).toBe(true);
    expect(endOf(events).reason).toBe("completed");

    // §6.4 落库形态：缺失的 diff 与退出码在此处（且只在此处）补默认值。
    expect(toStoredRunEvidence(evidence)).toStrictEqual({
      fileChanges: [
        { path: `${CWD}/src/a.ts`, diff: "--- /dev/null\n+++ b/src/a.ts\n" },
        { path: `${CWD}/src/b.ts`, diff: "" },
      ],
      commands: [
        { command: "pnpm test", exitCode: 0 },
        { command: "pnpm lint", exitCode: -1 },
      ],
    });
  });

  it("changeKind 透传：diff 反推不出时按 update，不会把普通修改升级为删除越界", async () => {
    const turn = createFakeTurn([
      {
        kind: "file_change",
        path: `${CWD}/legacy/x.ts`,
        changeKind: "update",
        status: "completed",
      },
    ]);
    const guarded = guardTurn(turn, contextOf());
    await collect(guarded);

    const audit = guarded.auditResult();
    expect(audit?.violations[0]?.code).toBe("write_outside_envelope");
  });

  it("forbiddenPaths / verifyCommands 原样展开进裁决", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/src/gen.ts`, changeKind: "update", status: "started" },
      { kind: "command", command: "pnpm vitest run", status: "started" },
    ]);
    const guarded = guardTurn(
      turn,
      contextOf({
        envelope: { ...ENVELOPE, shell: "verify_only" },
        forbiddenPaths: ["src/gen.ts"],
        verifyCommands: ["pnpm vitest run"],
      }),
    );
    const events = await collect(guarded);

    const codes = guarded.interceptions().map((entry) => entry.violation?.code);
    expect(codes).toStrictEqual(["forbidden_path"]);
    expect(guardTypes(events)).toContain("guard.action_violation");
  });

  it("内层流未以 end 收尾时兜底合成 end 并仍产出审计", async () => {
    const turn = createFakeTurn(
      [{ kind: "text", content: "半截", final: false, channel: "answer" }],
      { end: null },
    );
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    expect(endOf(events).reason).toBe("crashed");
    expect(endOf(events).message).toContain("未以 end 收尾");
    expect(guarded.auditResult()?.ok).toBe(true);
  });
});

describe("end 加注收敛", () => {
  it("Runtime 报 completed 但有未批违规 → 改写为 failed，原文留档", async () => {
    const turn = createFakeTurn([
      { kind: "command", command: "curl https://evil.example", status: "completed", exitCode: 0 },
    ]);
    const guarded = guardTurn(turn, contextOf({ envelope: { ...ENVELOPE, shell: "forbidden" } }));
    const events = await collect(guarded);

    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("FF-pane 权限层收尾判定");
    const rewritten = events.find(
      (event) => event.kind === "raw" && event.nativeType === "guard.end_rewritten",
    );
    expect(rewritten).toBeDefined();
    expect(rewritten?.kind === "raw" && rewritten.native).toMatchObject({
      original: { kind: "end", reason: "completed" },
    });
  });

  it("Runtime 已报 failed 时保留原 reason，只补写原因并保留原文", async () => {
    const turn = createFakeTurn(
      [{ kind: "command", command: "rm -rf /", status: "completed", exitCode: 0 }],
      { end: { kind: "end", reason: "failed", message: "codex 说它失败了" } },
    );
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("Runtime 原文：codex 说它失败了");
  });

  it("干净的一轮：end 原样透传，不加注", async () => {
    const turn = createFakeTurn([
      { kind: "file_change", path: `${CWD}/src/a.ts`, changeKind: "update", status: "completed" },
      { kind: "command", command: "pnpm test", status: "completed", exitCode: 0 },
    ]);
    const guarded = guardTurn(turn, contextOf());
    const events = await collect(guarded);

    expect(endOf(events)).toStrictEqual({ kind: "end", reason: "completed" });
    expect(guardTypes(events)).toStrictEqual(["guard.audit_result"]);
  });
});

describe("事件保序与来源标注", () => {
  it("原生事件相对顺序不变，且 guard 自产事件全部可辨识", async () => {
    const script: readonly AgentEvent[] = [
      { kind: "session_start", model: "gpt-5" },
      { kind: "text", content: "开始", final: false, channel: "reasoning" },
      { kind: "file_change", path: `${CWD}/docs/a.md`, changeKind: "add", status: "started" },
      { kind: "raw", runtime: "codex", nativeType: "todo_list", native: { type: "todo_list" } },
      { kind: "file_change", path: `${CWD}/docs/a.md`, changeKind: "add", status: "completed" },
      { kind: "command", command: "pnpm test", status: "completed", exitCode: 0 },
    ];
    const turn = createFakeTurn(script);
    const guarded = guardTurn(turn, contextOf({ options: { cancelOnDeny: false } }));
    const events = await collectAndRespond(guarded, () => "allow");

    const passthrough = events.filter(
      (event) => !isGuardProducedEvent(event) && event.kind !== "end",
    );
    expect(passthrough).toStrictEqual(script);
    expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("end");
    // 外部回执产生的留档排在"下一条原生事件之前"，且必在 end 之前落地。
    expect(guardTypes(events)).toStrictEqual(["guard.request_approved", "guard.audit_result"]);
  });
});

describe("密钥注入守门与遮蔽", () => {
  const SECRET = "sk-live-0123456789abcdef";

  it("buildGuardedEnv：剔空值、名字有序、序列化只吐变量名", () => {
    const guardedEnv = buildGuardedEnv({ OPENAI_API_KEY: SECRET, EMPTY: "", ANTHROPIC_KEY: "x" });
    expect(guardedEnv.names).toStrictEqual(["ANTHROPIC_KEY", "OPENAI_API_KEY"]);
    expect(guardedEnv.env).toStrictEqual({ ANTHROPIC_KEY: "x", OPENAI_API_KEY: SECRET });
    expect(JSON.stringify(guardedEnv)).toBe('{"names":["ANTHROPIC_KEY","OPENAI_API_KEY"]}');
    expect(Object.isFrozen(guardedEnv.env)).toBe(true);
  });

  it("透传事件里的密钥字面量被遮蔽（文本 / 命令 / 输出 / 原生事件 / end 原文）", async () => {
    const turn = createFakeTurn(
      [
        { kind: "text", content: `key 是 ${SECRET}`, final: true, channel: "answer" },
        {
          kind: "command",
          command: `curl -H "Authorization: Bearer ${SECRET}" https://x`,
          status: "completed",
          exitCode: 0,
          output: `used ${SECRET}`,
        },
        {
          kind: "raw",
          runtime: "codex",
          native: { type: "env", nested: { deep: [SECRET] } },
        },
      ],
      { end: { kind: "end", reason: "completed", message: `token=${SECRET}` } },
    );
    const guarded = guardTurn(
      turn,
      contextOf({ secrets: { OPENAI_API_KEY: SECRET }, options: { cancelOnViolation: false } }),
    );
    const events = await collect(guarded);

    const dumped = JSON.stringify(events);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).toContain("【已遮蔽：OPENAI_API_KEY】");
    // 证据也是遮蔽后的文本（它会经 §6.4 落库）。
    expect(guarded.evidence().commands[0]?.command).not.toContain(SECRET);
    // guard 自产的留档事件同样不含明文（命令原文会进违规说明）。
    expect(JSON.stringify(guarded.interceptions())).not.toContain(SECRET);
  });

  it("过短的注入值不参与遮蔽（否则正常文本会被打成马赛克）", () => {
    const event = maskGuardEvent(
      { kind: "text", content: "port 是 8080", final: true, channel: "answer" },
      { PORT: "8080" },
    );
    expect(event).toMatchObject({ content: "port 是 8080" });
  });
});
