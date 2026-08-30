import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/**
 * 会话状态条（W3.4b / §11.2）：常驻在内容区顶部。
 * 完整信息（角色 / Profile / 模型 / 权限摘要 / 会话类型）依赖进行中的会话，
 * 会话生命周期在 Phase 4 接通；此前显示当前项目 + 「无进行中会话」占位。
 */
export function SessionStatusBar({ projectName }: { readonly projectName: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface-sunken px-4">
      <span className="truncate text-xs font-medium text-fg">{projectName}</span>
      <span className="text-xs text-fg-subtle">{t("session.noActiveSession")}</span>
    </div>
  );
}
