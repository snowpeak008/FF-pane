import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";

/** 开关本体（照 knowledge/AgentToolPanel 的 ToolToggle 款式：乐观切换，失败回滚）。 */
function ToolToggle({
  projectRoot,
  projectName,
}: {
  readonly projectRoot: string;
  readonly projectName: string;
}): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("projects:get-settings", { projectRoot });

  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (state.status === "success") {
      setEnabled(state.data.configToolEnabled);
    }
  }, [state]);

  const toggle = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    void invokeQuery("projects:update-settings", {
      projectRoot,
      patch: { configToolEnabled: next },
    }).then((settled) => {
      setSaving(false);
      if (settled.status === "error") {
        setEnabled(previous);
        toast.error(t("settings.configTool.saveError"), {
          description: settled.error.message,
        });
        return;
      }
      refetch();
    });
  };

  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          data-testid="config-tool-toggle"
          checked={enabled}
          disabled={state.status !== "success" || saving}
          onChange={(event) => toggle(event.target.checked)}
        />
        {t("settings.configTool.label")}
      </label>
      <p className="text-2xs text-fg-subtle">
        {t("settings.configTool.hint", { project: projectName })}
      </p>
      {enabled ? (
        <p className="text-2xs text-fg-subtle">{t("settings.configTool.enabledNote")}</p>
      ) : null}
    </>
  );
}

/**
 * 工作台自配置工具的项目级开关（T9.1，Phase 9；**默认关闭**，照 T6.6 纪律：
 * 关着连 MCP 配置都不生成，Agent 侧完全看不到这组工具）。
 *
 * 放设置页：这个工具改的就是设置页管理的东西（Provider / Profile），用户想到
 * 「要不要让 AI 帮我配」的时候人在这里。作用域是**当前项目**（说明文案标注），
 * 未选中项目时给一句说明而不是隐藏（照 AgentToolPanel 的论证）。
 */
export function ConfigToolSection(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();

  return (
    <section className="flex flex-col gap-1">
      <div className="flex flex-col gap-0.5 pb-1">
        <h2 className="text-sm font-medium text-fg">{t("settings.configTool.title")}</h2>
        <p className="text-xs text-fg-muted">{t("settings.configTool.subtitle")}</p>
        <p className="text-xs text-fg-subtle">{t("settings.configTool.safetyNote")}</p>
      </div>
      {loading ? null : entry === null ? (
        <p className="text-2xs text-fg-subtle">{t("settings.configTool.needProject")}</p>
      ) : (
        <ToolToggle projectRoot={entry.rootPath} projectName={entry.name} />
      )}
    </section>
  );
}
