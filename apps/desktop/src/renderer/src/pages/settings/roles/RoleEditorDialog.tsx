import { type CustomRole, DEFAULT_PERMISSION_PRESET } from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../../components/ui/Input";
import { invokeQuery } from "../../../ipc/query";
import { PermissionEnvelopeEditor } from "../PermissionEnvelopeEditor";
import { buildRoleDraft, emptyRoleForm, formFromRole } from "./role-form";

export interface RoleEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 传入表示编辑既有角色；缺省为新建。 */
  readonly role?: CustomRole | undefined;
  /** 保存成功后回调（父区刷新列表 + toast）。 */
  readonly onSaved: (role: CustomRole) => void;
}

/**
 * 自定义角色新建 / 编辑对话框（T8.4，§3.1「一段角色提示词 + 一套默认权限」）。
 * 名称 + 角色提示词（Prompt 第 1 层原文）+ 权限预设（该角色的默认信封，参与交集；
 * §7 危险操作确认不可关闭——编辑器只读展示该项）。落盘前经主进程 core 校验
 * （名称/提示词非空、路径不出项目根），拒绝原因在对话框内呈现。
 */
export function RoleEditorDialog({
  open,
  onOpenChange,
  role,
  onSaved,
}: RoleEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => emptyRoleForm(DEFAULT_PERMISSION_PRESET));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const isEdit = role !== undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(role !== undefined ? formFromRole(role) : emptyRoleForm(DEFAULT_PERMISSION_PRESET));
    setSaveError(undefined);
  }, [open, role]);

  const patch = useCallback((next: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...next }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(undefined);
    const draft = buildRoleDraft(form);
    const settled =
      role !== undefined
        ? await invokeQuery("roles:update", { id: role.id, draft })
        : await invokeQuery("roles:create", { draft });
    setSaving(false);
    if (settled.status === "error") {
      setSaveError(settled.error.message);
      return;
    }
    onSaved(settled.data);
    onOpenChange(false);
  }, [form, onOpenChange, onSaved, role]);

  const canSave = form.name.trim().length > 0 && form.systemPrompt.trim().length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={isEdit ? t("settings.roles.edit.title") : t("settings.roles.new")}
          description={t("settings.roles.edit.description")}
        />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 py-3">
          <Field htmlFor="role-name" label={t("settings.roles.field.name")} required>
            <Input
              id="role-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field
            htmlFor="role-prompt"
            label={t("settings.roles.field.systemPrompt")}
            hint={t("settings.roles.field.systemPromptHint")}
            required
          >
            <Textarea
              id="role-prompt"
              rows={6}
              value={form.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
            />
          </Field>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">{t("settings.roles.field.permission")}</span>
            <PermissionEnvelopeEditor
              idPrefix="role-perm"
              value={form.permission}
              onChange={(permission) => patch({ permission })}
            />
          </div>

          {saveError !== undefined ? (
            <p className="font-mono text-xs text-danger-text select-text" role="alert">
              {saveError}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void save()}
            disabled={!canSave}
            loading={saving}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
