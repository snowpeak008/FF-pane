import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IpcErrorInfo } from "../../ipc/errors";
import { humanizeIpcError } from "../../ipc/humanize";

/**
 * 表单内联的 IPC 错误呈现（T9.2 ①）：错误翻译层的组件壳。
 *
 * - 命中已知错误码：用户可读概括 + 逐字段定位行，原始技术 message 收进
 *   可展开的「技术详情」折叠区（原文可见可复制的纪律不破，只是不再唯一呈现）；
 * - 未命中（旧错误 / 第三方错误）：与从前逐字节相同——message 原文 font-mono 直出。
 *
 * 与 ErrorState（整区三态错误）分工：这里是对话框底部的一行式错误，保存失败后
 * 用户马上要改表单重试，不需要重试按钮与复制按钮的完整三件套。
 */
export function InlineIpcError({ error }: { readonly error: IpcErrorInfo }): ReactElement {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const humanized = humanizeIpcError(error, (key, params) =>
    i18n.exists(key) ? t(key, params ?? {}) : undefined,
  );

  if (!humanized.translated) {
    return (
      <p className="font-mono text-xs text-danger-text select-text" role="alert">
        {humanized.summary}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1" role="alert" data-testid="humanized-error">
      <p className="text-xs text-danger-text select-text">{humanized.summary}</p>
      {humanized.fieldNotes.map((note) => (
        <p key={note} className="text-xs text-danger-text select-text">
          · {note}
        </p>
      ))}
      <button
        type="button"
        className="flex w-fit cursor-pointer items-center gap-1 text-2xs text-fg-muted hover:text-fg"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="humanized-error-toggle"
      >
        {expanded ? <ChevronDown aria-hidden size={12} /> : <ChevronRight aria-hidden size={12} />}
        {t("errors.technicalDetail")}
      </button>
      {expanded ? (
        <pre className="max-h-32 overflow-auto rounded-sm border border-border bg-surface-sunken p-2 font-mono text-2xs whitespace-pre-wrap text-fg select-text">
          {humanized.technicalDetail}
        </pre>
      ) : null}
    </div>
  );
}
