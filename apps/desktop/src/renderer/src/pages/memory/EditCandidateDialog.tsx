import type { MemoryEntry } from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { invokeQuery } from "../../ipc/query";

export interface EditCandidateDialogProps {
  readonly projectRoot: string;
  /** 正在编辑的候选；null = 关闭。 */
  readonly entry: MemoryEntry | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}

/**
 * 编辑候选并通过（W3.8b「编辑后通过」）：改标题 / 正文后以 active 状态整条写回，
 * saveEntry 会把文件从 candidates/ 迁到类别目录（自愈旧址副本）。
 */
export function EditCandidateDialog({
  projectRoot,
  entry,
  onOpenChange,
  onSaved,
}: EditCandidateDialogProps): ReactElement {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (entry !== null) {
      setTitle(entry.title);
      setBody(entry.body);
      setError(undefined);
      setSaving(false);
    }
  }, [entry]);

  const save = async (): Promise<void> => {
    if (entry === null) {
      return;
    }
    setSaving(true);
    setError(undefined);
    const updated: MemoryEntry = {
      ...entry,
      title: title.trim(),
      body,
      status: "active",
      updatedAt: entry.updatedAt,
    };
    const settled = await invokeQuery("memory:update", { projectRoot, entry: updated });
    setSaving(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={t("memory.editDialog.title")}
          description={t("memory.editDialog.description")}
        />
        <DialogBody className="flex flex-col gap-3 py-3">
          <Field htmlFor="memory-title" label={t("memory.field.title")} required>
            <Input id="memory-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field htmlFor="memory-body" label={t("memory.field.body")}>
            <Textarea
              id="memory-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {error !== undefined ? (
            <p className="font-mono text-xs text-danger-text select-text" role="alert">
              {error}
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
            disabled={saving || title.trim().length === 0}
            loading={saving}
          >
            {t("memory.saveAndApprove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
