import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { KnowledgeCreateEntryRequest } from "../../../../shared-ipc/contracts";
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
import { parseTagInput } from "./knowledge-view";

export interface KnowledgeNoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 预填标题（会话收录时由调用方给一个可改的建议标题）。 */
  readonly seedTitle?: string;
  /** 预填正文（会话收录时是那条消息的正文）。 */
  readonly seedContent?: string;
  /** 来源；缺省为手动新建。 */
  readonly source?: KnowledgeCreateEntryRequest["source"];
  /** 落库成功后的回调（知识库页据此刷新总览）。 */
  readonly onCreated?: () => void;
}

/**
 * 新建知识库条目（§8.3.2 导入方式二与三：手动新建 / 从会话收录）。
 *
 * **两个入口共用这一个对话框**：知识库页的「新建」与会话页消息上的「存入知识库」，
 * 差别只在正文是空的还是预填了那条消息、以及来源记成 manual 还是 session_capture。
 * 若各写一套，两边对「标题怎么来、正文怎么修、标签怎么打」的处理迟早会分叉，
 * 而这三样都会进索引、影响日后能不能检索得到。
 *
 * 正文落盘由主进程负责（`knowledge/notes/<id>.md`，§10.1）——渲染层不选路径，
 * 也不碰解析分块：那条管道对手写笔记与导入文件是同一条。
 */
export function KnowledgeNoteDialog({
  open,
  onOpenChange,
  seedTitle,
  seedContent,
  source,
  onCreated,
}: KnowledgeNoteDialogProps): ReactElement {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // 每次打开都按种子重置：对话框实例可能被复用（会话页挂一个、点不同消息复用同一个），
  // 不重置会把上一条消息的正文留在框里，而用户看不出那是旧的
  useEffect(() => {
    if (open) {
      setTitle(seedTitle ?? "");
      setContent(seedContent ?? "");
      setTags("");
      setError(undefined);
      setSaving(false);
    }
  }, [open, seedTitle, seedContent]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    const parsedTags = parseTagInput(tags);
    const settled = await invokeQuery("knowledge:create-entry", {
      importId: crypto.randomUUID(),
      title: title.trim(),
      content,
      ...(parsedTags.length === 0 ? {} : { tags: parsedTags }),
      source: source ?? { kind: "manual" },
    });
    setSaving(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }

    // 落库了但一个块都没产出，属于「存进去了却永远搜不到」——比失败更值得说一句
    const { report } = settled.data;
    const failure = report.failures[0];
    if (failure !== undefined) {
      setError(failure.message);
      return;
    }
    onOpenChange(false);
    toast.success(t("knowledge.noteCreated", { chunks: report.chunks }));
    onCreated?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={
            source?.kind === "session_capture"
              ? t("knowledge.captureTitle")
              : t("knowledge.newTitle")
          }
          description={
            source?.kind === "session_capture"
              ? t("knowledge.captureDescription")
              : t("knowledge.newDescription")
          }
        />
        <DialogBody className="flex flex-col gap-3 py-3">
          <Field htmlFor="knowledge-note-title" label={t("knowledge.field.title")} required>
            <Input
              id="knowledge-note-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field
            htmlFor="knowledge-note-content"
            label={t("knowledge.field.content")}
            required
            hint={t("knowledge.field.contentHint")}
          >
            <Textarea
              id="knowledge-note-content"
              rows={10}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          <Field
            htmlFor="knowledge-note-tags"
            label={t("knowledge.field.tags")}
            hint={t("knowledge.field.tagsHint")}
          >
            <Input
              id="knowledge-note-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
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
            disabled={saving || title.trim().length === 0 || content.trim().length === 0}
            loading={saving}
          >
            {t("knowledge.saveNote")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
