/**
 * T7.2 Reviewer 单测：审查材料组装（assembleReviewMaterial）+ 结论解析（parseReviewConclusion）。
 * 两者都是纯函数，无 IO、无时钟。
 */

import type { Run, Task } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assembleReviewMaterial,
  canRead,
  canWrite,
  DEFAULT_DIFF_BUDGET,
  intersectEnvelopes,
  parseReviewConclusion,
  REVIEW_OUTPUT_CONTRACT,
  REVIEWER_DEFAULT_ENVELOPE,
  WORKER_DEFAULT_ENVELOPE,
} from "../src/index.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    planVersion: 1,
    goal: "把登录接口接上",
    writeScope: ["src/auth/**"],
    forbidden: ["不要动数据库迁移"],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["登录成功返回 token", "密码错误返回 401"],
    ...overrides,
  } as unknown as Task;
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    profileId: "prof-w",
    startedAt: 1,
    endedAt: 2,
    endReason: "completed",
    fileChanges: [{ path: "src/auth/login.ts", diff: "@@ -1 +1 @@\n-a\n+b" }],
    commands: [{ command: "npm test", exitCode: 0 }],
    report: "接好了",
    rawLogPath: "raw.log",
    ...overrides,
  } as unknown as Run;
}

describe("assembleReviewMaterial（审查材料）", () => {
  it("带上验收标准、禁止事项、可写范围与 diff", () => {
    const text = assembleReviewMaterial({ task: task(), run: run() });
    expect(text).toContain("登录成功返回 token");
    expect(text).toContain("密码错误返回 401");
    expect(text).toContain("不要动数据库迁移");
    expect(text).toContain("src/auth/**");
    expect(text).toContain("@@ -1 +1 @@");
  });

  it("完成报告标注为 Worker 自述而非证据（免得审查者拿它当已核实的事实）", () => {
    const text = assembleReviewMaterial({ task: task(), run: run() });
    expect(text).toContain("它自己的说法，非证据");
    expect(text).toContain("接好了");
  });

  it("没有验收标准 → 不含糊过去，明确要求把这件事作为 findings 报出来", () => {
    const text = assembleReviewMaterial({ task: task({ acceptance: [] }), run: run() });
    expect(text).toContain("不要凭感觉判断");
    expect(text).toContain("inconclusive");
  });

  it("合同有 verifyCmd 但本次执行没留验证结果 → 如实说明「没有」", () => {
    const text = assembleReviewMaterial({
      task: task({ verifyCmd: "npm test" }),
      run: run(),
    });
    expect(text).toContain("没有**验证结果留档");
  });

  it("有验证结果 → 带出命令、退出码与输出", () => {
    const text = assembleReviewMaterial({
      task: task({ verifyCmd: "npm test" }),
      run: run({ verifyResult: { command: "npm test", exitCode: 1, output: "2 failed" } }),
    });
    expect(text).toContain("退出码 1");
    expect(text).toContain("未通过");
    expect(text).toContain("2 failed");
  });

  it("没有文件改动 → 如实写明，而不是留一个空节", () => {
    const text = assembleReviewMaterial({ task: task(), run: run({ fileChanges: [] }) });
    expect(text).toContain("没有产生文件修改");
  });

  it("diff 超预算 → 整文件略过并写明略过了几个（审查者必须知道自己只看到一部分）", () => {
    const big = "x".repeat(200);
    const text = assembleReviewMaterial({
      task: task(),
      run: run({
        fileChanges: [
          { path: "a.ts", diff: big },
          { path: "b.ts", diff: big },
          { path: "c.ts", diff: big },
        ],
      }),
      diffBudget: 250,
    });
    expect(text).toContain("a.ts");
    expect(text).toContain("另有 2 个文件");
    expect(text).not.toContain("c.ts");
  });

  it("预算再小也至少收一个文件（否则整份材料一个 diff 都没有，等于没审）", () => {
    const text = assembleReviewMaterial({
      task: task(),
      run: run({ fileChanges: [{ path: "a.ts", diff: "y".repeat(999) }] }),
      diffBudget: 1,
    });
    expect(text).toContain("a.ts");
    expect(text).not.toContain("另有");
  });

  it("确定性：同一对 (任务, Run) 恒渲染出同一段文本", () => {
    const input = { task: task(), run: run() };
    expect(assembleReviewMaterial(input)).toBe(assembleReviewMaterial(input));
  });

  it("默认预算是个有限值（不设上限等于把整轮赌在上下文窗口上）", () => {
    expect(DEFAULT_DIFF_BUDGET).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_DIFF_BUDGET)).toBe(true);
  });
});

describe("parseReviewConclusion（结论解析）", () => {
  it("解析结构化结论块", () => {
    const parsed = parseReviewConclusion(
      '前言。\n```json\n{"verdict":"fail","summary":"401 那条没做","findings":["缺 401 分支"]}\n```',
    );
    expect(parsed).toEqual({
      verdict: "fail",
      summary: "401 那条没做",
      findings: ["缺 401 分支"],
    });
  });

  it("容忍无语言标签的裸围栏块（漏写 ```json 是最高频的格式偏差）", () => {
    const parsed = parseReviewConclusion('```\n{"verdict":"pass","summary":"都满足了"}\n```');
    expect(parsed.verdict).toBe("pass");
    expect(parsed.findings).toEqual([]);
  });

  it("取最后一个块：模型常先举例说明格式，再给真结果", () => {
    const parsed = parseReviewConclusion(
      '格式如下：\n```json\n{"verdict":"pass","summary":"示例"}\n```\n' +
        '我的结论：\n```json\n{"verdict":"fail","summary":"真结论"}\n```',
    );
    expect(parsed).toMatchObject({ verdict: "fail", summary: "真结论" });
  });

  it.each([
    ["没有块", "我觉得挺好的"],
    ["JSON 非法", "```json\n{verdict: pass}\n```"],
    ["顶层不是对象", '```json\n["pass"]\n```'],
    ["verdict 不在三态内", '```json\n{"verdict":"maybe","summary":"呃"}\n```'],
    ["verdict 缺失", '```json\n{"summary":"呃"}\n```'],
  ])("%s → inconclusive 并保留原文（绝不猜 pass/fail）", (_label, answer) => {
    const parsed = parseReviewConclusion(answer);
    expect(parsed.verdict).toBe("inconclusive");
    expect(parsed.summary).toBe(answer.trim());
    expect(parsed.findings).toEqual([]);
  });

  it("verdict 大小写不敏感（模型写 PASS 不该被判成无结论）", () => {
    expect(parseReviewConclusion('```json\n{"verdict":"PASS","summary":"ok"}\n```').verdict).toBe(
      "pass",
    );
  });

  it("verdict 合法但缺 summary → 结论作数，理由退回原文（原文里通常正写着理由）", () => {
    const answer = '理由在这儿。\n```json\n{"verdict":"fail"}\n```';
    const parsed = parseReviewConclusion(answer);
    expect(parsed.verdict).toBe("fail");
    expect(parsed.summary).toBe(answer.trim());
  });

  it("findings 里的空白项被丢弃、非字符串被忽略", () => {
    const parsed = parseReviewConclusion(
      '```json\n{"verdict":"fail","summary":"s","findings":["a","  ",3,"b"]}\n```',
    );
    expect(parsed.findings).toEqual(["a", "b"]);
  });

  it("整段空白 → inconclusive，且 summary 不是空串（界面要有话可显示）", () => {
    const parsed = parseReviewConclusion("   \n  ");
    expect(parsed.verdict).toBe("inconclusive");
    expect(parsed.summary.length).toBeGreaterThan(0);
  });

  it("永不抛错：任何输入都得出一个结论", () => {
    for (const answer of ["", "```json\n```", "```json\nnull\n```", "{}"]) {
      expect(() => parseReviewConclusion(answer)).not.toThrow();
    }
  });
});

describe("Reviewer 结论合同与权限（§3.1 / §7）", () => {
  it("合同写明三态与只读约束", () => {
    expect(REVIEW_OUTPUT_CONTRACT).toContain("pass");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("fail");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("inconclusive");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("不要修改任何文件");
  });

  it("角色默认信封：不可写 / shell 仅验证命令 / 网络禁止（§7 角色默认表）", () => {
    expect(REVIEWER_DEFAULT_ENVELOPE.writePaths).toEqual([]);
    expect(REVIEWER_DEFAULT_ENVELOPE.shell).toBe("verify_only");
    expect(REVIEWER_DEFAULT_ENVELOPE.network).toBe(false);
  });

  it("与全开的 Worker 预设相交后依然不可写、依然只跑验证命令", () => {
    // 编排器给审查轮算的正是这个交集。Profile 预设再宽也放不宽——交集只会变窄（§29）。
    const merged = intersectEnvelopes(REVIEWER_DEFAULT_ENVELOPE, WORKER_DEFAULT_ENVELOPE);
    expect(merged.writePaths).toEqual([]);
    expect(merged.shell).toBe("verify_only");
    expect(merged.network).toBe(false);
    expect(canWrite(merged, "src/a.ts")).toBe(false);
    // 只读那一维保留：审查者当然要能读项目
    expect(canRead(merged, "src/a.ts")).toBe(true);
  });
});
