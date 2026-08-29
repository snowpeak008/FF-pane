/**
 * 适配器侧运行时权限拦截桥接（W2.7b）barrel。
 *
 * 唯一消费方是 Phase 4 的编排层，用法：
 *
 * ```ts
 * const assembled = assembleRunEnvelope({ role, taskContract, grants });   // core，W2.7a
 * const injected = buildGuardedEnv({ OPENAI_API_KEY: plaintext });         // 密钥唯一通道
 * const turn = adapter.startTurn({ cwd: projectRoot, prompt, env: injected.env });
 * const guarded = guardTurn(turn, {
 *   cwd: projectRoot,                          // 必须与 startTurn 的 cwd 一致
 *   envelope: assembled.envelope,
 *   forbiddenPaths: assembled.forbiddenPaths,  // 原样展开，不要自己解析任务合同
 *   verifyCommands: assembled.verifyCommands,
 *   secrets: injected.secrets,                 // 仅用于事件文本兜底遮蔽
 * });
 * for await (const event of guarded.events) { ... }   // permission_request → 交用户
 * const audit = guarded.auditResult();                // end 之后必有值
 * ```
 *
 * 三条关键决策的出处（Phase 4 接线前必读）：
 * - 自动应答的边界与两条路径的分野 → `types.ts` 文件头；
 * - 取消语义（cancelOnViolation / cancelOnDeny 的默认值与理由）→ `types.ts` 的取消语义表；
 * - end 收敛策略（何时降级、原文如何留档）→ `evidence.ts` 文件头。
 */

export {
  annotateGuardEnd,
  auditGuardEvidence,
  commandEvidenceOf,
  fileChangeEvidenceOf,
  type GuardEndAnnotation,
  type GuardEndFacts,
  runtimeBlockageOf,
  summarizeGuardFacts,
  toStoredRunEvidence,
  UNKNOWN_EXIT_CODE,
} from "./evidence.js";
export { guardTurn } from "./guard-turn.js";
export {
  type GuardFileChangeTarget,
  type GuardJudgeContext,
  judgeGuardCommand,
  judgeGuardFileChange,
  judgeGuardNetwork,
  judgeGuardPayload,
  judgeGuardRead,
  resolveGuardChangeKind,
  toGuardJudgeContext,
} from "./judge.js";
export {
  buildGuardedEnv,
  type GuardedEnv,
  guardSecretPlaceholder,
  MIN_MASKED_SECRET_LENGTH,
  maskGuardEvent,
  maskGuardText,
} from "./secrets.js";
export {
  GUARD_EVENT_TYPES,
  GUARD_INTERCEPTION_LEVELS,
  GUARD_INTERCEPTION_OUTCOMES,
  GUARD_REQUEST_ORIGINS,
  GUARD_RUNTIME_ID,
  GuardError,
  type GuardEventType,
  type GuardEvidenceCommand,
  type GuardEvidenceFileChange,
  type GuardedTurn,
  type GuardInterception,
  type GuardInterceptionLevel,
  type GuardInterceptionOutcome,
  type GuardJudgement,
  type GuardOptions,
  type GuardRequestOrigin,
  type GuardRunEvidence,
  type GuardTurnContext,
  isGuardEventType,
  isGuardInterceptionLevel,
  isGuardInterceptionOutcome,
  isGuardProducedEvent,
  isGuardRequestOrigin,
  isSelfProducedRequestId,
  SELF_PRODUCED_REQUEST_PREFIX,
  type StoredRunEvidence,
} from "./types.js";
