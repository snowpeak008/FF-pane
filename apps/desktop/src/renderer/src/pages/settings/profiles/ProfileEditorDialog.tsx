import {
  type AgentProfile,
  AI_OUTPUT_LANGUAGES,
  DEFAULT_PERMISSION_PRESET,
  ROLES,
  type Role,
} from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../components/ui/Dialog";
import { Field, Input } from "../../../components/ui/Input";
import { inputVariants } from "../../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { cn } from "../../../lib/cn";
import { PermissionEnvelopeEditor } from "../PermissionEnvelopeEditor";
import { buildProfileDraft, emptyProfileForm, formFromProfile } from "./profile-form";

/**
 * 已知 Runtime 下拉项（权威闭合清单在 @ff-pane/adapters KNOWN_RUNTIMES；
 * desktop 未依赖 adapters 且 RuntimeId 为开放 string，故此处镜像一份供选择）。
 */
const RUNTIME_OPTIONS = [
  "codex",
  "claude-code",
  "gemini-cli",
  "opencode",
  "grok-build",
  "generic-exec",
] as const;

export interface ProfileEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profile?: AgentProfile | undefined;
  readonly onSaved: (profile: AgentProfile) => void;
}

/**
 * Profile 新建 / 编辑对话框（W3.2b / 设计文档 §4.4）。
 * Profile 公式：Runtime + Provider + 模型 + 默认角色 + 权限预设 + 输出语言。
 * 落盘前经主进程 core 校验（provider 引用 / 模型 kind / 角色 / 权限）。
 */
export function ProfileEditorDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
}: ProfileEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const { state: providersState } = useInvokeQuery("providers:list");
  const { state: configState } = useInvokeQuery("config:get");
  const providers = queryData(providersState) ?? [];
  const config = queryData(configState);
  const defaultPreset = config?.defaultPermissionPreset ?? DEFAULT_PERMISSION_PRESET;

  const [form, setForm] = useState(() => emptyProfileForm(DEFAULT_PERMISSION_PRESET));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const isEdit = profile !== undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(profile !== undefined ? formFromProfile(profile) : emptyProfileForm(defaultPreset));
    setSaveError(undefined);
    // defaultPreset 仅在新建且 config 已到时作为初值，故依赖它
  }, [open, profile, defaultPreset]);

  const patch = useCallback((next: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...next }));
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === form.providerId),
    [providers, form.providerId],
  );
  const chatModels = useMemo(
    () => (selectedProvider?.models ?? []).filter((m) => m.kind === "chat"),
    [selectedProvider],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(undefined);
    const draft = buildProfileDraft(form);
    const settled =
      profile !== undefined
        ? await invokeQuery("profiles:update", { id: profile.id, draft })
        : await invokeQuery("profiles:create", { draft });
    setSaving(false);
    if (settled.status === "error") {
      setSaveError(settled.error.message);
      return;
    }
    onSaved(settled.data);
    onOpenChange(false);
  }, [form, onOpenChange, onSaved, profile]);

  const selectClass = cn(inputVariants({}), "cursor-pointer");
  const canSave = form.name.trim().length > 0 && form.providerId.length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={isEdit ? t("settings.profiles.edit.title") : t("settings.profiles.new")}
          description={t("settings.profiles.edit.description")}
        />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="profile-name" label={t("settings.profiles.field.name")} required>
              <Input
                id="profile-name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field htmlFor="profile-runtime" label={t("settings.profiles.field.runtime")} required>
              <select
                id="profile-runtime"
                className={selectClass}
                value={form.runtime}
                onChange={(e) => patch({ runtime: e.target.value })}
              >
                <option value="">{t("settings.profiles.field.selectRuntime")}</option>
                {RUNTIME_OPTIONS.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              htmlFor="profile-provider"
              label={t("settings.profiles.field.provider")}
              required
            >
              <select
                id="profile-provider"
                className={selectClass}
                value={form.providerId}
                onChange={(e) => patch({ providerId: e.target.value, model: "" })}
              >
                <option value="">{t("settings.profiles.field.selectProvider")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field htmlFor="profile-model" label={t("settings.profiles.field.model")}>
              <select
                id="profile-model"
                className={selectClass}
                value={form.model}
                disabled={selectedProvider === undefined}
                onChange={(e) => patch({ model: e.target.value })}
              >
                <option value="">{t("settings.profiles.field.modelDefault")}</option>
                {chatModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName.length > 0 ? m.displayName : m.id}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="profile-role" label={t("settings.profiles.field.defaultRole")} required>
              <select
                id="profile-role"
                className={selectClass}
                value={form.defaultRole}
                onChange={(e) => patch({ defaultRole: e.target.value as Role })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`settings.profiles.role.${role}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field htmlFor="profile-output" label={t("settings.profiles.field.outputLanguage")}>
              <select
                id="profile-output"
                className={selectClass}
                value={form.outputLanguage}
                onChange={(e) => patch({ outputLanguage: e.target.value })}
              >
                <option value="">{t("settings.profiles.field.outputFollowGlobal")}</option>
                {AI_OUTPUT_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {t(`settings.languageName.${lang}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">{t("settings.profiles.field.permission")}</span>
            <PermissionEnvelopeEditor
              idPrefix="profile-perm"
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
