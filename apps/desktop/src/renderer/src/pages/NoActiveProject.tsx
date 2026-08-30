import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../components/states/EmptyState";

/**
 * 项目级页面在「未选当前项目」时的统一空态：一句话 + 去项目列表。
 * 会话/计划/任务/执行记录/记忆页共用（各页以当前项目为作用域）。
 */
export function NoActiveProject(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      className="min-h-0 flex-1"
      message={t("project.noneSelected")}
      action={{ label: t("project.goToList"), onClick: () => navigate("/projects") }}
    />
  );
}
