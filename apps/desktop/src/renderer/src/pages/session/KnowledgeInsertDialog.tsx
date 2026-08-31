import { type ReactElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { KnowledgeHitView } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "../../components/ui/Dialog";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { useSessionStore } from "../../stores/session";
import { buildKnowledgeCitation, deriveFilterOptions, SearchPanel } from "../knowledge";

export interface KnowledgeInsertDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** 对话框里一次给的条数比页面少：这里是「挑一条垫进对话」，不是通读检索结果。 */
const DIALOG_SEARCH_LIMIT = 10;

/**
 * 「从知识库插入」（§8.3.5 路径一的第二个入口）。
 *
 * 与知识库页共用同一个 SearchPanel 与同一套引用生成——两处都是「查 → 挑 → 带出处发出去」，
 * 差别只在挑完之后是跳去会话还是就地插入。若各写一套，两边的引用格式迟早会分叉，
 * 而引用格式是会原样进 Agent 上下文的东西。
 */
export function KnowledgeInsertDialog({
  open,
  onOpenChange,
}: KnowledgeInsertDialogProps): ReactElement {
  const { t } = useTranslation();
  const appendDraft = useSessionStore((state) => state.appendComposerDraft);
  // 过滤项来自知识库总览；对话框打开时才拉（useInvokeQuery 挂载即发起，故随 open 挂载）
  const { state } = useInvokeQuery("knowledge:list");
  const options = useMemo(
    () => deriveFilterOptions(state.status === "success" ? state.data.entries : []),
    [state],
  );

  const insert = (hit: KnowledgeHitView): void => {
    appendDraft(
      buildKnowledgeCitation(hit, {
        sourceLabel: t("knowledge.citationSource"),
        ...(hit.chunk.provenance.page === undefined
          ? {}
          : { pageLabel: t("knowledge.page", { page: hit.chunk.provenance.page }) }),
      }),
    );
    onOpenChange(false);
    toast.success(t("knowledge.inserted"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="diff" className="flex max-h-[80vh] flex-col gap-3">
        <DialogHeader
          title={t("knowledge.insertTitle")}
          description={t("knowledge.insertDescription")}
        />
        <DialogBody className="flex min-h-0 flex-col">
          <SearchPanel
            autoFocus
            options={options}
            limit={DIALOG_SEARCH_LIMIT}
            hitActions={(hit) => (
              <Button variant="primary" size="sm" onClick={() => insert(hit)}>
                {t("knowledge.insert")}
              </Button>
            )}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
