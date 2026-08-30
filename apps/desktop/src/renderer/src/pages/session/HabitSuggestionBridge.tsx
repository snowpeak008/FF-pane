import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSubscription } from "../../ipc/useSubscription";

/**
 * 系统观察建议全局桥（T5.4 来源三，§8.2.4）：唯一订阅 habits:suggestion，把主进程据反复
 * 纠正生成的 observed 候选提示为一条非阻塞 toast（不弹窗打断）。候选已落库为 candidate，
 * 用户在共享记忆（习惯）标签审核通过才 active——本桥只负责提示 + 引导。无渲染输出。
 */
export function HabitSuggestionBridge(): null {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useSubscription("habits:suggestion", (event) => {
    toast.info(t("habit.observed.toast", { content: event.content, count: event.count }), {
      action: {
        label: t("habit.observed.review"),
        onClick: () => navigate("/memory"),
      },
      duration: 10_000,
    });
  });

  return null;
}
