import type { ProfileId } from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";

export interface ReviewerBarProps {
  readonly projectRoot: string;
  /** 设置变更后通知父级（任务卡片上的审查按钮据此出现/消失）。 */
  readonly onChanged: () => void;
  /** 当前是否开启（父级持有的事实，本组件只负责改它）。 */
  readonly enabled: boolean;
  /** 当前绑定的 Profile（未绑定为 null）。 */
  readonly profileId: ProfileId | null;
}

/**
 * Reviewer 角色的项目级开关与绑定（T7.2，设计文档 §3.1 / §10.2 RoleBindings.reviewer）。
 *
 * **为什么长在任务页的头部而不是设置页**：审查的对象是任务，用户想到"让它审一下"的时候
 * 人就在任务看板前。把开关放进设置页等于要求他先知道该去哪儿找，再走回来点按钮——
 * 与 T6.6 把知识库工具开关放在知识库页是同一条理由。
 *
 * **关掉时不清除绑定**（见 storage ProjectSettings.reviewerProfileId）：这是一个会被
 * 反复开开关关的功能，每次重开都要重选一遍审查者是纯粹的摩擦。
 */
export function ReviewerBar({
  projectRoot,
  onChanged,
  enabled,
  profileId,
}: ReviewerBarProps): ReactElement {
  const { t } = useTranslation();
  const { state: profilesState } = useInvokeQuery("profiles:list");
  const profiles = queryData(profilesState) ?? [];
  const [saving, setSaving] = useState(false);

  // 乐观值：开关不该在等待里发呆；失败即回滚到父级持有的事实。
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localProfileId, setLocalProfileId] = useState<ProfileId | null>(profileId);
  useEffect(() => {
    setLocalEnabled(enabled);
  }, [enabled]);
  useEffect(() => {
    setLocalProfileId(profileId);
  }, [profileId]);

  const save = (patch: {
    readonly reviewerEnabled?: boolean;
    readonly reviewerProfileId?: ProfileId;
  }): void => {
    setSaving(true);
    void invokeQuery("projects:update-settings", { projectRoot, patch }).then((settled) => {
      setSaving(false);
      if (settled.status === "error") {
        setLocalEnabled(enabled);
        setLocalProfileId(profileId);
        toast.error(t("tasks.reviewer.saveError"), { description: settled.error.message });
        return;
      }
      onChanged();
    });
  };

  const bound = profiles.find((p) => p.id === localProfileId);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-1.5">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
        <input
          type="checkbox"
          checked={localEnabled}
          disabled={saving}
          onChange={(event) => {
            setLocalEnabled(event.target.checked);
            save({ reviewerEnabled: event.target.checked });
          }}
        />
        {t("tasks.reviewer.label")}
      </label>
      {localEnabled ? (
        <>
          <select
            className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-xs text-fg"
            value={localProfileId ?? ""}
            disabled={saving || profiles.length === 0}
            aria-label={t("tasks.reviewer.bindingLabel")}
            onChange={(event) => {
              const next = event.target.value as ProfileId;
              if (next.length === 0) {
                return;
              }
              setLocalProfileId(next);
              save({ reviewerProfileId: next });
            }}
          >
            {/* 未绑定时留一个禁用占位项：下拉框不该在没选过的时候显示某个它并未采用的值 */}
            {localProfileId === null ? (
              <option value="" disabled>
                {t("tasks.reviewer.pick")}
              </option>
            ) : null}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <span className="text-2xs text-fg-subtle">
            {profiles.length === 0
              ? t("tasks.reviewer.noProfiles")
              : bound === undefined
                ? t("tasks.reviewer.needBinding")
                : t("tasks.reviewer.hint")}
          </span>
        </>
      ) : (
        <span className="text-2xs text-fg-subtle">{t("tasks.reviewer.offHint")}</span>
      )}
    </div>
  );
}
