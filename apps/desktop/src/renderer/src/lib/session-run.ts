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
 * 发起一轮会话执行。返回受理结果；未受理时已把该轮标记为失败（页面据 store 呈现）。
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
}): Promise<{ readonly turnId: string; readonly ack: StartSessionAck | null }> {
  const turnId = newTurnId();
  const role = params.input.kind === "planner-message" ? "planner" : "worker";
  const store = useSessionStore.getState();
  store.startLocalTurn(turnId, role);

  const settled = await invokeQuery("session:start", {
    turnId,
    projectRoot: params.projectRoot,
    profileId: params.profileId,
    input: params.input,
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
  });
  if (settled.status === "error") {
    store.failLocalTurn(turnId, settled.error.message);
    return { turnId, ack: null };
  }
  if (!settled.data.accepted) {
    store.failLocalTurn(turnId, settled.data.reason);
  }
  return { turnId, ack: settled.data };
}

/** 回执一条权限请求，并清空本地待批准态。 */
export async function respondSessionPermission(params: {
  readonly turnId: string;
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}): Promise<void> {
  useSessionStore.getState().clearPendingPermission();
  await invokeQuery("session:respond-permission", params);
}

/** 取消在飞的一轮。 */
export async function cancelSessionTurn(turnId: string): Promise<void> {
  await invokeQuery("session:cancel", { turnId });
}
