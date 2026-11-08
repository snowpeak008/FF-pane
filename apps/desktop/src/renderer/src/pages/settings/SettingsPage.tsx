import type { ReactElement, ReactNode } from "react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Separator } from "../../components/ui/Separator";
import { PageHeader } from "../../layout/PageHeader";
import { cn } from "../../lib/cn";
import {
  resolveSettingsGroup,
  SETTINGS_GROUPS,
  type SettingsGroup,
} from "../../stores/settings-groups";
import { useUiStore } from "../../stores/ui";
import { AppearanceSection } from "./AppearanceSection";
import { ConfigToolSection } from "./ConfigToolSection";
import { ConfigsSection } from "./configs/ConfigsSection";
import { ImageGenSection } from "./ImageGenSection";
import { KnowledgeToolSection } from "./KnowledgeToolSection";
import { LanguageSection } from "./LanguageSection";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SkillsSection } from "./skills/SkillsSection";
import { WorkbenchDefaultPermissionSection } from "./WorkbenchDefaultPermissionSection";
import { WorkbenchLimitSection } from "./WorkbenchLimitSection";
import { WorkbenchRoleManualsSection } from "./WorkbenchRoleManualsSection";

/** 每组里有哪几块，按显示顺序。各块自己的样子不变，只是换个地方放。 */
const GROUP_SECTIONS: Record<SettingsGroup, readonly (() => ReactNode)[]> = {
  general: [() => <AppearanceSection />, () => <LanguageSection />],
  workbench: [
    () => <WorkbenchLimitSection />,
    () => <WorkbenchDefaultPermissionSection />,
    () => <WorkbenchRoleManualsSection />,
  ],
  // 生图在 T11.9 第 6 步改走技能后去掉（技能计划 §5.1）
  models: [() => <ProvidersSection />, () => <ImageGenSection />, () => <ConfigsSection />],
  skills: [() => <SkillsSection />],
  tools: [() => <KnowledgeToolSection />, () => <ConfigToolSection />],
};

/**
 * 设置页（T3.2 / 项目设计计划 §11；T11.9 起左边分组）。
 *
 * 左边一列分组，右边一次只显示一组。`?group=` 直达某一组；不带参数时回到上次那一组。
 */
export function SettingsPage(): ReactElement {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const remembered = useUiStore((s) => s.settingsGroup);
  const setRemembered = useUiStore((s) => s.setSettingsGroup);
  const group = resolveSettingsGroup(searchParams.get("group"), remembered);

  const select = (next: SettingsGroup): void => {
    setRemembered(next);
    setSearchParams({ group: next }, { replace: true });
  };

  return (
    <>
      <PageHeader title={t("nav.settings.label")} description={t("nav.settings.question")} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("settings.groups.label")}
          className="flex w-40 shrink-0 flex-col gap-1 border-r border-border p-2"
        >
          {SETTINGS_GROUPS.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`settings-group-${key}`}
              aria-current={key === group ? "page" : undefined}
              onClick={() => {
                select(key);
              }}
              className={cn(
                "flex h-7 items-center rounded-sm border-l-2 border-l-transparent px-2 text-left",
                "text-sm text-fg-muted transition-colors duration-100",
                "hover:bg-surface-hover hover:text-fg",
                key === group && "border-l-primary bg-surface-active font-medium text-fg",
              )}
            >
              <span className="truncate">{t(`settings.groups.${key}`)}</span>
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="mx-auto flex max-w-4xl flex-col gap-6 p-4"
            data-testid={`settings-panel-${group}`}
          >
            {GROUP_SECTIONS[group].map((render, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 每组的块是固定清单，顺序不变
              <Fragment key={index}>
                {index > 0 ? <Separator /> : null}
                {render()}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
