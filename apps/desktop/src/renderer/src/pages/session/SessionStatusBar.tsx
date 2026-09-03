import type { ModelId, RoleRef, SessionResumeKind } from "@ff-pane/shared";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRoleLabel } from "../../hooks/useRoleLabel";
import type { TurnStatus } from "../../stores/session";

export interface SessionStatusBarProps {
  readonly projectName: string;
  /** 当前轮角色（null = 无进行中会话；T8.4 起可为自定义角色 ID）。 */
  readonly role: RoleRef | null;
  readonly model: ModelId | null;
  readonly status: TurnStatus;
  /** 本轮恢复方式（T4.3，§10.3）：null = 全新会话，不显示徽标。 */
  readonly resumeKind: SessionResumeKind | null;
  /**
   * 右侧动作槽（T7.1 的「跨 Agent 迁移」入口挂在这里）。
   * 状态条是「我正在和谁讨论」的唯一常驻答复（§11.2），换掉这个"谁"的入口理应就在旁边。
   */
  readonly actions?: ReactNode;
}

/**
 * 会话状态条（W3.4b / §11.2 → T4.2 接通；T4.3 增加会话类型标注）：常驻内容区顶部。
 * 有进行中会话时显示 角色 · 模型 · 会话类型 · 状态；否则显示「无进行中会话」占位。
 * 会话类型（原生恢复 / 上下文重建）用徽标明确标注，让用户知道本轮是否续接旧会话。
 */
export function SessionStatusBar({
  projectName,
  role,
  model,
  status,
  resumeKind,
  actions,
}: SessionStatusBarProps): ReactElement {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const hasTurn = role !== null && status !== "idle";

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface-sunken px-4">
      <span className="truncate text-xs font-medium text-fg">{projectName}</span>
      {hasTurn ? (
        <>
          <span className="text-xs text-fg-muted">{roleLabel(role)}</span>
          {model !== null ? (
            <span className="truncate font-mono text-xs text-fg-subtle">{model}</span>
          ) : null}
          {resumeKind !== null ? (
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
              {t(`session.resumeKind.${resumeKind}`)}
            </span>
          ) : null}
          <span className="text-xs text-fg-subtle">{t(`session.turnStatus.${status}`)}</span>
        </>
      ) : (
        <span className="text-xs text-fg-subtle">{t("session.noActiveSession")}</span>
      )}
      {actions !== undefined ? <div className="ml-auto flex items-center">{actions}</div> : null}
    </div>
  );
}
