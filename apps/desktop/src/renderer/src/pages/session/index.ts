/** 会话页（W3.4）出口。 */
export { ChatMessage, type ChatMessageView, type ChatRole } from "./ChatMessage";
export { Composer } from "./Composer";
export { HandoffDialog, type HandoffDialogProps } from "./HandoffDialog";
export {
  defaultHandoffTargetId,
  deriveHandoffTargets,
  type HandoffTarget,
} from "./handoff-view";
export {
  KnowledgeInsertDialog,
  type KnowledgeInsertDialogProps,
} from "./KnowledgeInsertDialog";
export { MessageStream } from "./MessageStream";
export { type PredictedResumeKind, predictResumeKind } from "./resume-view";
export { SessionPage } from "./SessionPage";
export { SessionReplayBanner } from "./SessionReplayBanner";
export { SessionStatusBar } from "./SessionStatusBar";
export { mapTranscriptToMessages } from "./transcript-view";
