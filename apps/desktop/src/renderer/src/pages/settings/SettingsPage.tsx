import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Separator } from "../../components/ui/Separator";
import { PageHeader } from "../../layout/PageHeader";
import { AppearanceSection } from "./AppearanceSection";
import { DefaultPermissionSection } from "./DefaultPermissionSection";
import { KnowledgeToolSection } from "./KnowledgeToolSection";
import { LanguageSection } from "./LanguageSection";
import { ProfilesSection } from "./profiles/ProfilesSection";
import { ProvidersSection } from "./providers/ProvidersSection";

/**
 * 设置页（T3.2 / 项目设计计划 §11）。
 *
 * 分区结构：本工单（W3.2a）落 Provider 管理区；
 * Profile / 界面语言 / AI 输出语言 / 默认权限预设（W3.2b）作为后续分区加入此处。
 */
export function SettingsPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("nav.settings.label")} description={t("nav.settings.question")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
          <AppearanceSection />
          <Separator />
          <LanguageSection />
          <Separator />
          <ProvidersSection />
          <Separator />
          <ProfilesSection />
          <Separator />
          <DefaultPermissionSection />
          <Separator />
          <KnowledgeToolSection />
        </div>
      </div>
    </>
  );
}
