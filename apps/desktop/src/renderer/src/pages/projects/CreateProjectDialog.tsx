import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { FolderOpen } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { invokeQuery } from "../../ipc/query";

/**
 * 从绝对路径取末段目录名，作为项目默认显示名。
 * 兼容 POSIX 与 Windows 分隔符（渲染层拿不到 node:path）。
 */
function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? trimmed;
}

export interface CreateProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 创建成功后回调（携带落盘条目），由父页面刷新列表 + 弹 toast。 */
  readonly onCreated: (entry: ProjectRegistryEntry) => void;
}

/**
 * 新建项目对话框（W3.3 / 设计系统 §5.5）：选目录 → 命名 → 创建。
 *
 * 「选目录即建 .workbench/」由主进程 projects:create handler 完成
 * （initProjectLayout），本组件只负责收集 rootPath + name 并提交。
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectDialogProps): ReactElement {
  const { t } = useTranslation();
  const [rootPath, setRootPath] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  // 每次打开重置表单，避免上次的残留（含错误、路径、名称）
  useEffect(() => {
    if (open) {
      setRootPath(undefined);
      setName("");
      setNameEdited(false);
      setPicking(false);
      setSubmitting(false);
      setErrorMessage(undefined);
    }
  }, [open]);

  const pickDirectory = useCallback(async () => {
    setPicking(true);
    setErrorMessage(undefined);
    const settled = await invokeQuery("dialog:pick-directory");
    setPicking(false);
    if (settled.status === "error") {
      setErrorMessage(settled.error.message);
      return;
    }
    if (settled.data.cancelled) {
      return;
    }
    const picked = settled.data.path;
    setRootPath(picked);
    // 名称未被手动改过时，跟随目录名自动填充
    if (!nameEdited) {
      setName(baseName(picked));
    }
  }, [nameEdited]);

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    if (rootPath === undefined || trimmedName.length === 0) {
      return;
    }
    setSubmitting(true);
    setErrorMessage(undefined);
    const settled = await invokeQuery("projects:create", { rootPath, name: trimmedName });
    setSubmitting(false);
    if (settled.status === "error") {
      setErrorMessage(settled.error.message);
      return;
    }
    onCreated(settled.data);
    onOpenChange(false);
  }, [name, rootPath, onCreated, onOpenChange]);

  const canSubmit = rootPath !== undefined && name.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={t("projects.create.title")}
          description={t("projects.create.description")}
        />
        <DialogBody className="flex flex-col gap-3 py-3">
          <Field htmlFor="create-project-path" label={t("projects.create.pathLabel")} required>
            <div className="flex items-center gap-2">
              <Input
                id="create-project-path"
                readOnly
                value={rootPath ?? ""}
                placeholder={t("projects.create.pathPlaceholder")}
                className="font-mono text-xs"
              />
              <Button
                variant="secondary"
                size="md"
                onClick={() => void pickDirectory()}
                loading={picking}
                className="shrink-0"
              >
                <FolderOpen aria-hidden size={16} />
                {rootPath === undefined
                  ? t("projects.create.pickButton")
                  : t("projects.create.changeButton")}
              </Button>
            </div>
          </Field>

          <Field htmlFor="create-project-name" label={t("projects.create.nameLabel")} required>
            <Input
              id="create-project-name"
              value={name}
              placeholder={t("projects.create.namePlaceholder")}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
          </Field>

          {errorMessage !== undefined ? (
            <p className="font-mono text-xs text-danger-text select-text" role="alert">
              {errorMessage}
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
            onClick={() => void submit()}
            disabled={!canSubmit}
            loading={submitting}
          >
            {t("projects.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
