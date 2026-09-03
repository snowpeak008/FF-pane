/**
 * 会话执行发起助手（T4.2）：把「生成 turnId → 预置本地轮 → session:start」三步收成
 * 一处，供会话页（Planner 讨论）与任务页（Worker 派发）复用。
 *
 * 事件流由全局 SessionEventBridge 唯一订阅并归并进 session store；本模块只负责发起、
 * 回执权限、取消，不订阅事件。
 */

import type { LocalSessionId, ProfileId } from "@ff-pane/shared";
import type { SessionInput, StartSessionAck } from "../../../shared-ipc/contracts";
import { invokeQuery } from "../ipc/query";
import { useSessionStore } from "../stores/session";

/** 生成一个轮次关联 ID（安全上下文下的 UUID）。 */
function newTurnId(): string {
  return crypto.randomUUID();
}

/**
 * 发起一轮会话执行。返回受理结果；未受理 / IPC 失败时该轮已从在飞表移除
 * （T8.3b：被拒轮不留占位），可见反馈由调用方据返回值 toast——拒绝原因在
 * `ack.reason`（互斥拒绝另有 `ack.conflicts` 明细），IPC 错误在 `errorMessage`。
 */
export async function startSessionTurn(params: {
  readonly projectRoot: string;
  readonly profileId: ProfileId;
  readonly input: SessionInput;
  /**
   * 续接的本地会话 ID（T4.3）。缺省 = 开新会话。会话页跟进发言传当前会话以续接；
   * 从恢复列表选中的会话亦经此传入触发原生恢复 / 上下文重建。
   */
  readonly sessionId?: LocalSessionId;
  /**
   * 跨 Agent 交接包正文（T7.1，§10.4）：用户在预览框里确认过的那一份。
   * 给出即表示本轮是迁移——主进程强制开新会话并把它前置到提示词，故与 sessionId 互斥
   * （同时传入时 sessionId 被忽略，新 Agent 续不上旧 Agent 的会话）。
   */
  readonly handoffText?: string;
}): Promise<{
  readonly turnId: string;
  readonly ack: StartSessionAck | null;
  /** IPC 层错误原文（ack === null 时给出）。 */
  readonly errorMessage?: string;
}> {
  const turnId = newTurnId();
  const role = params.input.kind === "worker-task" ? "worker" : "planner";
  const store = useSessionStore.getState();
  // 用户可见输入进历史消息（T8.2b-b）：讨论/计划补充指令是用户敲的那段话，与主进程
  // transcript 的 user_message 同语义；worker/审查轮的"输入"是任务合同，任务页已可见，不重复。
  const userText =
    params.input.kind === "planner-message" || params.input.kind === "planner-plan"
      ? params.input.text
      : undefined;
  store.startLocalTurn(turnId, role, userText);

  const settled = await invokeQuery("session:start", {
    turnId,
    projectRoot: params.projectRoot,
    profileId: params.profileId,
    input: params.input,
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.handoffText !== undefined ? { handoffText: params.handoffText } : {}),
  });
  if (settled.status === "error") {
    store.failLocalTurn(turnId, settled.error.message);
    return { turnId, ack: null, errorMessage: settled.error.message };
  }
  if (!settled.data.accepted) {
    store.failLocalTurn(turnId, settled.data.reason);
  }
  return { turnId, ack: settled.data };
}

/** 回执一条权限请求，并清空该轮的本地待批准态（多轮并发时按 turnId 路由，T8.3b）。 */
export async function respondSessionPermission(params: {
  readonly turnId: string;
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}): Promise<void> {
  useSessionStore.getState().clearPendingPermission(params.turnId);
  await invokeQuery("session:respond-permission", params);
}

/** 取消在飞的一轮。 */
export async function cancelSessionTurn(turnId: string): Promise<void> {
  await invokeQuery("session:cancel", { turnId });
}
