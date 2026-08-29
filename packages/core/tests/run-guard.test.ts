import type {
  PermissionEnvelope,
  PermissionRequestPayload,
  PlanVersion,
  Role,
  TaskContract,
  TaskId,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assembleRunEnvelope,
  auditRunEvidence,
  deriveForbiddenPathPatterns,
  deriveTaskEnvelope,
  inferFileChangeKind,
  intersectEnvelopes,
  isRunEnvelopeStage,
  isRunFileChangeKind,
  isRunGuardViolationCode,
  judgeCommand,
  judgeFileChange,
  type RunEnvelope,
  type RunEnvelopeAuditStep,
  type RunEvidence,
  resolveRunPath,
  UNCONSTRAINED_PROJECT_ENVELOPE,
} from "../src/index.js";

const TASK_ID = "task-w27a" as TaskId;
const PLAN_VERSION = 1 as PlanVersion;

/** 项目根：Windows 盘符路径（本项目主战场，见工单环境）。 */
const PROJECT_ROOT = "D:\\proj";

interface ContractOptions {
  readonly writeScope?: readonly string[];
  readonly forbidden?: readonly string[];
  readonly verifyCmd?: string;
}

function makeContract(options: ContractOptions = {}): TaskContract {
  return {
    id: TASK_ID,
    planVersion: PLAN_VERSION,
    goal: "实现登录模块",
    writeScope: options.writeScope ?? ["src/auth"],
    forbidden: options.forbidden ?? [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["登录可用"],
    ...(options.verifyCmd === undefined ? {} : { verifyCmd: options.verifyCmd }),
  };
}

function makeEnvelope(
  overrides: Partial<Omit<PermissionEnvelope, "dangerousOpsRequireApproval">> = {},
): PermissionEnvelope {
  return {
    readPaths: ["**"],
    writePaths: ["**"],
    shell: "allowed",
    network: false,
    dangerousOpsRequireApproval: true,
    ...overrides,
  };
}

function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((scope, i) => scope === [...b].sort()[i]);
}

/** inner ⊆ outer 的判定：inner ∩ outer 与 inner 的规范形态逐维相同（同 W1.6 手法）。 */
function isSubsetEnvelope(inner: PermissionEnvelope, outer: PermissionEnvelope): boolean {
  const canonical = intersectEnvelopes(inner, inner);
  const clamped = intersectEnvelopes(inner, outer);
  return (
    sameScopeSet(canonical.readPaths, clamped.readPaths) &&
    sameScopeSet(canonical.writePaths, clamped.writePaths) &&
    canonical.shell === clamped.shell &&
    canonical.network === clamped.network
  );
}

function stepOf(steps: readonly RunEnvelopeAuditStep[], stage: string): RunEnvelopeAuditStep {
  const step = steps.find((candidate) => candidate.stage === stage);
  if (step === undefined) {
    throw new Error(`审计记录缺少 ${stage} 级`);
  }
  return step;
}

function workerEnvelope(options: ContractOptions = {}): RunEnvelope {
  return assembleRunEnvelope({ role: "worker", taskContract: makeContract(options) }).envelope;
}

describe("任务信封派生（W2.7a 规则）", () => {
  it("writeScope 原样成为可写路径，读/shell 不收窄，网络未声明即不收窄", () => {
    expect(deriveTaskEnvelope(makeContract({ writeScope: ["src/auth", "tests"] }))).toEqual({
      readPaths: ["**"],
      writePaths: ["src/auth", "tests"],
      shell: "allowed",
      network: true,
      dangerousOpsRequireApproval: true,
    });
  });

  it("writeScope 为空即本任务不可写", () => {
    expect(deriveTaskEnvelope(makeContract({ writeScope: [] })).writePaths).toEqual([]);
  });

  it("显式声明不需要网络时收窄为禁止", () => {
    expect(deriveTaskEnvelope(makeContract(), false).network).toBe(false);
    expect(deriveTaskEnvelope(makeContract(), true).network).toBe(true);
  });
});

describe("信封装配：逐级相交（§7 / v0.1 §29 公式）", () => {
  it("Worker：角色默认收网络、任务合同收可写范围", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
    });

    expect(assembled.envelope).toEqual({
      readPaths: ["**"],
      writePaths: ["src/auth"],
      shell: "allowed",
      network: false,
      dangerousOpsRequireApproval: true,
      grantedCommands: [],
    });

    const roleStep = stepOf(assembled.audit.steps, "role_default");
    expect(roleStep.applied).toBe(true);
    expect(roleStep.changes).toEqual([
      {
        dimension: "network",
        direction: "narrowed",
        before: true,
        after: false,
        detail: "网络由允许收窄为禁止",
      },
    ]);

    const taskStep = stepOf(assembled.audit.steps, "task_contract");
    expect(taskStep.changes).toEqual([
      {
        dimension: "writePaths",
        direction: "narrowed",
        before: ["**"],
        after: ["src/auth"],
        detail: "可写路径由 [**] 收窄为 [src/auth]",
      },
    ]);
    expect(taskStep.result).toBe(assembled.audit.steps.at(-1)?.result);
  });

  it("项目未配策略 / Profile 无预设时，两级记为未参与且不改变累积信封", () => {
    const assembled = assembleRunEnvelope({ role: "worker", taskContract: makeContract() });
    const projectStep = stepOf(assembled.audit.steps, "project_policy");
    const profileStep = stepOf(assembled.audit.steps, "profile_preset");

    expect(projectStep.applied).toBe(false);
    expect(projectStep.skippedReason).toContain("项目未为角色 worker 配置权限策略");
    expect(projectStep.result).toEqual(intersectEnvelopes(UNCONSTRAINED_PROJECT_ENVELOPE));
    expect(profileStep.applied).toBe(false);
    expect(profileStep.changes).toEqual([]);
    expect(assembled.audit.base).toEqual(UNCONSTRAINED_PROJECT_ENVELOPE);
  });

  it("Profile 预设与项目策略各自收窄自己那一维", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
      profilePreset: makeEnvelope({ shell: "verify_only", writePaths: ["src"] }),
      projectPolicy: { worker: makeEnvelope({ readPaths: ["src"] }) },
    });

    expect(assembled.envelope.shell).toBe("verify_only");
    expect(assembled.envelope.writePaths).toEqual(["src/auth"]);
    expect(assembled.envelope.readPaths).toEqual(["src"]);

    const projectChanges = stepOf(assembled.audit.steps, "project_policy").changes;
    expect(projectChanges.map((change) => change.dimension)).toEqual(["readPaths", "network"]);
    expect(projectChanges[0]).toEqual({
      dimension: "readPaths",
      direction: "narrowed",
      before: ["**"],
      after: ["src"],
      detail: "可读路径由 [**] 收窄为 [src]",
    });
    const profileChanges = stepOf(assembled.audit.steps, "profile_preset").changes;
    expect(profileChanges.map((change) => change.dimension)).toEqual(["writePaths", "shell"]);
    expect(profileChanges.at(-1)).toEqual({
      dimension: "shell",
      direction: "narrowed",
      before: "allowed",
      after: "verify_only",
      detail: "shell 策略由 allowed 收窄为 verify_only",
    });
  });

  it("Planner / Reviewer 的角色默认按 §7 表格生效", () => {
    const planner = assembleRunEnvelope({
      role: "planner",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
    }).envelope;
    expect(planner).toMatchObject({ writePaths: [], shell: "forbidden", network: true });

    const reviewer = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({ writeScope: ["src/auth"], verifyCmd: "pnpm test" }),
    }).envelope;
    expect(reviewer).toMatchObject({ writePaths: [], shell: "verify_only", network: false });
  });

  it("委派只能缩小：最终信封是每一级参与信封的子集，绝不宽于任何一级", () => {
    const roles: readonly Role[] = ["planner", "worker", "reviewer"];
    for (const role of roles) {
      const assembled = assembleRunEnvelope({
        role,
        taskContract: makeContract({ writeScope: ["src/auth", "docs/*.md"] }),
        profilePreset: makeEnvelope({ shell: "verify_only" }),
        projectPolicy: { [role]: makeEnvelope({ readPaths: ["src"] }) },
      });
      expect(isSubsetEnvelope(assembled.envelope, UNCONSTRAINED_PROJECT_ENVELOPE)).toBe(true);
      for (const step of assembled.audit.steps) {
        if (step.applied && step.input !== undefined) {
          expect(isSubsetEnvelope(assembled.envelope, step.input)).toBe(true);
        }
      }
      expect(
        assembled.audit.steps.every((step) =>
          step.changes.every((change) => change.direction === "narrowed"),
        ),
      ).toBe(true);
      expect(assembled.audit.widenedByGrants).toBe(false);
    }
  });

  it("任务合同比角色默认宽也放宽不了：Reviewer 拿到 write_scope 仍不可写", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({ writeScope: ["**"] }),
    });
    expect(assembled.envelope.writePaths).toEqual([]);
  });

  it("任务声明需要网络不构成放宽（Worker 默认禁止，AND 后仍禁止）", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract(),
      taskNetwork: true,
    });
    expect(assembled.envelope.network).toBe(false);
  });

  it("装配同时产出 forbidden 禁写模式与 verify_only 白名单（不落入信封 5 项）", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({
        forbidden: ["不要修改 src/legacy/ 目录", "禁止改动 pnpm-lock.yaml。"],
        verifyCmd: "pnpm test",
      }),
    });
    expect(assembled.forbiddenPaths).toEqual(["src/legacy", "pnpm-lock.yaml"]);
    expect(assembled.verifyCommands).toEqual(["pnpm test"]);
    expect(assembled.audit.taskId).toBe(TASK_ID);
    expect(assembled.audit.role).toBe("reviewer");
  });
});

describe("信封装配：用户批准（§7，仅当前 Run 有效）", () => {
  it("network 批准只放宽网络这一维", () => {
    const base = assembleRunEnvelope({ role: "worker", taskContract: makeContract() }).envelope;
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract(),
      grants: [{ kind: "network" }],
    });

    expect(assembled.envelope.network).toBe(true);
    expect(assembled.envelope.writePaths).toEqual(base.writePaths);
    expect(assembled.envelope.readPaths).toEqual(base.readPaths);
    expect(assembled.envelope.shell).toBe(base.shell);
    expect(assembled.envelope.grantedCommands).toEqual([]);

    const grantStep = stepOf(assembled.audit.steps, "user_grant");
    expect(grantStep.applied).toBe(true);
    expect(grantStep.grant).toEqual({ kind: "network" });
    expect(grantStep.changes).toEqual([
      {
        dimension: "network",
        direction: "widened",
        before: false,
        after: true,
        detail: "网络由禁止放宽为允许",
      },
    ]);
    expect(assembled.audit.widenedByGrants).toBe(true);
  });

  it("write_path 批准只追加可写作用域，读路径与 shell 不动", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
      grants: [{ kind: "write_path", path: "docs/设计.md" }],
    });
    expect(assembled.envelope.writePaths).toEqual(["src/auth", "docs/设计.md"]);
    expect(assembled.envelope.readPaths).toEqual(["**"]);
    expect(stepOf(assembled.audit.steps, "user_grant").changes).toEqual([
      {
        dimension: "writePaths",
        direction: "widened",
        before: ["src/auth"],
        after: ["src/auth", "docs/设计.md"],
        detail: "可写路径由 [src/auth] 放宽为 [src/auth, docs/设计.md]",
      },
    ]);
  });

  it("shell_command 批准只进本 Run 白名单，不改 shell 策略字面量", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract(),
      grants: [{ kind: "shell_command", command: "pnpm   lint" }],
    });
    expect(assembled.envelope.shell).toBe("verify_only");
    expect(assembled.envelope.grantedCommands).toEqual(["pnpm lint"]);
    expect(stepOf(assembled.audit.steps, "user_grant").changes).toEqual([
      {
        dimension: "grantedCommands",
        direction: "widened",
        before: [],
        after: ["pnpm lint"],
        detail: "本 Run 命令白名单新增 [pnpm lint]",
      },
    ]);
  });

  it("危险操作批准不产生任何豁免：记为未参与并留痕，不抛错", () => {
    const grant: PermissionRequestPayload = {
      kind: "dangerous_operation",
      operation: "git_push",
      detail: "git push origin main",
    };
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract(),
      grants: [grant],
    });
    const grantStep = stepOf(assembled.audit.steps, "user_grant");
    expect(grantStep.applied).toBe(false);
    expect(grantStep.grant).toEqual(grant);
    expect(grantStep.skippedReason).toContain("危险操作");
    expect(assembled.audit.widenedByGrants).toBe(false);
    expect(assembled.envelope).toEqual(workerEnvelope());
  });

  it("项目外路径的批准落不进信封：记为未参与，信封不变", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract(),
      grants: [{ kind: "write_path", path: "D:\\other\\x.ts" }],
    });
    const grantStep = stepOf(assembled.audit.steps, "user_grant");
    expect(grantStep.applied).toBe(false);
    expect(grantStep.skippedReason).toContain("不在项目内");
    expect(assembled.envelope.writePaths).toEqual(["src/auth"]);
  });

  it("多条批准逐条记录，顺序与入参一致", () => {
    const assembled = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract(),
      grants: [
        { kind: "network" },
        { kind: "shell_command", command: "git status" },
        { kind: "read_path", path: "../外部" },
      ],
    });
    const grantSteps = assembled.audit.steps.filter((step) => step.stage === "user_grant");
    expect(grantSteps).toHaveLength(3);
    expect(grantSteps.map((step) => step.applied)).toEqual([true, true, false]);
  });
});

describe("路径解析（Windows 边角 + 中文路径）", () => {
  it("相对路径直接归一，尾斜杠与反斜杠等价", () => {
    expect(resolveRunPath("src\\Auth\\Login.ts")).toEqual({
      inProject: true,
      key: "src/auth/login.ts",
    });
    expect(resolveRunPath("src/auth/")).toEqual({ inProject: true, key: "src/auth" });
  });

  it("盘符绝对路径按 cwd 折算，大小写不敏感", () => {
    expect(resolveRunPath("D:\\PROJ\\SRC\\Auth\\Login.TS", PROJECT_ROOT)).toEqual({
      inProject: true,
      key: "src/auth/login.ts",
    });
  });

  it("规避前缀陷阱：D:\\projext 不是 D:\\proj 的子路径", () => {
    const resolution = resolveRunPath("D:\\projext\\a.ts", PROJECT_ROOT);
    expect(resolution.inProject).toBe(false);
  });

  it("UNC 路径与 Win32 设备前缀（\\\\?\\）都能折算", () => {
    expect(resolveRunPath("\\\\server\\share\\proj\\src\\a.ts", "\\\\server\\share\\proj")).toEqual(
      { inProject: true, key: "src/a.ts" },
    );
    expect(resolveRunPath("\\\\?\\D:\\proj\\src\\a.ts", PROJECT_ROOT)).toEqual({
      inProject: true,
      key: "src/a.ts",
    });
    expect(resolveRunPath("\\\\server\\other\\a.ts", "\\\\server\\share").inProject).toBe(false);
  });

  it("中文路径与 NFC 归一：组合/分解编码形态视为同一路径", () => {
    expect(resolveRunPath("D:\\项目\\工作台\\文档\\说明.md", "D:\\项目\\工作台")).toEqual({
      inProject: true,
      key: "文档/说明.md",
    });
    const nfd = "D:/proj/caf\u0065\u0301/a.ts";
    expect(resolveRunPath(nfd, "D:/proj/caf\u00e9")).toEqual({ inProject: true, key: "a.ts" });
  });

  it("项目外形态一律拒绝：逃逸、主目录、缺 cwd 的绝对路径", () => {
    expect(resolveRunPath("..\\..\\etc\\passwd").inProject).toBe(false);
    expect(resolveRunPath("~/.ssh/id_rsa").inProject).toBe(false);
    expect(resolveRunPath("D:\\proj\\src\\a.ts").inProject).toBe(false);
    expect(resolveRunPath("D:\\proj\\src\\a.ts", "relative/root").inProject).toBe(false);
  });

  it("项目根自身的比较键为空串", () => {
    expect(resolveRunPath("D:\\proj\\", PROJECT_ROOT)).toEqual({ inProject: true, key: "" });
  });
});

describe("forbidden 禁写模式派生", () => {
  it("从散文中只抽取明显路径形态的 token", () => {
    expect(
      deriveForbiddenPathPatterns([
        "不要修改 src/legacy/ 目录",
        "禁止改动 pnpm-lock.yaml。",
        "不要跳过测试，也不要重构公共模块",
        '别碰 ".git/**"',
        "禁止写 docs/*.md",
      ]),
    ).toEqual(["src/legacy", "pnpm-lock.yaml", ".git", "docs/*.md"]);
  });

  it("重复项去重；项目外形态与 ** 一律跳过（另有恒拒规则与信封把守）", () => {
    expect(
      deriveForbiddenPathPatterns(["src/legacy", "src/legacy/", "**", "D:/other", "../上层"]),
    ).toEqual(["src/legacy"]);
  });
});

describe("写路径裁决三态", () => {
  const envelope = workerEnvelope({ writeScope: ["src/auth", "docs/*.md"] });

  it("信封内写入放行，返回项目内比较键", () => {
    expect(
      judgeFileChange({
        envelope,
        path: "D:\\proj\\src\\auth\\login.ts",
        changeKind: "update",
        cwd: PROJECT_ROOT,
      }),
    ).toMatchObject({ decision: "allowed", projectPath: "src/auth/login.ts" });
    expect(
      judgeFileChange({ envelope, path: "docs/说明.md", changeKind: "add", cwd: PROJECT_ROOT }),
    ).toMatchObject({ decision: "allowed", projectPath: "docs/说明.md" });
  });

  it("项目外路径恒拒，无审批通道", () => {
    const judgement = judgeFileChange({
      envelope,
      path: "D:\\other\\x.ts",
      changeKind: "update",
      cwd: PROJECT_ROOT,
    });
    expect(judgement.decision).toBe("violation");
    if (judgement.decision !== "violation") {
      throw new Error("期望 violation");
    }
    expect(judgement.violation.code).toBe("path_outside_project");
    expect(judgement.violation.target).toEqual({
      kind: "file_change",
      path: "D:\\other\\x.ts",
      changeKind: "update",
    });
    expect(judgement.violation.reason).toContain("项目外");
  });

  it("项目内但超出可写范围 → needs_approval，附 write_path 送审载荷", () => {
    const judgement = judgeFileChange({
      envelope,
      path: "src/other.ts",
      changeKind: "update",
      cwd: PROJECT_ROOT,
    });
    expect(judgement).toMatchObject({
      decision: "needs_approval",
      projectPath: "src/other.ts",
      request: { kind: "write_path", path: "src/other.ts" },
      dangerousOperations: [],
    });
  });

  it("forbidden 模式命中恒拒，即使可写范围覆盖该路径", () => {
    const judgement = judgeFileChange({
      envelope: workerEnvelope({ writeScope: ["**"] }),
      path: "D:\\proj\\src\\legacy\\a.ts",
      changeKind: "update",
      cwd: PROJECT_ROOT,
      forbiddenPaths: ["src/legacy"],
    });
    expect(judgement.decision).toBe("violation");
    if (judgement.decision !== "violation") {
      throw new Error("期望 violation");
    }
    expect(judgement.violation.code).toBe("forbidden_path");
    expect(judgement.violation.reason).toContain("不可由 Agent 申请豁免");
  });

  it("delete 超出可写范围归危险操作（先于普通写路径判定）", () => {
    const judgement = judgeFileChange({
      envelope,
      path: "src/other.ts",
      changeKind: "delete",
      cwd: PROJECT_ROOT,
    });
    expect(judgement).toMatchObject({
      decision: "needs_approval",
      request: {
        kind: "dangerous_operation",
        operation: "delete_outside_write_scope",
        detail: "删除 src/other.ts",
      },
      dangerousOperations: ["delete_outside_write_scope"],
    });
  });

  it("delete 落在可写范围内直接放行；forbidden 优先于危险操作判定", () => {
    expect(
      judgeFileChange({
        envelope,
        path: "src/auth/tmp.ts",
        changeKind: "delete",
        cwd: PROJECT_ROOT,
      }).decision,
    ).toBe("allowed");

    const judgement = judgeFileChange({
      envelope,
      path: "src/legacy/a.ts",
      changeKind: "delete",
      cwd: PROJECT_ROOT,
      forbiddenPaths: ["src/legacy"],
    });
    expect(judgement.decision).toBe("violation");
  });

  it("write_path 批准后同一路径的删除不再是越界（信封已含该作用域）", () => {
    const granted = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
      grants: [{ kind: "write_path", path: "src/other.ts" }],
    }).envelope;
    expect(
      judgeFileChange({
        envelope: granted,
        path: "src/other.ts",
        changeKind: "delete",
        cwd: PROJECT_ROOT,
      }).decision,
    ).toBe("allowed");
  });

  it("Reviewer 不可写：任何写入都要送审", () => {
    const reviewer = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract(),
    }).envelope;
    expect(
      judgeFileChange({
        envelope: reviewer,
        path: "src/auth/login.ts",
        changeKind: "update",
        cwd: PROJECT_ROOT,
      }),
    ).toMatchObject({ decision: "needs_approval", request: { kind: "write_path" } });
  });
});

describe("命令裁决", () => {
  it("verify_only：命中任务合同验证命令放行（空白折叠后整串比对）", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({ verifyCmd: "pnpm test" }),
    });
    expect(
      judgeCommand({
        envelope: assembled.envelope,
        command: "pnpm   test",
        verifyCommands: assembled.verifyCommands,
      }).decision,
    ).toBe("allowed");
    expect(
      judgeCommand({
        envelope: assembled.envelope,
        command: "pnpm test",
        verifyCmd: "pnpm test",
      }).decision,
    ).toBe("allowed");
  });

  it("verify_only：白名单外的命令拒绝，但附 shell_command 送审载荷", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({ verifyCmd: "pnpm test" }),
    });
    const judgement = judgeCommand({
      envelope: assembled.envelope,
      command: "pnpm lint",
      verifyCommands: assembled.verifyCommands,
    });
    expect(judgement.decision).toBe("violation");
    if (judgement.decision !== "violation") {
      throw new Error("期望 violation");
    }
    expect(judgement.violation.code).toBe("command_denied");
    expect(judgement.request).toEqual({ kind: "shell_command", command: "pnpm lint" });
    expect(judgement.violation.reason).toContain("verify_only");
  });

  it("verify_only：本 Run 已批准的命令越过策略闸门", () => {
    const assembled = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract({ verifyCmd: "pnpm test" }),
      grants: [{ kind: "shell_command", command: "pnpm lint" }],
    });
    expect(
      judgeCommand({
        envelope: assembled.envelope,
        command: "pnpm lint",
        verifyCommands: assembled.verifyCommands,
      }).decision,
    ).toBe("allowed");
  });

  it("shell forbidden（Planner）：一切命令拒绝", () => {
    const planner = assembleRunEnvelope({ role: "planner", taskContract: makeContract() }).envelope;
    const judgement = judgeCommand({ envelope: planner, command: "pnpm test" });
    expect(judgement.decision).toBe("violation");
  });

  it("危险命令（§7 固定清单）→ needs_approval，载荷为 dangerous_operation", () => {
    const judgement = judgeCommand({
      envelope: workerEnvelope(),
      command: "git push origin main",
    });
    expect(judgement).toMatchObject({
      decision: "needs_approval",
      request: {
        kind: "dangerous_operation",
        operation: "git_push",
        detail: "git push origin main",
      },
    });
  });

  it("删除超出 write_scope 的命令按危险操作送审，范围内的放行", () => {
    const envelope = workerEnvelope({ writeScope: ["src/auth"] });
    expect(judgeCommand({ envelope, command: "rm -rf src/other" })).toMatchObject({
      decision: "needs_approval",
      request: { kind: "dangerous_operation", operation: "delete_outside_write_scope" },
    });
    expect(judgeCommand({ envelope, command: "rm src/auth/tmp.ts" }).decision).toBe("allowed");
  });

  it("追加的危险规则生效（内置清单只增不减）", () => {
    const judgement = judgeCommand({
      envelope: workerEnvelope(),
      command: "kubectl delete pod x",
      extraDangerousRules: [
        { id: "kubectl-delete", operation: "publish_or_deploy", pattern: /kubectl\s+delete/i },
      ],
    });
    expect(judgement.decision).toBe("needs_approval");
    expect(judgement.classification.matchedRules).toContain("kubectl-delete");
  });
});

describe("事后审计（证据越界检出）", () => {
  const assembled = assembleRunEnvelope({
    role: "worker",
    taskContract: makeContract({
      writeScope: ["src/auth"],
      forbidden: ["不要修改 src/legacy/"],
      verifyCmd: "pnpm test",
    }),
  });
  const auditOptions = {
    cwd: PROJECT_ROOT,
    forbiddenPaths: assembled.forbiddenPaths,
    verifyCommands: assembled.verifyCommands,
  };

  const dirtyEvidence: RunEvidence = {
    fileChanges: [
      { path: "D:\\proj\\src\\auth\\login.ts", changeKind: "update" },
      { path: "D:\\proj\\src\\other.ts", changeKind: "update" },
      { path: "D:\\other\\x.ts", changeKind: "update" },
      { path: "D:\\proj\\src\\legacy\\a.ts", changeKind: "update" },
      { path: "config.json", diff: "--- a/config.json\n+++ /dev/null\n" },
    ],
    commands: [
      { command: "pnpm test", exitCode: 0 },
      { command: "git push origin main", exitCode: 0 },
    ],
  };

  it("逐条复核证据，越界项按代码分类给出清单", () => {
    const result = auditRunEvidence(assembled.envelope, dirtyEvidence, auditOptions);
    expect(result.ok).toBe(false);
    expect(result.checkedFileChanges).toBe(5);
    expect(result.checkedCommands).toBe(2);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "write_outside_envelope",
      "path_outside_project",
      "forbidden_path",
      "dangerous_operation_unapproved",
      "dangerous_operation_unapproved",
    ]);
    expect(result.violations[0]?.reason).toContain("事后审计");
    expect(result.violations.at(-1)?.target).toEqual({
      kind: "command",
      command: "git push origin main",
    });
    expect(result.waived).toEqual([]);
  });

  it("干净的证据通过审计", () => {
    const result = auditRunEvidence(
      assembled.envelope,
      {
        fileChanges: [{ path: "D:\\proj\\src\\auth\\login.ts", changeKind: "update" }],
        commands: [{ command: "pnpm test", exitCode: 0 }],
      },
      auditOptions,
    );
    expect(result).toMatchObject({ ok: true, violations: [], checkedFileChanges: 1 });
  });

  it("已获逐次确认的危险操作不计违规（危险确认不落信封，须由编排层带入）", () => {
    const result = auditRunEvidence(assembled.envelope, dirtyEvidence, {
      ...auditOptions,
      approvedDangerousOperations: [
        { operation: "git_push" },
        { operation: "delete_outside_write_scope", detail: "config.json" },
      ],
    });
    expect(result.waived.map((violation) => violation.code)).toEqual([
      "dangerous_operation_unapproved",
      "dangerous_operation_unapproved",
    ]);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "write_outside_envelope",
      "path_outside_project",
      "forbidden_path",
    ]);
  });

  it("审批记录的 detail 不匹配时不豁免；写路径越界不可用危险审批豁免", () => {
    const result = auditRunEvidence(assembled.envelope, dirtyEvidence, {
      ...auditOptions,
      approvedDangerousOperations: [
        { operation: "delete_outside_write_scope", detail: "other.json" },
        { operation: "git_push", detail: "git push --force" },
      ],
    });
    expect(result.waived).toEqual([]);
    expect(result.violations).toHaveLength(5);
  });

  it("信封内已含用户批准的写路径不再报越界", () => {
    const granted = assembleRunEnvelope({
      role: "worker",
      taskContract: makeContract({ writeScope: ["src/auth"] }),
      grants: [{ kind: "write_path", path: "src/other.ts" }],
    }).envelope;
    const result = auditRunEvidence(
      granted,
      { fileChanges: [{ path: "D:\\proj\\src\\other.ts", changeKind: "update" }] },
      { cwd: PROJECT_ROOT },
    );
    expect(result.ok).toBe(true);
  });

  it("缺 changeKind 时从 diff 反推变更类型", () => {
    expect(inferFileChangeKind({ path: "a.ts", diff: "--- a/a.ts\n+++ /dev/null\n" })).toBe(
      "delete",
    );
    expect(inferFileChangeKind({ path: "a.ts", diff: "--- /dev/null\n+++ b/a.ts\n" })).toBe("add");
    expect(inferFileChangeKind({ path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n" })).toBe("update");
    expect(inferFileChangeKind({ path: "a.ts" })).toBe("update");
    expect(inferFileChangeKind({ path: "a.ts", changeKind: "delete", diff: "" })).toBe("delete");
  });

  it("Reviewer 的 Run 里出现文件修改一律是越界证据", () => {
    const reviewer = assembleRunEnvelope({
      role: "reviewer",
      taskContract: makeContract(),
    }).envelope;
    const result = auditRunEvidence(
      reviewer,
      { fileChanges: [{ path: "src/auth/login.ts", diff: "--- a/x\n+++ b/x\n" }] },
      { cwd: PROJECT_ROOT },
    );
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "write_outside_envelope",
    ]);
  });

  it("证据列表缺席时按空处理", () => {
    expect(auditRunEvidence(assembled.envelope, {})).toMatchObject({
      ok: true,
      checkedFileChanges: 0,
      checkedCommands: 0,
    });
  });
});

describe("运行时守卫", () => {
  it("字面量守卫拒绝未知值（IPC / JSON 边界复核）", () => {
    expect(isRunFileChangeKind("delete")).toBe(true);
    expect(isRunFileChangeKind("rename")).toBe(false);
    expect(isRunGuardViolationCode("forbidden_path")).toBe(true);
    expect(isRunGuardViolationCode("whatever")).toBe(false);
    expect(isRunEnvelopeStage("user_grant")).toBe(true);
    expect(isRunEnvelopeStage("role")).toBe(false);
  });
});
