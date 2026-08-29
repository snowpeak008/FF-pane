import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppInfo } from "../../shared-ipc/contracts";
import { changeUiLanguage } from "./i18n";
import { isSupportedLanguage } from "./i18n/resolve";
import { LANGUAGE_OPTIONS } from "./i18n/resources";

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly info: AppInfo }
  | { readonly phase: "error"; readonly message: string };

/** 最小语言切换控件（原生 select）；UI 美化是 Phase 3（T3.1）的事。 */
function LanguagePicker(): ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <p>
      <label>
        {t("settings.language.label")}{" "}
        <select
          value={i18n.language}
          onChange={(event) => {
            const value = event.target.value;
            if (isSupportedLanguage(value)) {
              changeUiLanguage(value);
            }
          }}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}

/**
 * T0.2 首页：仅展示应用名与版本（来自主进程，经 IPC 获取），验证三层链路真实打通。
 * T0.3 起全部文案走语言包（locales/*.json），代码中禁止硬编码 UI 字符串。
 * 界面美化与设计系统是 Phase 3（T3.1）的事。
 */
export function App(): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    window.ffpane
      .invoke("app:get-info")
      .then((info) => {
        if (!cancelled) {
          setState({ phase: "ready", info });
        }
      })
      .catch((thrown: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: thrown instanceof Error ? thrown.message : String(thrown),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return <main>{t("app.loading")}</main>;
  }
  if (state.phase === "error") {
    return <main>{t("app.loadError", { message: state.message })}</main>;
  }
  const { info } = state;
  return (
    <main>
      <h1>{info.name}</h1>
      <p>{t("app.version", { version: info.version })}</p>
      <p>
        {t("app.runtime", {
          electron: info.runtime.electron,
          chrome: info.runtime.chrome,
          node: info.runtime.node,
        })}
      </p>
      <LanguagePicker />
    </main>
  );
}
