/**
 * 基础组件库出口（设计系统 §5）。页面工单只从 `components/ui` 导入，不引用内部文件。
 *
 * 变体函数（`*Variants`）同样对外暴露：需要把组件外观套到别的元素上时
 * （例如给 react-router 的 <Link> 套按钮样式），用变体函数生成类名，
 * 不要手抄类名串，也不要在 JSX 里拼三元表达式。
 */
export { Badge, type BadgeProps, CapabilityBadge, TaskStatusBadge } from "./Badge";
export { Button, type ButtonProps } from "./Button";
export {
  BADGE_DOT_BASE,
  badgeVariants,
  CAPABILITY_BADGE,
  CAPABILITY_LEVELS,
  type CapabilityLevel,
  TASK_STATUS_BADGE,
  TASK_STATUSES,
  type TaskStatus,
} from "./badge.variants";
export {
  BUTTON_ICON_SIZE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  type ButtonSize,
  type ButtonVariant,
  buttonVariants,
} from "./button.variants";
export { Card, CardButton, CardHeader, type CardProps } from "./Card";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { cardVariants } from "./card.variants";
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "./Dialog";
export {
  DIALOG_SIZES,
  type DialogSize,
  dialogContentVariants,
  isConfirmationSatisfied,
} from "./dialog.variants";
export { Field, Input, type InputProps, SearchInput, Textarea } from "./Input";
export { inputVariants, textareaVariants } from "./input.variants";
export { ScrollArea, type ScrollAreaProps } from "./ScrollArea";
export { Separator } from "./Separator";
export { SKELETON_WIDTHS, Skeleton, skeletonWidth } from "./Skeleton";
export {
  ListRow,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./Table";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";
export { Tooltip, type TooltipProps, TooltipProvider } from "./Tooltip";
export {
  ROW_ACTIONS_CLASS,
  TABLE_HEAD_CLASS,
  tableCellVariants,
  tableRowVariants,
} from "./table.variants";
