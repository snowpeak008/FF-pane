import type { ConnectionTestResult, ProbeProviderInput } from "@ff-pane/core";
import type { ApiKeyRef, ModelKind, Provider, ProviderTemplateId } from "@ff-pane/shared";
import {
  BUILTIN_PROVIDER_TEMPLATES,
  getProviderTemplate,
  providerProbeKind,
} from "@ff-pane/shared";
import { ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CliLoginProbeView,
  type CliLoginRuntimeWire,
  supportsLocalModelsWire,
} from "../../../../../shared-ipc/contracts";
import { InlineIpcError } from "../../../components/states/InlineIpcError";
import { Badge } from "../../../components/ui/Badge";
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
import type { IpcErrorInfo } from "../../../ipc/errors";
import { invokeQuery } from "../../../ipc/query";
import { cn } from "../../../lib/cn";
import { createCliLoginProbeCache } from "./cli-login-probe";
import {
  baseUrlRequired,
  buildProviderDraft,
  emptyProviderForm,
  formFromProvider,
  type ModelRow,
  type ProviderFormState,
  supportsProbe,
  usesApiKey,
  usesBaseUrl,
  usesCliEnumeratedModels,
  usesProxy,
} from "./provider-form";

const MODEL_KINDS: readonly ModelKind[] = ["chat", "embedding"];

/** 探测下拉只列出 Claude 与 Codex。其余运行时的探测代码仍保留。 */
const VISIBLE_CLI_LOGIN_RUNTIMES: readonly CliLoginRuntimeWire[] = ["claude-code", "codex"];

const LOGIN_STATUS_TONE = {
  logged_in: "success",
  logged_out: "warning",
  cli_missing: "danger",
  unknown: "neutral",
} as const;

const loginProbeCache = createCliLoginProbeCache(async (runtime) => {
  const settled = await invokeQuery("providers:probe-cli-login", { runtime });
  return settled.status === "success"
    ? settled.data
    : { status: "unknown", detail: settled.error.message, probedWith: "" };
});

function CliLoginSection({
  onModels,
}: {
  readonly onModels: (models: readonly ModelRow[], defaultModelId: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<CliLoginRuntimeWire>("codex");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<CliLoginProbeView | undefined>(undefined);
  const [probeTick, setProbeTick] = useState({ force: false });
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setProbing(true);
    setProbe(undefined);
    void loginProbeCache.probe(runtime, probeTick.force).then((result) => {
      if (!cancelled) {
        setProbe(result);
        setProbing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runtime, probeTick]);

  const listModels = useCallback(async () => {
    setListing(true);
    setListError(undefined);
    const settled = await invokeQuery("providers:list-local-models", { runtime });
    setListing(false);
    if (settled.status === "error") {
      setListError(settled.error.message);
      return;
    }
    if (!settled.data.ok) {
      setListError(
        `${t(`settings.providers.cliLogin.listError.${settled.data.error}`)} — ${settled.data.detail}`,
      );
      return;
    }
    const rows: ModelRow[] = settled.data.models.map((m) => ({
      id: m.id,
      label: m.displayName,
      kind: "chat" as const,
    }));
    const defaultId = settled.data.models.find((m) => m.isDefault)?.id;
    onModels(rows, defaultId);
  }, [runtime, onModels, t]);

  const selectClass = cn(inputVariants({}), "cursor-pointer");
  const canList = supportsLocalModelsWire(runtime);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3"
      data-testid="cli-login-section"
    >
      <div className="flex items-end gap-2">
        <Field htmlFor="provider-cli-runtime" label={t("settings.providers.cliLogin.runtime")}>
          <select
            id="provider-cli-runtime"
            className={cn(selectClass, "w-40")}
            value={runtime}
            onChange={(e) => {
              setRuntime(e.target.value as CliLoginRuntimeWire);
              setProbeTick({ force: false });
            }}
          >
            {VISIBLE_CLI_LOGIN_RUNTIMES.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center gap-1.5 pb-1.5" data-testid="cli-login-status">
          {probing ? (
            <Badge tone="neutral">{t("settings.providers.cliLogin.probing")}</Badge>
          ) : probe !== undefined ? (
            <Badge tone={LOGIN_STATUS_TONE[probe.status]}>
              {t(`settings.providers.cliLogin.status.${probe.status}`)}
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled={probing}
            aria-label={t("settings.providers.cliLogin.refresh")}
            title={t("settings.providers.cliLogin.refresh")}
            onClick={() => setProbeTick({ force: true })}
          >
            <RefreshCw aria-hidden size={14} />
          </Button>
        </div>
      </div>
      {probe !== undefined && !probing ? (
        <span className="font-mono text-2xs text-fg-muted select-text">{probe.detail}</span>
      ) : null}
      <div className="flex items-center gap-2">
        {canList ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void listModels()}
            loading={listing}
            data-testid="cli-login-list-models"
          >
            {t("settings.providers.cliLogin.listModels")}
          </Button>
        ) : (
          <span className="text-xs text-fg-subtle">
            {t("settings.providers.cliLogin.noEnumeration")}
          </span>
        )}
      </div>
      {listError !== undefined ? (
        <p className="text-xs text-danger-text select-text" data-testid="cli-login-list-error">
          {listError}
        </p>
      ) : null}
      <span className="text-2xs text-fg-subtle">{t("settings.providers.cliLogin.modelHint")}</span>
    </div>
  );
}

function buildProbeInput(form: ProviderFormState): ProbeProviderInput {
  const baseUrl = form.baseUrl.trim();
  const timeout = form.timeoutS.trim();
  const defaultModelId = form.defaultModelId.trim();
  return {
    templateId: form.templateId,
    probe: providerProbeKind(form.templateId),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    ...(timeout.length > 0 && Number.isFinite(Number(timeout))
      ? { timeoutS: Number(timeout) }
      : {}),
    ...(defaultModelId.length > 0 ? { defaultModelId } : {}),
  };
}

export interface ProviderEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly provider?: Provider | undefined;
  readonly onSaved: (provider: Provider) => void;
}

/**
 * Provider 新建 / 编辑对话框（T10.3）：① 选模板 ② 按模板填表。
 * 编辑既有条目直接进入第 ② 步。密钥输入不回显明文。
 */
export function ProviderEditorDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: ProviderEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const [step, setStep] = useState<"template" | "form">("template");
  const [form, setForm] = useState<ProviderFormState>(emptyProviderForm);
  const [apiKey, setApiKey] = useState("");
  const [maskedTail, setMaskedTail] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<IpcErrorInfo | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | undefined>(undefined);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isEdit = provider !== undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    if (provider !== undefined) {
      setStep("form");
      setForm(formFromProvider(provider));
    } else {
      setStep("template");
      setForm(emptyProviderForm());
    }
    setApiKey("");
    setMaskedTail("");
    setSaveError(undefined);
    setTestResult(undefined);
    setModelsError(undefined);
    setAdvancedOpen(false);
    const ref = provider?.apiKeyRef;
    if (ref !== undefined) {
      void invokeQuery("secrets:masked-tail", { ref }).then((settled) => {
        if (settled.status === "success") {
          setMaskedTail(settled.data.tail);
        }
      });
    }
  }, [open, provider]);

  const patch = useCallback((next: Partial<ProviderFormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
  }, []);

  const selectTemplate = useCallback((templateId: ProviderTemplateId) => {
    setForm(emptyProviderForm(templateId));
    setStep("form");
  }, []);

  const setModel = useCallback((index: number, next: Partial<ModelRow>) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));
  }, []);

  const addModel = useCallback(() => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, { id: "", label: "", kind: "chat" }],
    }));
  }, []);

  const removeModel = useCallback((index: number) => {
    setForm((prev) => ({ ...prev, models: prev.models.filter((_, i) => i !== index) }));
  }, []);

  const resolveKeyArgs = useCallback((): {
    readonly apiKey?: string;
    readonly apiKeyRef?: ApiKeyRef;
  } => {
    if (apiKey.trim().length > 0) {
      return { apiKey };
    }
    const ref = provider?.apiKeyRef;
    return ref !== undefined ? { apiKeyRef: ref } : {};
  }, [apiKey, provider]);

  const resolveProxyArg = useCallback((): { readonly proxy?: string } => {
    const proxy = usesProxy(form.templateId) ? form.proxy.trim() : "";
    return proxy.length > 0 ? { proxy } : {};
  }, [form.proxy, form.templateId]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(undefined);
    const model = form.defaultModelId.trim();
    const settled = await invokeQuery("providers:test-connection", {
      provider: buildProbeInput(form),
      ...resolveKeyArgs(),
      ...resolveProxyArg(),
      ...(model.length > 0 ? { model } : {}),
    });
    setTesting(false);
    if (settled.status === "error") {
      setTestResult({ ok: false, stage: "network", rawError: settled.error.message });
      return;
    }
    setTestResult(settled.data);
  }, [form, resolveKeyArgs, resolveProxyArg]);

  const fetchModels = useCallback(async () => {
    setFetchingModels(true);
    setModelsError(undefined);
    const settled = await invokeQuery("providers:fetch-models", {
      provider: buildProbeInput(form),
      ...resolveKeyArgs(),
      ...resolveProxyArg(),
    });
    setFetchingModels(false);
    if (settled.status === "error") {
      setModelsError(settled.error.message);
      return;
    }
    if (!settled.data.ok) {
      setModelsError(
        `${t(`settings.providers.probeStage.${settled.data.stage}`)} — ${settled.data.rawError}`,
      );
      return;
    }
    patch({
      models: settled.data.models.map((m) => ({
        id: m.id,
        label: m.label ?? m.id,
        kind: m.kind ?? "chat",
      })),
    });
  }, [form, patch, resolveKeyArgs, resolveProxyArg, t]);

  const applyEnumeratedModels = useCallback(
    (models: readonly ModelRow[], defaultModelId: string | undefined) => {
      setForm((prev) => ({
        ...prev,
        models: [...models],
        ...(defaultModelId !== undefined ? { defaultModelId } : {}),
      }));
    },
    [],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(undefined);
    const draft = buildProviderDraft(form);
    const typedKey = apiKey.trim();
    const settled =
      provider !== undefined
        ? await invokeQuery("providers:update", {
            id: provider.id,
            draft,
            ...(typedKey.length > 0 ? { apiKey } : {}),
            ...(usesApiKey(form.templateId) ? {} : { clearApiKey: true }),
          })
        : await invokeQuery("providers:create", {
            draft,
            ...(typedKey.length > 0 ? { apiKey } : {}),
          });
    setSaving(false);
    if (settled.status === "error") {
      setSaveError(settled.error);
      return;
    }
    onSaved(settled.data);
    onOpenChange(false);
  }, [apiKey, form, onOpenChange, onSaved, provider]);

  const selectClass = cn(inputVariants({}), "cursor-pointer");
  const chatModels = form.models.filter((m) => m.kind === "chat" && m.id.trim().length > 0);
  const embeddingModels = form.models.filter(
    (m) => m.kind === "embedding" && m.id.trim().length > 0,
  );
  const template = getProviderTemplate(form.templateId);
  const templateOptions = template?.options ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={
            isEdit
              ? t("settings.providers.edit.title")
              : step === "template"
                ? t("settings.providers.pickTemplate")
                : t("settings.providers.new")
          }
          description={
            step === "template"
              ? t("settings.providers.pickTemplateHint")
              : t("settings.providers.edit.description")
          }
        />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 py-3">
          {step === "template" ? (
            <div className="grid grid-cols-1 gap-2" data-testid="provider-template-picker">
              {BUILTIN_PROVIDER_TEMPLATES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-3 text-left transition-colors hover:border-fg-muted hover:bg-surface-sunken"
                  data-testid={`provider-template-${item.id}`}
                  onClick={() => selectTemplate(item.id)}
                >
                  <span className="text-sm font-medium text-fg">{t(item.nameKey)}</span>
                  <span className="text-xs text-fg-muted">{t(item.descriptionKey)}</span>
                  <span className="text-2xs text-fg-subtle">
                    {t("settings.providers.applicableCli", {
                      clis: item.applicableClis.join(" · "),
                    })}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {!isEdit ? (
                <div className="flex items-center justify-between gap-2">
                  <Badge>{t(template?.nameKey ?? form.templateId)}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => setStep("template")}>
                    {t("settings.providers.changeTemplate")}
                  </Button>
                </div>
              ) : (
                <Badge>{t(template?.nameKey ?? form.templateId)}</Badge>
              )}

              <Field htmlFor="provider-name" label={t("settings.providers.field.name")} required>
                <Input
                  id="provider-name"
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>

              {usesBaseUrl(form.templateId) ? (
                <Field
                  htmlFor="provider-baseurl"
                  label={t("settings.providers.field.baseUrl")}
                  required={baseUrlRequired(form.templateId)}
                  hint={t("settings.providers.field.baseUrlHint")}
                >
                  <Input
                    id="provider-baseurl"
                    value={form.baseUrl}
                    placeholder="https://api.example.com/v1"
                    className="font-mono text-xs"
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                  />
                </Field>
              ) : null}

              {usesApiKey(form.templateId) ? (
                <Field
                  htmlFor="provider-apikey"
                  label={t("settings.providers.field.apiKey")}
                  required={!isEdit}
                  hint={
                    isEdit && maskedTail.length > 0
                      ? t("settings.providers.field.apiKeyKept", { tail: maskedTail })
                      : t("settings.providers.field.apiKeyHint")
                  }
                >
                  <Input
                    id="provider-apikey"
                    type="password"
                    value={apiKey}
                    autoComplete="off"
                    placeholder={
                      isEdit && maskedTail.length > 0
                        ? `····${maskedTail}`
                        : t("settings.providers.field.apiKeyPlaceholder")
                    }
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
              ) : null}

              {usesCliEnumeratedModels(form.templateId) ? (
                <CliLoginSection onModels={applyEnumeratedModels} />
              ) : null}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-fg-muted">
                    {t("settings.providers.field.models")}
                  </span>
                  <div className="flex items-center gap-1">
                    {supportsProbe(form.templateId) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void fetchModels()}
                        loading={fetchingModels}
                      >
                        {t("settings.providers.fetchModels")}
                      </Button>
                    ) : null}
                    {!usesCliEnumeratedModels(form.templateId) ? (
                      <Button variant="ghost" size="sm" onClick={addModel}>
                        <Plus aria-hidden size={14} />
                        {t("settings.providers.addModel")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {form.models.length === 0 ? (
                  <p className="text-xs text-fg-subtle">
                    {usesCliEnumeratedModels(form.templateId)
                      ? t("settings.providers.cliLogin.modelsEmpty")
                      : t("settings.providers.field.modelsEmpty")}
                  </p>
                ) : usesCliEnumeratedModels(form.templateId) ? (
                  <div className="flex flex-col gap-1.5">
                    {form.models.map((row, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 模型行无稳定 id
                      <div key={index} className="flex items-center gap-1.5">
                        <span className="flex-1 truncate font-mono text-xs text-fg select-text">
                          {row.id}
                        </span>
                        <span className="flex-1 truncate text-xs text-fg-muted">{row.label}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={t("settings.providers.removeModel")}
                          onClick={() => removeModel(index)}
                        >
                          <Trash2 aria-hidden size={14} />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {form.models.map((row, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 模型行无稳定 id
                      <div key={index} className="flex items-center gap-1.5">
                        <Input
                          value={row.id}
                          placeholder={t("settings.providers.field.modelId")}
                          className="flex-1 font-mono text-xs"
                          onChange={(e) => setModel(index, { id: e.target.value })}
                        />
                        <Input
                          value={row.label}
                          placeholder={t("settings.providers.field.modelName")}
                          className="flex-1"
                          onChange={(e) => setModel(index, { label: e.target.value })}
                        />
                        <select
                          className={cn(selectClass, "w-28")}
                          value={row.kind}
                          onChange={(e) => setModel(index, { kind: e.target.value as ModelKind })}
                        >
                          {MODEL_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`settings.providers.modelKind.${kind}`)}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={t("settings.providers.removeModel")}
                          onClick={() => removeModel(index)}
                        >
                          <Trash2 aria-hidden size={14} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {modelsError !== undefined ? (
                  <p className="font-mono text-xs text-danger-text select-text">{modelsError}</p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field
                  htmlFor="provider-default-model"
                  label={t("settings.providers.field.defaultModel")}
                >
                  <select
                    id="provider-default-model"
                    className={selectClass}
                    value={form.defaultModelId}
                    onChange={(e) => patch({ defaultModelId: e.target.value })}
                  >
                    <option value="">{t("settings.providers.field.none")}</option>
                    {chatModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label.length > 0 ? m.label : m.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  htmlFor="provider-embedding-model"
                  label={t("settings.providers.field.embeddingModel")}
                >
                  <select
                    id="provider-embedding-model"
                    className={selectClass}
                    value={form.embeddingModel}
                    onChange={(e) => patch({ embeddingModel: e.target.value })}
                  >
                    <option value="">{t("settings.providers.field.none")}</option>
                    {embeddingModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label.length > 0 ? m.label : m.id}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="flex items-center gap-4">
                <Field htmlFor="provider-timeout" label={t("settings.providers.field.timeout")}>
                  <Input
                    id="provider-timeout"
                    type="number"
                    min={1}
                    value={form.timeoutS}
                    placeholder="120"
                    className="w-28"
                    onChange={(e) => patch({ timeoutS: e.target.value })}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                  />
                  {t("settings.providers.field.enabled")}
                </label>
              </div>

              {supportsProbe(form.templateId) ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken p-3">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => void testConnection()}
                      loading={testing}
                    >
                      {t("settings.providers.testConnection")}
                    </Button>
                    {testResult?.ok === true ? (
                      <span className="text-xs text-success-text">
                        {t("settings.providers.testOk", { latency: testResult.latencyMs })}
                      </span>
                    ) : null}
                  </div>
                  {testResult?.ok === true ? (
                    <span className="font-mono text-xs text-fg-muted select-text">
                      {testResult.detail}
                    </span>
                  ) : null}
                  {testResult !== undefined && !testResult.ok ? (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-danger-text">
                        {t(`settings.providers.probeStage.${testResult.stage}`)}
                      </span>
                      <pre className="max-h-32 overflow-auto rounded-sm border border-border bg-canvas p-2 font-mono text-xs whitespace-pre-wrap text-fg select-text">
                        {testResult.rawError}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="rounded-md border border-border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-xs text-fg-muted"
                  data-testid="provider-advanced-toggle"
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <span>{t("settings.providers.advanced")}</span>
                  <ChevronDown
                    aria-hidden
                    size={14}
                    className={cn("transition-transform", advancedOpen ? "rotate-180" : "")}
                  />
                </button>
                {advancedOpen ? (
                  <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                    {usesProxy(form.templateId) ? (
                      <Field
                        htmlFor="provider-proxy"
                        label={t("settings.providers.field.proxy")}
                        hint={t("settings.providers.field.proxyHint")}
                      >
                        <Input
                          id="provider-proxy"
                          value={form.proxy}
                          placeholder="http://127.0.0.1:7890"
                          className="font-mono text-xs"
                          onChange={(e) => patch({ proxy: e.target.value })}
                        />
                      </Field>
                    ) : null}
                    <Field
                      htmlFor="provider-extra-env"
                      label={t("settings.providers.field.extraEnv")}
                      hint={t("settings.providers.field.extraEnvHint")}
                    >
                      <textarea
                        id="provider-extra-env"
                        className={cn(inputVariants({}), "min-h-20 font-mono text-xs")}
                        value={form.extraEnvText}
                        placeholder={"FOO=bar\nBAZ=qux"}
                        onChange={(e) => patch({ extraEnvText: e.target.value })}
                      />
                    </Field>
                    {templateOptions.map((option) => (
                      <Field
                        key={option.key}
                        htmlFor={`provider-option-${option.key}`}
                        label={t(option.labelKey)}
                      >
                        <select
                          id={`provider-option-${option.key}`}
                          className={selectClass}
                          value={form.options[option.key] ?? option.defaultValue}
                          onChange={(e) =>
                            patch({
                              options: { ...form.options, [option.key]: e.target.value },
                            })
                          }
                        >
                          {option.values.map((value) => (
                            <option key={value} value={value}>
                              {t(`${option.valueLabelKeyPrefix}.${value}`)}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                ) : null}
              </div>

              {saveError !== undefined ? <InlineIpcError error={saveError} /> : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {step === "form" ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => void save()}
              disabled={saving || form.name.trim().length === 0}
              loading={saving}
            >
              {t("common.save")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
