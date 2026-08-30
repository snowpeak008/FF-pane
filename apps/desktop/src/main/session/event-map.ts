/**
 * 适配器事件 → 渲染层会话事件的纯映射（T4.2）。
 *
 * 适配器吐出的 AgentEvent（events/types.ts，七类）经此折算为扁平的
 * SessionStreamEvent（contracts.ts）推给渲染层。本模块只处理"增量内容类"事件
 * （text / file_change / command / permission_request）——
 * session_start（原生会话绑定）与 end（需附 runId）由编排器显式处理，故此返回 null；
 * raw 兜底事件不进 UI，同样返回 null。
 *
 * 纯函数：无 IO、无状态，可快照单测。
 */

import type { AgentEvent } from "@ff-pane/adapters";
import type { PermissionRequestPayload } from "@ff-pane/shared";
import type { SessionStreamEvent } from "../../shared-ipc/contracts";

/** 把权限请求载荷折成一句可读摘要（动态内容随权限项变化，UI 直接展示）。 */
export function describePermissionPayload(payload: PermissionRequestPayload): string {
  switch (payload.kind) {
    case "read_path":
      return `读取文件：${payload.path}`;
    case "write_path":
      return `写入文件：${payload.path}`;
    case "shell_command":
      return `执行命令：${payload.command}`;
    case "network":
      return payload.target !== undefined ? `网络访问：${payload.target}` : "网络访问";
    case "dangerous_operation":
      return `危险操作（${payload.operation}）：${payload.detail}`;
  }
}

/**
 * 映射一条增量事件。session_start / end / raw 返回 null（由编排器另行处理）。
 */
export function mapAgentEvent(turnId: string, event: AgentEvent): SessionStreamEvent | null {
  switch (event.kind) {
    case "text":
      return {
        turnId,
        kind: "text",
        channel: event.channel,
        delta: event.content,
        final: event.final,
      };
    case "file_change":
      return {
        turnId,
        kind: "file-change",
        path: event.path,
        changeKind: event.changeKind,
        status: event.status,
      };
    case "command":
      return {
        turnId,
        kind: "command",
        command: event.command,
        status: event.status,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      };
    case "permission_request":
      return {
        turnId,
        kind: "permission-request",
        requestId: event.nativeRequestId,
        summary: describePermissionPayload(event.payload),
        ...(event.reason !== undefined ? { detail: event.reason } : {}),
        ...(event.diff !== undefined ? { diff: event.diff } : {}),
      };
    default:
      // session_start / end / raw：编排器显式处理或不进 UI
      return null;
  }
}
