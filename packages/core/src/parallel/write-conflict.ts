/**
 * writePaths 互斥核查纯函数（T8.3a，设计文档 §14 M3「文件范围不重叠的任务同时派发」）。
 *
 * 回答一个问题：候选任务的可写范围与在飞任务集是否可证明不相交——
 * 可证明不相交才允许并行；相交或**无法证明不相交**一律拒绝，并给出人可读的
 * 相交原因（哪两个任务、哪两条路径、相同还是包含还是保守判定）。
 *
 * ## 路径语义（与权限层同一套，复用 permission/paths.ts）
 * 条目经 parsePathScope 折算为比较键再参与判定：大小写不敏感（Windows 现实）、
 * `\` 归一为 `/`、丢弃空段与 `.`、包含判定以路径段为界（`src/app` 与 `src/app2`
 * 不相交）。子树条目（如 `src/app`、`src/**`）= 该路径整个子树；含 `*`/`?` 的
 * glob 条目的全部匹配必然落在其静态前缀子树内，借此给出不相交的充分条件。
 *
 * ## 空 writePaths 的语义（仓内既定，T8.3a 落档）
 * 空数组 = **无写权限**（shared/domain/permission.ts「空数组 = 无该项权限」、
 * run-guard/assemble.ts「空数组 = 本任务不可写」）——不是「全项目写」。
 * 一个什么都不能写的任务（如 Planner 讨论轮、纯咨询任务）与任何任务都不相交，
 * 恒可并行。工单缺省假设（空 = 全项目写）与仓内语义相反，按工单指示以仓内为准。
 *
 * ## 无效条目的口径（`..` 攀升 / 绝对路径 / `~`，T8.3a 落档）
 * 与权限层一致（宁窄勿宽）：parsePathScope 判无效的条目**不贡献任何写权限**，
 * 权限层不会放行对它的写入——一个写不进去的条目自然也不产生互斥。含 `..` 或
 * 项目外形态的条目在互斥核查中被跳过，全部条目无效时等价于空 writePaths。
 *
 * ## 判定方向（与 intersectScopeLists 相反，各自都对）
 * 交集计算「无法证明包含 → 按空交处理」是宁窄勿宽（权限只会更小）；
 * 互斥核查「无法证明不相交 → 拒绝并行」是宁拒勿并（并行只会更少）。
 * 两个方向都把不确定性折向安全侧，只是安全侧不同。
 */

import {
  type PathScope,
  parsePathScope,
  renderPathScope,
  scopeWithinScope,
} from "../permission/index.js";

/**
 * 两条 writePaths 条目的重叠关系：
 * - identical —— 归一化后相同（含 `SRC\\APP` vs `src/app` 这类写法差异）；
 * - containment —— 一方可证明包含另一方（子树祖先关系，或 glob ⊆ 子树）；
 * - may-overlap —— 无法证明不相交的保守判定（glob 参与且静态前缀子树相交，
 *   但既非相同也证不出包含）。并行裁决对三者同等对待（拒绝），区分只为把
 *   原因讲清楚——「保守判定」提示用户收窄通配模式即可能解除误拒。
 */
export const WRITE_OVERLAP_RELATIONS = ["identical", "containment", "may-overlap"] as const;

/** writePaths 条目重叠关系。 */
export type WriteOverlapRelation = (typeof WRITE_OVERLAP_RELATIONS)[number];

/** 子树底座（子树取 base，glob 取静态前缀）；glob 的全部匹配都在其底座子树内。 */
function scopeFloor(scope: PathScope): string {
  return scope.kind === "subtree" ? scope.base : scope.staticPrefix;
}

/** 两个子树底座是否以路径段为界不相交（"" = 项目根，覆盖一切，恒相交）。 */
function floorsDisjoint(a: string, b: string): boolean {
  if (a === "" || b === "") {
    return false;
  }
  return a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
}

/**
 * 两条 writePaths 条目的重叠判定。返回 null = **可证明**不相交（可并行的依据）；
 * 无效条目（`..` / 项目外形态）不贡献写权限，视为与一切不相交（文件头口径）。
 */
export function detectScopeOverlap(entryA: string, entryB: string): WriteOverlapRelation | null {
  const scopeA = parsePathScope(entryA);
  const scopeB = parsePathScope(entryB);
  if (scopeA === null || scopeB === null) {
    return null;
  }
  if (renderPathScope(scopeA) === renderPathScope(scopeB)) {
    return "identical";
  }
  if (scopeA.kind === "subtree" && scopeB.kind === "subtree") {
    // 子树×子树是可判定的：不是祖先关系就是不相交，没有第三种
    return floorsDisjoint(scopeA.base, scopeB.base) ? null : "containment";
  }
  // glob 参与：底座子树不相交 ⇒ 匹配集不相交（glob 匹配 ⊆ 静态前缀子树）
  if (floorsDisjoint(scopeFloor(scopeA), scopeFloor(scopeB))) {
    return null;
  }
  if (scopeWithinScope(scopeA, scopeB) || scopeWithinScope(scopeB, scopeA)) {
    return "containment";
  }
  return "may-overlap";
}

/** 互斥核查的参与者：一个带可写范围的任务（或轮次）。 */
export interface ParallelWriteTask {
  /** 展示标识（任务 ID / 轮次 ID），进入拒绝原因文本。 */
  readonly id: string;
  /** 可写路径条目（任务合同 writeScope / 信封 writePaths 语义）。 */
  readonly writePaths: readonly string[];
}

/** 一处相交：候选与某个在飞任务的某两条路径。 */
export interface WritePathsConflict {
  readonly candidateId: string;
  readonly inflightId: string;
  /** 相交的候选侧条目（原文，供展示）。 */
  readonly candidatePath: string;
  /** 相交的在飞侧条目（原文，供展示）。 */
  readonly inflightPath: string;
  readonly relation: WriteOverlapRelation;
  /** 人可读的相交原因（哪两个任务、哪两条路径、何种关系）。 */
  readonly reason: string;
}

/** 互斥核查结论：可并行，或拒绝并给出全部相交明细。 */
export type ParallelWriteDecision =
  | { readonly canRunInParallel: true }
  | { readonly canRunInParallel: false; readonly conflicts: readonly WritePathsConflict[] };

const RELATION_PHRASES: Readonly<Record<WriteOverlapRelation, string>> = Object.freeze({
  identical: "指向相同范围",
  containment: "存在包含关系（一方是另一方的前缀路径）",
  "may-overlap": "无法证明不相交（通配模式保守判定，收窄模式可解除）",
});

/** 组装一条相交明细（reason 由其余字段派生；供本模块与 active-turns 的轮级核查共用）。 */
export function createWritePathsConflict(
  fields: Omit<WritePathsConflict, "reason">,
): WritePathsConflict {
  return {
    ...fields,
    reason:
      `任务 ${fields.candidateId} 的可写路径「${fields.candidatePath}」` +
      `与在飞任务 ${fields.inflightId} 的「${fields.inflightPath}」` +
      RELATION_PHRASES[fields.relation],
  };
}

/**
 * writePaths 互斥核查（T8.3a 定稿的并行裁决纯函数）。
 *
 * 候选与每个在飞任务逐条目比对，收齐**全部**相交明细（不止第一处——用户要一次
 * 看到所有拦路的范围，而不是修一条再被下一条拒绝）。与候选同 id 的在飞条目跳过
 * （自反：一个任务不与自己互斥——重试 / 重入场景不该被自己挡住）。
 * 空（或全无效）writePaths 的一方与任何任务可并行（语义见文件头）。
 */
export function checkWritePathsExclusive(
  candidate: ParallelWriteTask,
  inflight: readonly ParallelWriteTask[],
): ParallelWriteDecision {
  const conflicts: WritePathsConflict[] = [];
  for (const other of inflight) {
    if (other.id === candidate.id) {
      continue;
    }
    for (const candidatePath of candidate.writePaths) {
      for (const inflightPath of other.writePaths) {
        const relation = detectScopeOverlap(candidatePath, inflightPath);
        if (relation === null) {
          continue;
        }
        conflicts.push(
          createWritePathsConflict({
            candidateId: candidate.id,
            inflightId: other.id,
            candidatePath,
            inflightPath,
            relation,
          }),
        );
      }
    }
  }
  return conflicts.length === 0
    ? { canRunInParallel: true }
    : { canRunInParallel: false, conflicts };
}
