import { Compass } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../components/states";
import { DEFAULT_ROUTE_PATH } from "../layout/nav";

/** 未知路由：一句话 + 一个主操作，与其它空态同一实现（设计系统 §1.3 一致性）。 */
export function NotFoundPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      className="min-h-0 flex-1"
      icon={Compass}
      message={t("page.notFound.message")}
      action={{
        label: t("page.notFound.action"),
        onClick: () => {
          void navigate(DEFAULT_ROUTE_PATH);
        },
      }}
    />
  );
}
