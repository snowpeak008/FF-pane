/**
 * Run：某任务的一次实际尝试与其证据（设计文档 §6.4）。
 * Run 是可追溯的证据记录：文件修改、命令、验证结果全部落盘（§11.5 执行记录页）。
 */

import type {
  EpochMillis,
  KnowledgeChunkId,
  KnowledgeEntryId,
  ProfileId,
  RunId,
  TaskId,
} from "./common.js";
import { createLiteralGuard } from "./common.js";

/**
 * 设计文档 §6.4 —— end_reason 结束原因。
 *
 * `interrupted`（T8.2b 增补）：工作台自身退出或崩溃导致轮次被中断——CLI 子进程是被
 * FF-pane 连带终止的（T8.2 Job 嵌套语义，关应用即清场），不是它自己异常退出。
 * 与 `crashed` 分开记是为了让执行记录页能如实说明「这次不是 Agent 出错，是你关了应用」；
 * 对任务的联动两者同款（→ failed，可重试，见 core `RUN_END_TASK_LINKAGE`）。
 */
export const RUN_END_REASONS = [
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "interrupted",
] as const;

/** 设计文档 §6.4 —— Run 结束原因。 */
export type RunEndReason = (typeof RUN_END_REASONS)[number];

/** RunEndReason 运行时守卫。 */
export const isRunEndReason = createLiteralGuard(RUN_END_REASONS);

/**
 * 设计文档 §6.4 —— file_changes 条目：修改文件 + diff。
 * diff 为 unified diff 文本（新建/删除/改名同样以 diff 表达）；
 * 无法从事件流取得 diff 的 Runtime（如 Codex）由适配器用 git 快照采集（W2.3）。
 */
export interface FileChange {
  /** 修改的文件路径（相对项目根）。 */
  readonly path: string;
  /** unified diff 文本。 */
  readonly diff: string;
}

/**
 * 设计文档 §6.4 —— commands 条目：执行过的命令 + 退出码。
 * 命令的完整输出不入 Run 记录（体积不可控），归 raw_log_path 的原始日志。
 */
export interface CommandRecord {
  /** 执行的命令原文。 */
  readonly command: string;
  /** 退出码（适配器无法取得结构化退出码时按其映射规则推断，如 -1）。 */
  readonly exitCode: number;
}

/** 设计文档 §6.4 —— verify_result 验证命令输出。通过与否 = exitCode === 0。 */
export interface VerifyResult {
  /** 实际执行的验证命令（来自任务合同 verify_cmd，§6.2）。 */
  readonly command: string;
  /** 验证命令退出码。 */
  readonly exitCode: number;
  /** 验证命令输出（stdout + stderr 合并文本）。 */
  readonly output: string;
}

/**
 * 设计文档 §8.3.5 路径二 —— Agent 只读检索工具的一条命中（进 Run 审计）。
 *
 * 刻意只留「够在执行记录页说清命中了什么」的字段，不存整块正文：一次调用可命中
 * 十余块、一个 Run 可调用多次，全文入 run.json 会让记录体积随知识库规模漂移。
 * 正文取截断片段（snippet），要看全文经 chunkId 回知识库页查。
 */
export interface KnowledgeQueryHit {
  /** 命中块所属条目。 */
  readonly entryId: KnowledgeEntryId;
  /** 命中块。 */
  readonly chunkId: KnowledgeChunkId;
  /** 条目标题（避免执行记录页为显示一个名字去回查索引）。 */
  readonly title: string;
  /** 出处文件路径。 */
  readonly filePath: string;
  /** Markdown 标题层级路径（非 Markdown 缺省）。 */
  readonly headingPath?: readonly string[];
  /** PDF 页码（非 PDF 缺省）。 */
  readonly page?: number;
  /** RRF 融合分。 */
  readonly score: number;
  /** 块正文截断片段。 */
  readonly snippet: string;
}

/**
 * 设计文档 §8.3.5 路径二 —— Agent 一次只读检索工具调用的完整审计。
 *
 * 「Agent 每次调用了什么、命中了什么，在执行记录中全部可见」即本记录：
 * query/filters 是「调用了什么」，hits 是「命中了什么」。usedFts/usedVector
 * 如实记录本次实际走了哪几路——纯关键词检索是一等状态而非缺陷（§8.3.3），
 * 记下来才能解释「为什么这次没走语义」。
 */
export interface KnowledgeQueryRecord {
  /** 调用发生时间（epoch 毫秒）。 */
  readonly calledAt: EpochMillis;
  /** Agent 传入的查询串。 */
  readonly query: string;
  /** Agent 传入的过滤条件原样留档（无过滤时缺省）。 */
  readonly filters?: Readonly<Record<string, unknown>>;
  /** 本次请求的条数上限。 */
  readonly limit: number;
  /** 命中列表（按融合分降序）。 */
  readonly hits: readonly KnowledgeQueryHit[];
  /** 关键词路是否走了 FTS（false = 查询过短，回退 LIKE 子串扫描）。 */
  readonly usedFts: boolean;
  /** 向量路是否参与（未配嵌入模型 / 未建向量索引时为 false）。 */
  readonly usedVector: boolean;
  /** 调用耗时（毫秒）。 */
  readonly durationMs: number;
  /** 调用失败原因（成功时缺省）。失败的调用同样留档——排障要的正是它。 */
  readonly error?: string;
}

/** 设计文档 §3.1 —— Reviewer 的审查结论（T7.2）。 */
export const REVIEW_VERDICTS = ["pass", "fail", "inconclusive"] as const;

/**
 * 设计文档 §3.1 —— 审查结论。
 *
 * `inconclusive` 不是"Reviewer 弃权"这个罕见情形的专用值，而是**解析失败的归宿**：
 * Reviewer 没按合同给出结论块、或块里的 verdict 不是三者之一，一律落这里并保留原文。
 * 绝不从自由文本猜 pass/fail——两个方向的猜错代价不对称，把 fail 猜成 pass 会让一份
 * 没通过审查的改动看起来通过了。
 *
 * （审查轮本身没跑完——取消、崩溃、适配器报失败——则**不产生本记录**：那不是一次
 * 得不出结论的审查，而是一次没发生的审查，不该覆盖掉此前已有的结论。）
 */
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** ReviewVerdict 运行时守卫。 */
export const isReviewVerdict = createLiteralGuard(REVIEW_VERDICTS);

/**
 * 设计文档 §3.1 / §6.3 —— Reviewer 对某条 Run 的一次审查结论（T7.2）。
 *
 * **它不是一条 Run。** Run 的语义是"任务的一次实际尝试"（§6.4），审查不是尝试；
 * 更要紧的是 `completeTask` 的 done 门槛只认"本任务的一条 endReason=completed 的 Run"
 * ——若审查也铸一条 Run，审查者就能替执行者把任务盖成 done。故审查结论写回**被审的
 * 那条 Run**，Run 的 attempt 序号继续只数 Worker 的尝试。
 *
 * **它也不改变任务状态。** `acceptTask` 在状态机层就只认 actor="user"（§6.3 done ≠
 * accepted），Reviewer 的结论只是给用户的参考材料，通过与否都要用户自己点。
 */
export interface ReviewRecord {
  /** 结论产出时间（epoch 毫秒）。 */
  readonly reviewedAt: EpochMillis;
  /** 执行审查的 Agent Profile（审查者通常刻意不同于执行者，故必须留档）。 */
  readonly profileId: ProfileId;
  /** 结论。 */
  readonly verdict: ReviewVerdict;
  /** 结论理由（Reviewer 原文，Markdown）。verdict 无法解析时这里存整段答复。 */
  readonly summary: string;
  /**
   * 逐条问题（不通过时给出；通过时通常为空数组）。
   * 与 summary 分开存是为了让「有哪几处不合格」可以逐条显示与逐条核对，
   * 而不是让用户从一段散文里自己数。
   */
  readonly findings: readonly string[];
  /**
   * 审查期间实际跑过的命令 + 退出码。
   * Reviewer 的 shell 策略是 verify_only（§7），能跑的只有任务合同的 verify_cmd；
   * 留档是为了让「它到底验没验」可查——一份没跑过任何命令的 pass 与跑过的 pass
   * 是两种分量的结论。
   */
  readonly commands: readonly CommandRecord[];
}

/**
 * 设计文档 §6.4 —— Run（执行记录）：每次尝试一条。
 * 任务 failed 后重试即产生新 Run（§6.3），attempt 递增。
 */
export interface Run {
  /** Run 内部唯一 ID（存储目录 run-<id>，§10.2）。 */
  readonly id: RunId;
  /** 设计文档 §6.4 —— task_id 所属任务。 */
  readonly taskId: TaskId;
  /** 设计文档 §6.4 —— 序号：该任务的第几次尝试，从 1 起。 */
  readonly attempt: number;
  /** 设计文档 §6.4 —— profile 用哪个 Agent Profile 执行的。 */
  readonly profileId: ProfileId;
  /** 设计文档 §6.4 —— started 开始时间（epoch 毫秒）。 */
  readonly startedAt: EpochMillis;
  /** 设计文档 §6.4 —— ended 结束时间（执行中缺省）。 */
  readonly endedAt?: EpochMillis;
  /** 设计文档 §6.4 —— end_reason（执行中缺省，与 endedAt 同时出现）。 */
  readonly endReason?: RunEndReason;
  /** 设计文档 §6.4 —— file_changes 修改文件列表 + diff。 */
  readonly fileChanges: readonly FileChange[];
  /** 设计文档 §6.4 —— commands 执行过的命令 + 退出码。 */
  readonly commands: readonly CommandRecord[];
  /** 设计文档 §6.4 —— verify_result 验证命令输出（未跑验证时缺省）。 */
  readonly verifyResult?: VerifyResult;
  /** 设计文档 §6.4 —— report Worker 的完成报告（Markdown，未产出时缺省）。 */
  readonly report?: string;
  /**
   * 设计文档 §8.3.5 路径二 —— 本轮 Agent 对只读知识库检索工具的全部调用（按时间升序）。
   *
   * 缺省与空数组是两件事，界面据此给两种文案：**缺省 = 本轮没开这个工具**；
   * **空数组 = 开了但 Agent 一次没调用**。后者是有信息量的观察（工具开着却用不上），
   * 压成缺省就把它和「没开」混为一谈了。
   */
  readonly knowledgeQueries?: readonly KnowledgeQueryRecord[];
  /**
   * 设计文档 §3.1 —— Reviewer 对本次尝试的审查结论（T7.2；未审查过时缺省）。
   *
   * 只保留**最后一次**审查：同一条 Run 反复审查时后者覆盖前者。历史结论不留档，
   * 因为一条已结束的 Run 是不变的事实，对同一份不变事实的多次审查里，只有最新
   * 那次代表当前判断；留一串会让用户去猜"以哪条为准"。
   */
  readonly review?: ReviewRecord;
  /** 设计文档 §6.4 —— raw_log_path 原始日志文件路径（保留但不进主界面）。 */
  readonly rawLogPath: string;
}
