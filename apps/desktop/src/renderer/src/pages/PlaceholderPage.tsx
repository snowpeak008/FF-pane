import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/states";
import type { NavItem } from "../layout/nav";
import { NAV_ICONS } from "../layout/nav-icons";
import { PageHeader } from "../layout/PageHeader";

export interface PlaceholderPageProps {
  readonly item: NavItem;
}

/**
 * 页面占位（W3.1b）：真正的页面内容由各自工单实现，这里只把骨架跑通。
 *
 * 刻意不留白屏：用统一的 EmptyState 说明"这一页回答什么问题、归哪个工单"，
 * 同时充当三态组件在真实布局中的第一处使用样例。
 */
export function PlaceholderPage({ item }: PlaceholderPageProps): ReactElement {
  const { t } = useTranslation();
  const Icon = NAV_ICONS[item.id];
  return (
    <>
      <PageHeader title={t(item.labelKey)} description={t(item.questionKey)} />
      <EmptyState
        className="min-h-0 flex-1"
        icon={Icon}
        message={t("page.placeholder.message", {
          page: t(item.labelKey),
          ticket: item.ticket,
        })}
      />
    </>
  );
}
