import type { DangerousOperation, PermissionEnvelope, ShellPolicy } from "@ff-pane/shared";
import { DANGEROUS_OPERATIONS, SHELL_POLICIES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  applyRunGrant,
  BUILTIN_DANGEROUS_COMMAND_RULES,
  type CommandVerdict,
  canRead,
  canWrite,
  classifyCommand,
  intersectEnvelopes,
  intersectScopeLists,
  intersectShellPolicies,
  isPathAllowedByScopes,
  normalizeCommandKey,
  normalizePathKey,
  PLANNER_DEFAULT_ENVELOPE,
  REVIEWER_DEFAULT_ENVELOPE,
  ROLE_DEFAULT_ENVELOPES,
  toRunEnvelope,
  WORKER_DEFAULT_ENVELOPE,
} from "../src/index.js";

/** 测试用信封工厂：默认全宽（read/write 项目内、shell allowed、网络关）。 */
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

const SHELL_RANK: Readonly<Record<ShellPolicy, number>> = {
  forbidden: 0,
  verify_only: 1,
  allowed: 2,
};

describe("角色默认信封（§7 表格）", () => {
  it("Planner：可读项目内 / 不可写 / shell 禁止 / 网络允许", () => {
    expect(PLANNER_DEFAULT_ENVELOPE).toEqual({
      readPaths: ["**"],
      writePaths: [],
      shell: "forbidden",
      network: true,
      dangerousOpsRequireApproval: true,
    });
  });

  it("Worker：可读项目内 / 可写上限项目内（由任务 write_scope 交集收窄）/ shell 允许 / 网络默认禁止", () => {
    expect(WORKER_DEFAULT_ENVELOPE).toEqual({
      readPaths: ["**"],
      writePaths: ["**"],
      shell: "allowed",
      network: false,
      dangerousOpsRequireApproval: true,
    });
  });

  it("Reviewer：可读项目内 / 不可写 / shell 仅验证命令 / 网络禁止", () => {
    expect(REVIEWER_DEFAULT_ENVELOPE).toEqual({
      readPaths: ["**"],
      writePaths: [],
      shell: "verify_only",
      network: false,
      dangerousOpsRequireApproval: true,
    });
  });

  it("角色表齐全且信封均被冻结，危险操作确认恒为 true", () => {
    expect(Object.keys(ROLE_DEFAULT_ENVELOPES).sort()).toEqual(["planner", "reviewer", "worker"]);
    for (const envelope of Object.values(ROLE_DEFAULT_ENVELOPES)) {
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(envelope.readPaths)).toBe(true);
      expect(envelope.dangerousOpsRequireApproval).toBe(true);
    }
  });
});

describe("路径归一化（Windows 比较键约定）", () => {
  const cases: readonly (readonly [string, string | null])[] = [
    ["SRC\\Auth\\", "src/auth"],
    ["src//a", "src/a"],
    ["./src/./a.ts", "src/a.ts"],
    ["src/../docs", "docs"],
    ["文档/设计", "文档/设计"],
    ["", ""],
    [".", ""],
    ["..", null],
    ["src/../..", null],
    ["C:\\Windows\\System32", null],
    ["/etc/passwd", null],
    ["\\\\server\\share", null],
    ["~/.ssh/id_rsa", null],
  ];
  it.each(cases)("normalizePathKey(%j) → %j", (input, expected) => {
    expect(normalizePathKey(input)).toBe(expected);
  });
});

describe("路径作用域交集", () => {
  it("子路径关系判定：取更窄者，无交集则空", () => {
    expect(intersectScopeLists(["**"], ["src"])).toEqual(["src"]);
    expect(intersectScopeLists(["src"], ["docs"])).toEqual([]);
    expect(intersectScopeLists(["src/**"], ["src/auth"])).toEqual(["src/auth"]);
    expect(intersectScopeLists(["SRC\\AUTH"], ["src/auth"])).toEqual(["src/auth"]);
    expect(intersectScopeLists(["src", "docs"], ["docs", "tests"])).toEqual(["docs"]);
    // glob 的全部匹配都在其静态前缀之下 → glob ⊆ 子树可证明
    expect(intersectScopeLists(["src/*.ts"], ["src"])).toEqual(["src/*.ts"]);
    // 无法证明包含关系（**/*.md 可匹配 docs 之外）→ 保守取空，只窄不宽
    expect(intersectScopeLists(["**/*.md"], ["docs"])).toEqual([]);
    // 无效条目（绝对路径）不贡献权限
    expect(intersectScopeLists(["C:\\abs", "src"], ["src"])).toEqual(["src"]);
    // 空数组 = 无该项权限
    expect(intersectScopeLists([], ["**"])).toEqual([]);
  });

  const SUBTREE_LISTS: readonly (readonly string[])[] = [
    [],
    ["**"],
    ["src"],
    ["src/**"],
    ["SRC\\Auth"],
    ["src/auth/tokens"],
    ["docs", "tests"],
    ["文档/设计"],
    ["src", "docs/**"],
    ["src/auth", "src/core", "readme.md"],
  ];
  const GLOB_LISTS: readonly (readonly string[])[] = [
    ["src/*.ts"],
    ["src/**/*.ts"],
    ["**/*.md"],
    ["src/*.ts", "docs"],
  ];
  const SAMPLE_PATHS: readonly string[] = [
    "",
    "src",
    "src/a.ts",
    "src/auth",
    "src/auth/x.ts",
    "src/auth/tokens/t.key",
    "src/core/deep/mod.ts",
    "docs/readme.md",
    "docs/api/idx.md",
    "tests/unit/a.test.ts",
    "readme.md",
    "文档/设计/说明.md",
    "文档/其他.md",
    "SRC\\AUTH\\Y.TS",
    "src/auth.ts",
    "other/z",
  ];

  it("性质：任意交集结果 ⊆ 每个输入（子树与 glob 全组合 × 样本路径）", () => {
    const allLists = [...SUBTREE_LISTS, ...GLOB_LISTS];
    for (const a of allLists) {
      for (const b of allLists) {
        const merged = intersectScopeLists(a, b);
        for (const path of SAMPLE_PATHS) {
          if (isPathAllowedByScopes(merged, path)) {
            expect(
              isPathAllowedByScopes(a, path),
              `${JSON.stringify(merged)} 放行 ${path}，但输入 ${JSON.stringify(a)} 不放行`,
            ).toBe(true);
            expect(
              isPathAllowedByScopes(b, path),
              `${JSON.stringify(merged)} 放行 ${path}，但输入 ${JSON.stringify(b)} 不放行`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("性质：纯子树作用域上交集精确（放行 ⟺ 两输入都放行）", () => {
    for (const a of SUBTREE_LISTS) {
      for (const b of SUBTREE_LISTS) {
        const merged = intersectScopeLists(a, b);
        for (const path of SAMPLE_PATHS) {
          const expected = isPathAllowedByScopes(a, path) && isPathAllowedByScopes(b, path);
          expect(
            isPathAllowedByScopes(merged, path),
            `${JSON.stringify(a)} ∩ ${JSON.stringify(b)} = ${JSON.stringify(merged)} 对 ${path} 判定应为 ${expected}`,
          ).toBe(expected);
        }
      }
    }
  });
});

describe("shell 策略与网络交集", () => {
  it("shell：最严者胜（forbidden < verify_only < allowed），结果 ⊆ 两输入", () => {
    for (const a of SHELL_POLICIES) {
      for (const b of SHELL_POLICIES) {
        const merged = intersectShellPolicies(a, b);
        expect(SHELL_RANK[merged]).toBe(Math.min(SHELL_RANK[a], SHELL_RANK[b]));
        expect([a, b]).toContain(merged);
      }
    }
  });

  it("网络：AND", () => {
    for (const a of [true, false]) {
      for (const b of [true, false]) {
        const merged = intersectEnvelopes(
          makeEnvelope({ network: a }),
          makeEnvelope({ network: b }),
        );
        expect(merged.network).toBe(a && b);
      }
    }
  });
});

describe("信封交集（§29 公式）", () => {
  const taskEnvelope = makeEnvelope({ writePaths: ["src/auth"], network: true });
  const narrowEnvelope = makeEnvelope({
    readPaths: ["docs"],
    writePaths: [],
    shell: "verify_only",
  });
  const wideEnvelope = makeEnvelope({ network: true });
  const ENVELOPES = [
    PLANNER_DEFAULT_ENVELOPE,
    WORKER_DEFAULT_ENVELOPE,
    REVIEWER_DEFAULT_ENVELOPE,
    taskEnvelope,
    narrowEnvelope,
    wideEnvelope,
  ];
  const PROBE_PATHS = ["src/auth/x.ts", "src/other.ts", "docs/readme.md", "readme.md"];

  it("性质：任意两信封交集，逐维 ⊆ 每个输入", () => {
    for (const a of ENVELOPES) {
      for (const b of ENVELOPES) {
        const merged = intersectEnvelopes(a, b);
        for (const path of PROBE_PATHS) {
          if (canRead(merged, path)) {
            expect(canRead(a, path) && canRead(b, path)).toBe(true);
          }
          if (canWrite(merged, path)) {
            expect(canWrite(a, path) && canWrite(b, path)).toBe(true);
          }
        }
        expect(SHELL_RANK[merged.shell]).toBeLessThanOrEqual(SHELL_RANK[a.shell]);
        expect(SHELL_RANK[merged.shell]).toBeLessThanOrEqual(SHELL_RANK[b.shell]);
        if (merged.network) {
          expect(a.network && b.network).toBe(true);
        }
        expect(merged.dangerousOpsRequireApproval).toBe(true);
      }
    }
  });

  it("委派只能缩小（v0.1 §23.6）：Worker 信封 ∩ 更宽信封 = Worker 信封", () => {
    expect(intersectEnvelopes(WORKER_DEFAULT_ENVELOPE, wideEnvelope)).toEqual(
      WORKER_DEFAULT_ENVELOPE,
    );
    expect(intersectEnvelopes(wideEnvelope, WORKER_DEFAULT_ENVELOPE)).toEqual(
      WORKER_DEFAULT_ENVELOPE,
    );
  });

  it("Worker 角色默认 ∩ 任务信封 = write_scope 收窄后的运行信封", () => {
    const merged = intersectEnvelopes(WORKER_DEFAULT_ENVELOPE, taskEnvelope);
    expect(merged.writePaths).toEqual(["src/auth"]);
    expect(merged.shell).toBe("allowed");
    // 角色默认网络禁止：任务开网不走交集，走用户批准通道（applyRunGrant）
    expect(merged.network).toBe(false);
  });

  it("Planner ∩ Worker：双向同构，逐维取最窄", () => {
    const expected = {
      readPaths: ["**"],
      writePaths: [],
      shell: "forbidden",
      network: false,
      dangerousOpsRequireApproval: true,
    };
    expect(intersectEnvelopes(PLANNER_DEFAULT_ENVELOPE, WORKER_DEFAULT_ENVELOPE)).toEqual(expected);
    expect(intersectEnvelopes(WORKER_DEFAULT_ENVELOPE, PLANNER_DEFAULT_ENVELOPE)).toEqual(expected);
  });

  it("多元交集与两两嵌套等价", () => {
    const chained = intersectEnvelopes(
      intersectEnvelopes(WORKER_DEFAULT_ENVELOPE, taskEnvelope),
      narrowEnvelope,
    );
    expect(intersectEnvelopes(WORKER_DEFAULT_ENVELOPE, taskEnvelope, narrowEnvelope)).toEqual(
      chained,
    );
  });
});

describe("裁决：canRead / canWrite（Windows 路径边角）", () => {
  it("大小写与反斜杠不敏感，子路径包含判定正确", () => {
    const envelope = makeEnvelope({ readPaths: ["SRC\\Auth"], writePaths: ["src"] });
    expect(canRead(envelope, "src/auth/x.ts")).toBe(true);
    expect(canRead(envelope, "SRC\\AUTH")).toBe(true);
    // 前缀边界："src/auth.ts" 与 "src/authx" 都不在 "src/auth" 子树内
    expect(canRead(envelope, "src/auth.ts")).toBe(false);
    expect(canRead(envelope, "src/authx/y")).toBe(false);
    expect(canWrite(envelope, "SRC\\deep\\file.ts")).toBe(true);
    expect(canWrite(envelope, "docs/x")).toBe(false);
  });

  it("中文路径", () => {
    const envelope = makeEnvelope({ readPaths: ["文档/说明"] });
    expect(canRead(envelope, "文档\\说明\\readme.md")).toBe(true);
    expect(canRead(envelope, "文档/其他.md")).toBe(false);
  });

  it("glob 作用域：* 不跨段，** 跨任意层级", () => {
    const envelope = makeEnvelope({ readPaths: ["src/**/*.ts"] });
    expect(canRead(envelope, "src/a/b.ts")).toBe(true);
    expect(canRead(envelope, "SRC\\A\\B.TS")).toBe(true);
    expect(canRead(envelope, "src/a/b.js")).toBe(false);
  });

  it("项目外路径一律拒绝：绝对路径、~、逃逸项目根", () => {
    const envelope = makeEnvelope();
    expect(canRead(envelope, "C:\\Windows\\hosts")).toBe(false);
    expect(canRead(envelope, "~/.ssh/id_rsa")).toBe(false);
    expect(canRead(envelope, "../other-project/x")).toBe(false);
    expect(canRead(envelope, "")).toBe(true);
  });

  it("空作用域 = 无该项权限（Planner 不可写）", () => {
    expect(canWrite(PLANNER_DEFAULT_ENVELOPE, "src/a.ts")).toBe(false);
  });
});

describe("applyRunGrant：单次批准叠加", () => {
  it("write_path 只放宽写维度，返回新信封且不改原件", () => {
    const before = {
      ...REVIEWER_DEFAULT_ENVELOPE,
      readPaths: [...REVIEWER_DEFAULT_ENVELOPE.readPaths],
      writePaths: [...REVIEWER_DEFAULT_ENVELOPE.writePaths],
    };
    const granted = applyRunGrant(REVIEWER_DEFAULT_ENVELOPE, {
      kind: "write_path",
      path: "Docs\\Notes",
    });
    expect(canWrite(granted, "docs/notes/a.md")).toBe(true);
    expect(canWrite(REVIEWER_DEFAULT_ENVELOPE, "docs/notes/a.md")).toBe(false);
    expect(granted).not.toBe(REVIEWER_DEFAULT_ENVELOPE);
    expect(Object.isFrozen(granted)).toBe(true);
    // 其余维度原样
    expect(granted.shell).toBe("verify_only");
    expect(granted.network).toBe(false);
    expect(granted.readPaths).toEqual(["**"]);
    expect(REVIEWER_DEFAULT_ENVELOPE).toEqual(before);
  });

  it("已覆盖的路径不重复追加", () => {
    const granted = applyRunGrant(WORKER_DEFAULT_ENVELOPE, { kind: "read_path", path: "src" });
    expect(granted.readPaths).toEqual(["**"]);
  });

  it("network 批准只打开网络", () => {
    const granted = applyRunGrant(WORKER_DEFAULT_ENVELOPE, { kind: "network" });
    expect(granted.network).toBe(true);
    expect(WORKER_DEFAULT_ENVELOPE.network).toBe(false);
    expect(granted.writePaths).toEqual(WORKER_DEFAULT_ENVELOPE.writePaths);
  });

  it("shell_command 批准进入本 Run 白名单，越过策略闸门", () => {
    const granted = applyRunGrant(PLANNER_DEFAULT_ENVELOPE, {
      kind: "shell_command",
      command: "pnpm  test",
    });
    expect(classifyCommand(granted, "pnpm test").verdict).toBe("allowed");
    expect(classifyCommand(granted, "pnpm build").verdict).toBe("denied");
    expect(classifyCommand(PLANNER_DEFAULT_ENVELOPE, "pnpm test").verdict).toBe("denied");
    // 重复批准不重复入列
    const again = applyRunGrant(granted, { kind: "shell_command", command: "pnpm test" });
    expect(again.grantedCommands).toEqual(["pnpm test"]);
  });

  it("白名单命令仍要过危险命令判定（批准不豁免危险操作）", () => {
    const granted = applyRunGrant(PLANNER_DEFAULT_ENVELOPE, {
      kind: "shell_command",
      command: "git push",
    });
    const result = classifyCommand(granted, "git push");
    expect(result.verdict).toBe("needs_approval");
    expect(result.dangerousOperations).toContain("git_push");
  });

  it("dangerous_operation 批准不落信封：抛错（逐次放行属运行时拦截层）", () => {
    expect(() =>
      applyRunGrant(WORKER_DEFAULT_ENVELOPE, {
        kind: "dangerous_operation",
        operation: "git_push",
        detail: "git push origin main",
      }),
    ).toThrow(/危险操作不产生任何豁免/);
    expect(WORKER_DEFAULT_ENVELOPE.dangerousOpsRequireApproval).toBe(true);
  });

  it("项目外路径的批准不落信封：抛 RangeError", () => {
    expect(() =>
      applyRunGrant(WORKER_DEFAULT_ENVELOPE, { kind: "read_path", path: "C:\\other\\x" }),
    ).toThrow(RangeError);
    expect(() =>
      applyRunGrant(WORKER_DEFAULT_ENVELOPE, { kind: "read_path", path: "../escape" }),
    ).toThrow(RangeError);
  });

  it("toRunEnvelope 幂等", () => {
    const run = toRunEnvelope(WORKER_DEFAULT_ENVELOPE);
    expect(toRunEnvelope(run)).toBe(run);
    expect(run.grantedCommands).toEqual([]);
  });
});

describe("classifyCommand：危险命令分类（表驱动）", () => {
  const workerOnSrc = makeEnvelope({ writePaths: ["src"] });

  interface Row {
    readonly name: string;
    readonly envelope: PermissionEnvelope;
    readonly command: string;
    readonly verdict: CommandVerdict;
    readonly operations?: readonly DangerousOperation[];
  }

  const rows: readonly Row[] = [
    { name: "普通命令放行", envelope: workerOnSrc, command: "pnpm test", verdict: "allowed" },
    {
      name: "git push（§7 固定清单）",
      envelope: workerOnSrc,
      command: "git push origin main",
      verdict: "needs_approval",
      operations: ["git_push"],
    },
    {
      name: "git push 在 forbidden 策略下直接拒绝",
      envelope: PLANNER_DEFAULT_ENVELOPE,
      command: "git push",
      verdict: "denied",
      operations: ["git_push"],
    },
    {
      name: "读取 .env（凭证路径黑名单）",
      envelope: workerOnSrc,
      command: "type .env",
      verdict: "needs_approval",
      operations: ["read_credential_paths"],
    },
    {
      name: "读取 ~/.ssh 私钥",
      envelope: workerOnSrc,
      command: "Get-Content ~/.ssh/id_rsa",
      verdict: "needs_approval",
      operations: ["read_credential_paths"],
    },
    {
      name: "删除 .git：同时命中修改 .git 与越界删除",
      envelope: workerOnSrc,
      command: "rm -rf .git",
      verdict: "needs_approval",
      operations: ["modify_git_dir", "delete_outside_write_scope"],
    },
    {
      name: "write_scope 内删除不算危险",
      envelope: workerOnSrc,
      command: "del /f /q src\\tmp\\a.txt",
      verdict: "allowed",
    },
    {
      name: "越界删除（逃逸项目根）",
      envelope: workerOnSrc,
      command: "del ..\\elsewhere\\x.txt",
      verdict: "needs_approval",
      operations: ["delete_outside_write_scope"],
    },
    {
      name: "PowerShell 删除 write_scope 之外目录",
      envelope: workerOnSrc,
      command: "Remove-Item -Recurse -Force dist",
      verdict: "needs_approval",
      operations: ["delete_outside_write_scope"],
    },
    {
      name: "包装器命令里的删除（npx rimraf）在范围内则放行",
      envelope: workerOnSrc,
      command: "npx rimraf src/tmp",
      verdict: "allowed",
    },
    {
      name: "引号包裹的子命令递归分析（绝对路径删除）",
      envelope: workerOnSrc,
      command: 'powershell -Command "Remove-Item C:\\Temp\\x"',
      verdict: "needs_approval",
      operations: ["delete_outside_write_scope"],
    },
    {
      name: "多段命令：安全删除 + git push",
      envelope: workerOnSrc,
      command: "rm src/old.ts && git push",
      verdict: "needs_approval",
      operations: ["git_push"],
    },
    {
      name: "系统包管理器安装",
      envelope: workerOnSrc,
      command: "winget install foo",
      verdict: "needs_approval",
      operations: ["install_system_software"],
    },
    {
      name: "npm 全局安装",
      envelope: workerOnSrc,
      command: "npm install -g typescript",
      verdict: "needs_approval",
      operations: ["install_system_software"],
    },
    {
      name: "apt-get 安装",
      envelope: workerOnSrc,
      command: "apt-get install -y jq",
      verdict: "needs_approval",
      operations: ["install_system_software"],
    },
    {
      name: "npm publish（发布）",
      envelope: workerOnSrc,
      command: "pnpm publish --access public",
      verdict: "needs_approval",
      operations: ["publish_or_deploy"],
    },
    {
      name: "docker push（发布）",
      envelope: workerOnSrc,
      command: "docker push registry.example.com/img:v1",
      verdict: "needs_approval",
      operations: ["publish_or_deploy"],
    },
    {
      name: "gh release（发布）",
      envelope: workerOnSrc,
      command: "gh release create v1.0.0",
      verdict: "needs_approval",
      operations: ["publish_or_deploy"],
    },
    {
      name: "terraform apply（部署）",
      envelope: workerOnSrc,
      command: "terraform apply",
      verdict: "needs_approval",
      operations: ["publish_or_deploy"],
    },
    {
      name: "forbidden 策略下普通命令也拒绝",
      envelope: PLANNER_DEFAULT_ENVELOPE,
      command: "dir",
      verdict: "denied",
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const result = classifyCommand(row.envelope, row.command);
    expect(result.verdict, `命令 ${JSON.stringify(row.command)} 判定 ${result.reason}`).toBe(
      row.verdict,
    );
    for (const operation of row.operations ?? []) {
      expect(result.dangerousOperations).toContain(operation);
    }
  });

  it("verify_only：仅任务合同验证命令放行（整串比对、空白折叠）", () => {
    const options = { verifyCommands: ["pnpm test"] };
    expect(classifyCommand(REVIEWER_DEFAULT_ENVELOPE, "pnpm  test", options).verdict).toBe(
      "allowed",
    );
    expect(classifyCommand(REVIEWER_DEFAULT_ENVELOPE, "pnpm build", options).verdict).toBe(
      "denied",
    );
    expect(classifyCommand(REVIEWER_DEFAULT_ENVELOPE, "git push", options).verdict).toBe("denied");
  });

  it("可配置模式清单：extraRules 追加，内置规则不受影响", () => {
    const options = {
      extraRules: [
        {
          id: "corp-deploy",
          pattern: /\bcorp-deploy\b/i,
          operation: "publish_or_deploy" as const,
        },
      ],
    };
    const result = classifyCommand(workerOnSrc, "corp-deploy --env prod", options);
    expect(result.verdict).toBe("needs_approval");
    expect(result.matchedRules).toContain("corp-deploy");
    expect(classifyCommand(workerOnSrc, "git push", options).verdict).toBe("needs_approval");
  });

  it("目标解析不出的删除命令按危险处理（宁严勿松）", () => {
    const result = classifyCommand(workerOnSrc, "rm -rf");
    expect(result.verdict).toBe("needs_approval");
    expect(result.dangerousOperations).toContain("delete_outside_write_scope");
  });

  it("引号内的删除词不误报（如 commit message）", () => {
    const result = classifyCommand(workerOnSrc, 'git commit -m "rm old code"');
    expect(result.verdict).toBe("allowed");
  });

  it("内置规则完整性：operation 均属固定清单，pattern 不带 g 标志", () => {
    for (const rule of BUILTIN_DANGEROUS_COMMAND_RULES) {
      expect(DANGEROUS_OPERATIONS).toContain(rule.operation);
      expect(rule.pattern.flags).not.toContain("g");
    }
    const coveredOperations = new Set(
      BUILTIN_DANGEROUS_COMMAND_RULES.map((rule) => rule.operation),
    );
    // delete_outside_write_scope 由删除目标分析承担，不在静态规则内
    for (const operation of DANGEROUS_OPERATIONS) {
      if (operation !== "delete_outside_write_scope") {
        expect([...coveredOperations], `固定清单 ${operation} 应有内置规则覆盖`).toContain(
          operation,
        );
      }
    }
  });

  it("命令比较键：trim + 空白折叠，区分大小写", () => {
    expect(normalizeCommandKey("  pnpm   test  ")).toBe("pnpm test");
    expect(normalizeCommandKey("PNPM test")).not.toBe("pnpm test");
  });
});
