import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";

/** 开关本体（已确定有当前项目，故可以无条件发起查询）。 */
function ToolToggle({
  projectRoot,
  projectName,
}: {
  readonly projectRoot: string;
  readonly projectName: string;
}): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("projects:get-settings", { projectRoot });

  // 本地态跟随服务端事实；切换时先落乐观值，失败即回滚（开关不该在等待里发呆）
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (state.status === "success") {
      setEnabled(state.data.knowledgeToolEnabled);
    }
  }, [state]);

  const toggle = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    // invokeQuery 永不 reject：成功/失败都落在 settled 状态里，故按 status 分支
    void invokeQuery("projects:update-settings", {
      projectRoot,
      patch: { knowledgeToolEnabled: next },
    }).then((settled) => {
      setSaving(false);
      if (settled.status === "error") {
        setEnabled(previous);
        toast.error(t("knowledge.agentTool.saveError"), {
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
          checked={enabled}
          disabled={state.status !== "success" || saving}
          onChange={(event) => toggle(event.target.checked)}
        />
        {t("knowledge.agentTool.label")}
      </label>
      <p className="text-2xs text-fg-subtle">
        {t("knowledge.agentTool.hint", { project: projectName })}
      </p>
      {enabled ? (
        <p className="text-2xs text-fg-subtle">{t("knowledge.agentTool.enabledNote")}</p>
      ) : null}
    </>
  );
}

/**
 * Agent 只读检索工具的项目级开关（T6.6，设计文档 §8.3.5 路径二）。
 *
 * **为什么一个项目级开关长在全局的知识库页上**：知识库本身是全局的（T6.5 结论），
 * 但"要不要让 Agent 自己查它"是逐项目的决定——有的项目适合放开，有的不适合。
 * 用户想到这件事的时候人在知识库页，把开关放到别处（如设置页）等于要求他先知道
 * 该去哪儿找。故就地放，并明确标注它作用于**当前项目**。
 *
 * 未选中项目时不隐藏而是给一句说明：隐藏会让用户以为这个功能根本不存在。
 */
export function AgentToolPanel(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();

  return (
    <section className="flex flex-col gap-1 rounded-md border border-border p-3">
      {loading ? null : entry === null ? (
        <>
          <span className="text-sm text-fg-muted">{t("knowledge.agentTool.label")}</span>
          <p className="text-2xs text-fg-subtle">{t("knowledge.agentTool.needProject")}</p>
        </>
      ) : (
        <ToolToggle projectRoot={entry.rootPath} projectName={entry.name} />
      )}
    </section>
  );
}
