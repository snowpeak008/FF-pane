import { type PermissionEnvelope, SHELL_POLICIES, type ShellPolicy } from "@ff-pane/shared";
import { Lock } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Field, Textarea } from "../../components/ui/Input";
import { inputVariants } from "../../components/ui/input.variants";
import { cn } from "../../lib/cn";
import { formatPathLines, parsePathLines } from "./permission-envelope";

export interface PermissionEnvelopeEditorProps {
  readonly value: PermissionEnvelope;
  readonly onChange: (value: PermissionEnvelope) => void;
  /** 控件 id 前缀，供同页多个编辑器共存（Profile 编辑器 vs 默认预设）。 */
  readonly idPrefix: string;
}

/**
 * 权限信封编辑器（W3.2b / 设计文档 §7 五项）。可复用于 Profile 编辑与默认预设。
 * 危险操作确认（第 5 项）类型固定为 true——任何信封都不能关闭，故只读展示、不可编辑。
 */
export function PermissionEnvelopeEditor({
  value,
  onChange,
  idPrefix,
}: PermissionEnvelopeEditorProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3">
      <Field
        htmlFor={`${idPrefix}-read`}
        label={t("settings.permission.readPaths")}
        hint={t("settings.permission.pathsHint")}
      >
        <Textarea
          id={`${idPrefix}-read`}
          rows={2}
          className="font-mono text-xs"
          value={formatPathLines(value.readPaths)}
          onChange={(e) => onChange({ ...value, readPaths: parsePathLines(e.target.value) })}
        />
      </Field>

      <Field htmlFor={`${idPrefix}-write`} label={t("settings.permission.writePaths")}>
        <Textarea
          id={`${idPrefix}-write`}
          rows={2}
          className="font-mono text-xs"
          value={formatPathLines(value.writePaths)}
          onChange={(e) => onChange({ ...value, writePaths: parsePathLines(e.target.value) })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field htmlFor={`${idPrefix}-shell`} label={t("settings.permission.shell")}>
          <select
            id={`${idPrefix}-shell`}
            className={cn(inputVariants({}), "cursor-pointer")}
            value={value.shell}
            onChange={(e) => onChange({ ...value, shell: e.target.value as ShellPolicy })}
          >
            {SHELL_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {t(`settings.permission.shellPolicy.${policy}`)}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-end gap-2 pb-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={value.network}
            onChange={(e) => onChange({ ...value, network: e.target.checked })}
          />
          {t("settings.permission.network")}
        </label>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <Lock aria-hidden size={12} />
        {t("settings.permission.dangerousOpsNote")}
      </div>
    </div>
  );
}
