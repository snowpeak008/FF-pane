import type { ConnectionTestResult, ProbeProviderInput } from "@ff-pane/core";
import type { ApiKeyRef, ModelKind, Provider, ProviderType } from "@ff-pane/shared";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLI_LOGIN_RUNTIME_WIRES,
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
  buildProviderDraft,
  emptyProviderForm,
  formFromProvider,
  type ModelRow,
  PROVIDER_TYPE_ORDER,
  type ProviderFormState,
  supportsProbe,
  usesApiKey,
  usesBaseUrl,
  usesCliEnumeratedModels,
  usesProxy,
  usesRequestTemplate,
} from "./provider-form";

const MODEL_KINDS: readonly ModelKind[] = ["chat", "embedding"];

/** 登录态徽章色调（unknown/探测失败给中性——不确定的事不用警示色吓人）。 */
const LOGIN_STATUS_TONE = {
  logged_in: "success",
  logged_out: "warning",
  cli_missing: "danger",
  unknown: "neutral",
} as const;

/**
 * 登录态探测缓存：模块级单例（TTL 30s + 在飞去重，cli-login-probe.ts）——
 * 编辑器重开 / 类型切换不重复 spawn CLI；探测层对超时/异常自落 unknown 不挂界面。
 */
const loginProbeCache = createCliLoginProbeCache(async (runtime) => {
  const settled = await invokeQuery("providers:probe-cli-login", { runtime });
  return settled.status === "success"
    ? settled.data
    : { status: "unknown", detail: settled.error.message, probedWith: "" };
});

/**
 * cli_login 的登录态 + 本地模型区（T9.2 ②③）。
 *
 * Provider 领域无 runtime 字段（Runtime 归 Profile），这里的 CLI 选择是**编辑器
 * 本地状态**：只用来决定探测哪家登录态、向哪家枚举模型，不落盘。模型清单本身
 * 落进 Provider.models（枚举结果替换 chat 模型行），与其他类型同一存储形状。
 */
function CliLoginSection({
  onModels,
}: {
  /** 枚举成功后回填模型行（chat kind；grok 的 default 标记回填 defaultModel）。 */
  readonly onModels: (models: readonly ModelRow[], defaultModel: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<CliLoginRuntimeWire>("codex");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<CliLoginProbeView | undefined>(undefined);
  // 探测触发器：runtime 变化走缓存路径；点「刷新」置 force 强制重探
  const [probeTick, setProbeTick] = useState({ force: false });
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);

  // 选中 CLI 变化 / 手动刷新即探测（缓存新鲜时立即返回，不重复 spawn CLI）。
  // cancelled 旗防竞态：切 runtime 后旧探测的迟到结果不得落到新选择上。
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
      displayName: m.displayName,
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
              // 切 CLI 回到缓存路径（上一次「刷新」的 force 不该跟到新选择上）
              setProbeTick({ force: false });
            }}
          >
            {CLI_LOGIN_RUNTIME_WIRES.map((rt) => (
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
  // 保存失败留结构化形态（T9.2 ①）：InlineIpcError 按 code 翻译，无 code 回退原文直出
  const [saveError, setSaveError] = useState<IpcErrorInfo | undefined>(undefined);
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
      // T9.2 ①：补 stage 分类文案（与 test-connection 分支同款口径），原文跟在后面
      setModelsError(
        `${t(`settings.providers.probeStage.${settled.data.stage}`)} — ${settled.data.rawError}`,
      );
      return;
    }
    patch({
      models: settled.data.models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        kind: m.kind,
      })),
    });
  }, [form, patch, resolveKeyArgs, resolveProxyArg, t]);

  /** cli_login 枚举回填（T9.2 ③）：整表替换 chat 模型行 + 采纳 CLI 的默认模型标记。 */
  const applyEnumeratedModels = useCallback(
    (models: readonly ModelRow[], defaultModel: string | undefined) => {
      setForm((prev) => ({
        ...prev,
        models: [...models],
        ...(defaultModel !== undefined ? { defaultModel } : {}),
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
            // 切到不需要密钥的类型：清除旧密钥
            ...(usesApiKey(form.type) ? {} : { clearApiKey: true }),
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

          {form.type === "custom" ? (
            // 自定义类型警示（T9.3 ③）：探测按钮对 custom 隐藏是既有行为，但零解释
            // ——用户不知道是「没有」还是「坏了」，这里把边界说清楚
            <p
              className="rounded-md border border-warning-border bg-warning-surface p-2 text-xs text-warning-text"
              data-testid="custom-type-notice"
            >
              {t("settings.providers.field.customTypeNotice")}
            </p>
          ) : null}

          {usesRequestTemplate(form.type) ? (
            <Field
              htmlFor="provider-template"
              label={t("settings.providers.field.requestTemplate")}
              required
              hint={t("settings.providers.field.requestTemplateHint")}
            >
              <Input
                id="provider-template"
                value={form.requestTemplate}
                className="font-mono text-xs"
                onChange={(e) => patch({ requestTemplate: e.target.value })}
              />
            </Field>
          ) : null}

          {/* cli_login：登录态 + 本地模型枚举（T9.2 ②③）。手填模型入口对该类型隐藏。 */}
          {usesCliEnumeratedModels(form.type) ? (
            <CliLoginSection onModels={applyEnumeratedModels} />
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
                {!usesCliEnumeratedModels(form.type) ? (
                  <Button variant="ghost" size="sm" onClick={addModel}>
                    <Plus aria-hidden size={14} />
                    {t("settings.providers.addModel")}
                  </Button>
                ) : null}
              </div>
            </div>
            {form.models.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                {usesCliEnumeratedModels(form.type)
                  ? t("settings.providers.cliLogin.modelsEmpty")
                  : t("settings.providers.field.modelsEmpty")}
              </p>
            ) : usesCliEnumeratedModels(form.type) ? (
              // cli_login 的模型行只读呈现（来自枚举），只留移除；ID 不可手改
              <div className="flex flex-col gap-1.5">
                {form.models.map((row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 模型行无稳定 id（用户编辑中），索引即身份
                  <div key={index} className="flex items-center gap-1.5">
                    <span className="flex-1 truncate font-mono text-xs text-fg select-text">
                      {row.id}
                    </span>
                    <span className="flex-1 truncate text-xs text-fg-muted">{row.displayName}</span>
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
