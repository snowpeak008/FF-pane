import type { ModelId, Role } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TurnStatus } from "../../stores/session";

export interface SessionStatusBarProps {
  readonly projectName: string;
  /** 当前轮角色（null = 无进行中会话）。 */
  readonly role: Role | null;
  readonly model: ModelId | null;
  readonly status: TurnStatus;
}

/**
 * 会话状态条（W3.4b / §11.2 → T4.2 接通）：常驻内容区顶部。
 * 有进行中会话时显示 角色 · 模型 · 状态；否则显示「无进行中会话」占位。
 */
export function SessionStatusBar({
  projectName,
  role,
  model,
  status,
}: SessionStatusBarProps): ReactElement {
  const { t } = useTranslation();
  const hasTurn = role !== null && status !== "idle";

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface-sunken px-4">
      <span className="truncate text-xs font-medium text-fg">{projectName}</span>
      {hasTurn ? (
        <>
          <span className="text-xs text-fg-muted">{t(`session.role.${role}`)}</span>
          {model !== null ? (
            <span className="truncate font-mono text-xs text-fg-subtle">{model}</span>
          ) : null}
          <span className="text-xs text-fg-subtle">{t(`session.turnStatus.${status}`)}</span>
        </>
      ) : (
        <span className="text-xs text-fg-subtle">{t("session.noActiveSession")}</span>
      )}
    </div>
  );
}
