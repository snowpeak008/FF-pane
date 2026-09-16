import { ROLE_DEFAULT_ENVELOPES } from "@ff-pane/core";
import {
  type AgentProfile,
  AI_OUTPUT_LANGUAGES,
  DEFAULT_PERMISSION_PRESET,
  GENERIC_EXEC_DELIVERIES,
  type GenericExecDelivery,
  isConnectionMode,
  isReasoningEffortLevel,
  isReasoningEffortRuntime,
  isRole,
  LOCAL_CLI_RUNTIMES,
  ROLES,
  resolveContextWindow,
  resolveReasoningEffortOptions,
  runtimeSupportsLocalCli,
} from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineIpcError } from "../../../components/states/InlineIpcError";
import { Button } from "../../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../../components/ui/Input";
import { inputVariants } from "../../../components/ui/input.variants";
import type { IpcErrorInfo } from "../../../ipc/errors";
import { invokeQuery, queryData } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { cn } from "../../../lib/cn";
import { PermissionEnvelopeEditor } from "../PermissionEnvelopeEditor";
import {
  buildProfileDraft,
  defaultRoleForNewProfile,
  emptyProfileForm,
  formFromProfile,
} from "./profile-form";

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
  "aider",
  "qwen-code",
  "iflow",
  "generic-exec",
] as const;

export interface ProfileEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profile?: AgentProfile | undefined;
  readonly onSaved: (profile: AgentProfile) => void;
  /** 工作台是否已有任一 Profile（T9.6 ⑤）：无 → 新建默认角色取 planner。 */
  readonly hasAnyProfile: boolean;
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
  hasAnyProfile,
}: ProfileEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const { state: providersState, refetch: refetchProviders } = useInvokeQuery("providers:list");
  const { state: configState } = useInvokeQuery("config:get");
  // 自定义角色（T8.4）：默认角色下拉在内置三项之外列出全部自定义角色
  const { state: rolesState, refetch: refetchRoles } = useInvokeQuery("roles:list");
  const customRoles = queryData(rolesState) ?? [];
  const providers = queryData(providersState) ?? [];
  const config = queryData(configState);
  const defaultPreset = config?.defaultPermissionPreset ?? DEFAULT_PERMISSION_PRESET;

  const [form, setForm] = useState(() => emptyProfileForm(DEFAULT_PERMISSION_PRESET));
  const [saving, setSaving] = useState(false);
  // 保存失败留结构化形态（T9.2 ①）：InlineIpcError 按 code 翻译，无 code 回退原文直出
  const [saveError, setSaveError] = useState<IpcErrorInfo | undefined>(undefined);

  const isEdit = profile !== undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(
      profile !== undefined
        ? formFromProfile(profile)
        : emptyProfileForm(defaultPreset, defaultRoleForNewProfile(hasAnyProfile)),
    );
    setSaveError(undefined);
    // defaultPreset 仅在新建且 config 已到时作为初值，故依赖它
  }, [open, profile, defaultPreset, hasAnyProfile]);

  /**
   * 列表新鲜度（T9.3 ①）：对话框常驻挂载、open 只是显隐 prop，useInvokeQuery
   * 的「挂载即拉取」只发生一次——期间在 Provider / 角色区新建的档案不会出现在
   * 下拉里（跨区无失效通知，ProvidersSection.handleSaved 只刷它自己那份 hook
   * 实例）。取最小修复面：每次打开时 refetch 两份清单（refetch 走 refreshing
   * 态不清已有内容，闪动为零；全局查询失效总线对两个下拉而言不成比例）。
   * refetch 引用稳定（useCallback[channel, stableArgs]），不会引发 effect 重跑。
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    refetchProviders();
    refetchRoles();
  }, [open, refetchProviders, refetchRoles]);

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
  const effortModel = form.model.trim() || selectedProvider?.defaultModel || "";
  const { state: effortState } = useInvokeQuery("runtimes:reasoning-effort-levels", {
    runtime: form.runtime,
    ...(effortModel.length > 0 ? { model: effortModel } : {}),
  });
  const effortCatalog = queryData(effortState);
  const effortOptions = useMemo(() => {
    if (effortCatalog !== undefined) {
      return effortCatalog.levels.filter(isReasoningEffortLevel);
    }
    return [...resolveReasoningEffortOptions(form.runtime)];
  }, [effortCatalog, form.runtime]);
  const showEffort = effortOptions.length > 0;
  const contextWindow = useMemo(
    () =>
      resolveContextWindow(
        form.model.trim() || selectedProvider?.defaultModel,
        form.runtime.length > 0 ? form.runtime : undefined,
      ),
    [form.model, form.runtime, selectedProvider?.defaultModel],
  );

  useEffect(() => {
    if (form.reasoningEffort === "") {
      return;
    }
    if (form.runtime === "opencode" && effortCatalog === undefined) {
      return;
    }
    if (!showEffort || !(effortOptions as readonly string[]).includes(form.reasoningEffort)) {
      patch({ reasoningEffort: "" });
    }
  }, [effortCatalog, effortOptions, form.reasoningEffort, form.runtime, patch, showEffort]);

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
      setSaveError(settled.error);
      return;
    }
    onSaved(settled.data);
    onOpenChange(false);
  }, [form, onOpenChange, onSaved, profile]);

  const selectClass = cn(inputVariants({}), "cursor-pointer");
  const isGenericExec = form.runtime === "generic-exec";
  const isLocalCli = form.connectionMode === "local_cli";
  const isRelay = form.connectionMode === "relay";
  const runtimeChoices = isLocalCli
    ? [...LOCAL_CLI_RUNTIMES, "generic-exec"]
    : RUNTIME_OPTIONS.filter((rt) => rt !== "generic-exec");
  const relayProviders = providers.filter((p) => p.type !== "cli_login");
  const canSave =
    form.name.trim().length > 0 &&
    form.runtime.trim().length > 0 &&
    isConnectionMode(form.connectionMode) &&
    (isLocalCli || form.providerId.length > 0) &&
    (!isGenericExec || form.gxCommand.trim().length > 0) &&
    !saving;

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
            <Field
              htmlFor="profile-connection"
              label={t("settings.profiles.field.connectionMode")}
              required
              hint={t("settings.profiles.field.connectionModeHint")}
            >
              <select
                id="profile-connection"
                className={selectClass}
                value={form.connectionMode}
                onChange={(e) => {
                  const connectionMode = e.target.value;
                  if (connectionMode === "local_cli") {
                    const runtime = runtimeSupportsLocalCli(form.runtime) ? form.runtime : "";
                    patch({
                      connectionMode,
                      runtime,
                      providerId: "",
                      model: "",
                      ...(!isReasoningEffortRuntime(runtime) ? { reasoningEffort: "" } : {}),
                    });
                    return;
                  }
                  if (connectionMode === "relay") {
                    const runtime = form.runtime === "generic-exec" ? "" : form.runtime;
                    patch({
                      connectionMode,
                      runtime,
                      providerId: "",
                      model: "",
                    });
                    return;
                  }
                  patch({ connectionMode });
                }}
              >
                <option value="">{t("settings.profiles.field.selectConnection")}</option>
                <option value="local_cli">{t("settings.profiles.field.connectionLocal")}</option>
                <option value="relay">{t("settings.profiles.field.connectionRelay")}</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="profile-runtime" label={t("settings.profiles.field.runtime")} required>
              <select
                id="profile-runtime"
                className={selectClass}
                value={form.runtime}
                disabled={!isConnectionMode(form.connectionMode)}
                onChange={(e) => {
                  const runtime = e.target.value;
                  patch({
                    runtime,
                    ...(runtime === "generic-exec" ? { connectionMode: "local_cli" } : {}),
                    ...(!runtimeSupportsLocalCli(runtime) && isLocalCli
                      ? { connectionMode: "relay", providerId: "", model: "" }
                      : {}),
                    ...(!isReasoningEffortRuntime(runtime) ? { reasoningEffort: "" } : {}),
                  });
                }}
              >
                <option value="">{t("settings.profiles.field.selectRuntime")}</option>
                {runtimeChoices.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </Field>
            {isRelay ? (
            <Field
              htmlFor="profile-provider"
              label={t("settings.profiles.field.provider")}
              required
              hint={t("settings.profiles.field.providerRelayHint")}
            >
              <select
                id="profile-provider"
                className={selectClass}
                value={form.providerId}
                onChange={(e) => patch({ providerId: e.target.value, model: "" })}
              >
                <option value="">{t("settings.profiles.field.selectProvider")}</option>
                {relayProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            ) : (
            <Field
              htmlFor="profile-provider"
              label={t("settings.profiles.field.provider")}
              hint={t("settings.profiles.field.providerLocalHint")}
            >
              <Input
                id="profile-provider"
                value={t("settings.profiles.field.providerLocalValue")}
                disabled
                readOnly
              />
            </Field>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              htmlFor="profile-model"
              label={t("settings.profiles.field.model")}
              // cli_login 模型可选化（T9.2 ④）：缺省 = CLI 默认模型（派发不传 -m 类参数）
              {...(isLocalCli || selectedProvider?.type === "cli_login"
                ? { hint: t("settings.profiles.field.modelCliDefaultHint") }
                : {})}
            >
              <div className="flex flex-col gap-1">
                <select
                  id="profile-model"
                  className={selectClass}
                  value={form.model}
                  disabled={selectedProvider === undefined && !isLocalCli}
                  onChange={(e) => patch({ model: e.target.value })}
                >
                  <option value="">
                    {isLocalCli || selectedProvider?.type === "cli_login"
                      ? t("settings.profiles.field.modelCliDefault")
                      : t("settings.profiles.field.modelDefault")}
                  </option>
                  {chatModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName.length > 0 ? m.displayName : m.id}
                    </option>
                  ))}
                </select>
                <span className="text-2xs text-fg-subtle" data-testid="profile-context-window">
                  {t("settings.profiles.field.contextWindow", {
                    tokens: contextWindow.tokens.toLocaleString(),
                    source: t(
                      `settings.profiles.field.contextWindowSource.${contextWindow.source}`,
                    ),
                  })}
                </span>
              </div>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="profile-role" label={t("settings.profiles.field.defaultRole")} required>
              <select
                id="profile-role"
                className={selectClass}
                value={form.defaultRole}
                onChange={(e) => {
                  const defaultRole = e.target.value;
                  if (isRole(defaultRole)) {
                    patch({ defaultRole, permission: ROLE_DEFAULT_ENVELOPES[defaultRole] });
                    return;
                  }
                  const custom = customRoles.find((role) => role.id === defaultRole);
                  patch({
                    defaultRole,
                    ...(custom !== undefined ? { permission: custom.permissionPreset } : {}),
                  });
                }}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`settings.profiles.role.${role}`)}
                  </option>
                ))}
                {customRoles.length > 0 ? (
                  <optgroup label={t("settings.roles.title")}>
                    {customRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
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

          {showEffort ? (
            <Field
              htmlFor="profile-reasoning-effort"
              label={t("settings.profiles.field.reasoningEffort")}
              hint={t("settings.profiles.field.reasoningEffortHint")}
            >
              <select
                id="profile-reasoning-effort"
                className={selectClass}
                value={form.reasoningEffort}
                onChange={(e) => patch({ reasoningEffort: e.target.value })}
              >
                <option value="">{t("settings.profiles.field.reasoningEffortUnset")}</option>
                {effortOptions.map((level) => (
                  <option key={level} value={level}>
                    {t(`settings.profiles.field.reasoningEffortLevel.${level}`)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {isGenericExec ? (
            <div className="flex flex-col gap-3 rounded border border-border p-3">
              <span className="text-xs text-fg-muted">
                {t("settings.profiles.genericExec.title")}
              </span>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  htmlFor="profile-gx-command"
                  label={t("settings.profiles.genericExec.command")}
                  required
                  hint={t("settings.profiles.genericExec.commandHint")}
                >
                  <Input
                    id="profile-gx-command"
                    value={form.gxCommand}
                    onChange={(e) => patch({ gxCommand: e.target.value })}
                  />
                </Field>
                <Field
                  htmlFor="profile-gx-delivery"
                  label={t("settings.profiles.genericExec.delivery")}
                  hint={t("settings.profiles.genericExec.deliveryHint")}
                >
                  <select
                    id="profile-gx-delivery"
                    className={selectClass}
                    value={form.gxDelivery}
                    onChange={(e) => patch({ gxDelivery: e.target.value as GenericExecDelivery })}
                  >
                    {GENERIC_EXEC_DELIVERIES.map((delivery) => (
                      <option key={delivery} value={delivery}>
                        {t(`settings.profiles.genericExec.deliveryOption.${delivery}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                htmlFor="profile-gx-args"
                label={t("settings.profiles.genericExec.args")}
                hint={t("settings.profiles.genericExec.argsHint")}
              >
                <Textarea
                  id="profile-gx-args"
                  rows={3}
                  value={form.gxArgs}
                  onChange={(e) => patch({ gxArgs: e.target.value })}
                />
              </Field>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">{t("settings.profiles.field.permission")}</span>
            <PermissionEnvelopeEditor
              idPrefix="profile-perm"
              value={form.permission}
              onChange={(permission) => patch({ permission })}
            />
          </div>

          {saveError !== undefined ? <InlineIpcError error={saveError} /> : null}
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
