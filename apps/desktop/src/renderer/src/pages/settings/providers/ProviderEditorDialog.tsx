import type { ConnectionTestResult, ProbeProviderInput } from "@ff-pane/core";
import type { ApiKeyRef, ModelKind, Provider, ProviderType } from "@ff-pane/shared";
import { Plus, Trash2 } from "lucide-react";
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
import { Field, Input } from "../../../components/ui/Input";
import { inputVariants } from "../../../components/ui/input.variants";
import { invokeQuery } from "../../../ipc/query";
import { cn } from "../../../lib/cn";
import {
  buildProviderDraft,
  emptyProviderForm,
  type ModelRow,
  PROVIDER_TYPE_ORDER,
  type ProviderFormState,
  supportsProbe,
  usesApiKey,
  usesBaseUrl,
  usesProxy,
  usesRequestTemplate,
} from "./provider-form";

const MODEL_KINDS: readonly ModelKind[] = ["chat", "embedding"];

function formFromProvider(provider: Provider): ProviderFormState {
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl ?? "",
    models: provider.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      kind: model.kind,
    })),
    defaultModel: provider.defaultModel ?? "",
    embeddingModel: provider.embeddingModel ?? "",
    proxy: provider.proxy ?? "",
    timeoutS: provider.timeoutS !== undefined ? String(provider.timeoutS) : "",
    requestTemplate: provider.requestTemplate ?? "",
    enabled: provider.enabled,
  };
}

function buildProbeInput(form: ProviderFormState): ProbeProviderInput {
  const baseUrl = form.baseUrl.trim();
  const timeout = form.timeoutS.trim();
  const defaultModel = form.defaultModel.trim();
  return {
    type: form.type,
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    ...(timeout.length > 0 && Number.isFinite(Number(timeout))
      ? { timeoutS: Number(timeout) }
      : {}),
    ...(defaultModel.length > 0 ? { defaultModel } : {}),
  };
}

export interface ProviderEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 传入表示编辑既有 Provider；缺省为新建。 */
  readonly provider?: Provider | undefined;
  /** 保存成功后回调（父区刷新列表 + toast）。 */
  readonly onSaved: (provider: Provider) => void;
}

/**
 * Provider 新建 / 编辑对话框（W3.2a / 设计系统 §5.5）。
 *
 * 密钥（§4.3）：编辑既有 Provider 时只显示尾 4 位占位，明文永不回渲染层；
 * 留空 = 不改动，键入 = 旋转。切到无需密钥的类型时提交清除。
 */
export function ProviderEditorDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: ProviderEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProviderFormState>(emptyProviderForm);
  const [apiKey, setApiKey] = useState("");
  const [maskedTail, setMaskedTail] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | undefined>(undefined);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);

  const isEdit = provider !== undefined;

  // 打开时初始化表单；编辑态取密钥尾 4 位占位
  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(provider !== undefined ? formFromProvider(provider) : emptyProviderForm());
    setApiKey("");
    setMaskedTail("");
    setSaveError(undefined);
    setTestResult(undefined);
    setModelsError(undefined);
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

  const setModel = useCallback((index: number, next: Partial<ModelRow>) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));
  }, []);

  const addModel = useCallback(() => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, { id: "", displayName: "", kind: "chat" }],
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

  /** 草稿态的代理出口：与保存时同一套裁剪 / 类型门槛，先测后存两端一致。 */
  const resolveProxyArg = useCallback((): { readonly proxy?: string } => {
    const proxy = usesProxy(form.type) ? form.proxy.trim() : "";
    return proxy.length > 0 ? { proxy } : {};
  }, [form.proxy, form.type]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(undefined);
    const model = form.defaultModel.trim();
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
      setModelsError(settled.data.rawError);
      return;
    }
    patch({
      models: settled.data.models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        kind: m.kind,
      })),
    });
  }, [form, patch, resolveKeyArgs, resolveProxyArg]);

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
            // 切到不需要密钥的类型：清除旧密钥
            ...(usesApiKey(form.type) ? {} : { clearApiKey: true }),
          })
        : await invokeQuery("providers:create", {
            draft,
            ...(typedKey.length > 0 ? { apiKey } : {}),
          });
    setSaving(false);
    if (settled.status === "error") {
      setSaveError(settled.error.message);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={isEdit ? t("settings.providers.edit.title") : t("settings.providers.new")}
          description={t("settings.providers.edit.description")}
        />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="provider-name" label={t("settings.providers.field.name")} required>
              <Input
                id="provider-name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field htmlFor="provider-type" label={t("settings.providers.field.type")} required>
              <select
                id="provider-type"
                className={selectClass}
                value={form.type}
                onChange={(e) => patch({ type: e.target.value as ProviderType })}
              >
                {PROVIDER_TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {t(`settings.providers.type.${type}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {usesBaseUrl(form.type) ? (
            <Field
              htmlFor="provider-baseurl"
              label={t("settings.providers.field.baseUrl")}
              required={form.type !== "custom"}
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

          {usesProxy(form.type) ? (
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

          {usesApiKey(form.type) ? (
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

          {usesRequestTemplate(form.type) ? (
            <Field
              htmlFor="provider-template"
              label={t("settings.providers.field.requestTemplate")}
              required
            >
              <Input
                id="provider-template"
                value={form.requestTemplate}
                className="font-mono text-xs"
                onChange={(e) => patch({ requestTemplate: e.target.value })}
              />
            </Field>
          ) : null}

          {/* 模型列表 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-muted">{t("settings.providers.field.models")}</span>
              <div className="flex items-center gap-1">
                {supportsProbe(form.type) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void fetchModels()}
                    loading={fetchingModels}
                  >
                    {t("settings.providers.fetchModels")}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={addModel}>
                  <Plus aria-hidden size={14} />
                  {t("settings.providers.addModel")}
                </Button>
              </div>
            </div>
            {form.models.length === 0 ? (
              <p className="text-xs text-fg-subtle">{t("settings.providers.field.modelsEmpty")}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {form.models.map((row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 模型行无稳定 id（用户编辑中），索引即身份
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      value={row.id}
                      placeholder={t("settings.providers.field.modelId")}
                      className="flex-1 font-mono text-xs"
                      onChange={(e) => setModel(index, { id: e.target.value })}
                    />
                    <Input
                      value={row.displayName}
                      placeholder={t("settings.providers.field.modelName")}
                      className="flex-1"
                      onChange={(e) => setModel(index, { displayName: e.target.value })}
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
                value={form.defaultModel}
                onChange={(e) => patch({ defaultModel: e.target.value })}
              >
                <option value="">{t("settings.providers.field.none")}</option>
                {chatModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName.length > 0 ? m.displayName : m.id}
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
                    {m.displayName.length > 0 ? m.displayName : m.id}
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

          {/* 连接测试 */}
          {supportsProbe(form.type) ? (
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
            disabled={saving || form.name.trim().length === 0}
            loading={saving}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
