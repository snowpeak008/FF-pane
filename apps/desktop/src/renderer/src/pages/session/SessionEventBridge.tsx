import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSubscription } from "../../ipc/useSubscription";
import { useSessionStore } from "../../stores/session";

/**
 * 会话事件全局桥（T4.2）：应用内唯一订阅 session:event，把主进程推送的流式事件
 * 归并进 session store。会话页与任务页只读 store，不各自订阅——单订阅避免重复处理，
 * 且轮次可跨页存活（任务页派发 Worker 后导航到会话页时不丢早到事件）。
 *
 * 结束事件非 completed 时给一条失败通知；成功不打扰（内容已在会话页流式呈现）。
 * 无渲染输出。
 */
export function SessionEventBridge(): null {
  const { t } = useTranslation();
  const ingest = useSessionStore((s) => s.ingestSessionEvent);

  useSubscription("session:event", (event) => {
    ingest(event);
    if (event.kind === "end" && event.reason !== "completed") {
      toast.error(t("session.turnFailed"), {
        description: event.message ?? event.reason,
      });
    }
  });

  return null;
}
