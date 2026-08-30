import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { inputVariants } from "../../components/ui/input.variants";
import { cn } from "../../lib/cn";
import { THEME_PREFERENCES, type ThemePreference, useTheme } from "../../theme";
import { SettingRow } from "./SettingRow";

/**
 * 外观设置区（W3.2b）：主题三态（跟随系统 / 浅 / 深）。
 * 主题运行时（ThemeProvider）已就绪，本区只提供选择控件，持久化仍走 localStorage
 * （与 i18n 语言同一先例，后续统一迁移 config.json）。
 */
export function AppearanceSection(): ReactElement {
  const { t } = useTranslation();
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-fg">{t("settings.appearance.title")}</h2>
      <SettingRow
        htmlFor="setting-theme"
        label={t("settings.theme.label")}
        description={t("settings.theme.resolved", {
          theme: t(`settings.theme.options.${resolvedTheme}`),
        })}
      >
        <select
          id="setting-theme"
          className={cn(inputVariants({}), "w-48 cursor-pointer")}
          value={preference}
          onChange={(e) => setPreference(e.target.value as ThemePreference)}
        >
          {THEME_PREFERENCES.map((pref) => (
            <option key={pref} value={pref}>
              {t(`settings.theme.options.${pref}`)}
            </option>
          ))}
        </select>
      </SettingRow>
    </section>
  );
}
