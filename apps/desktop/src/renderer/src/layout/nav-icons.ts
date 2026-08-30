import {
  BookOpen,
  Brain,
  FileText,
  History,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Settings,
} from "lucide-react";
import type { AnyNavId } from "./nav";

/**
 * 导航图标（lucide 线性图标，14px / 16px；§1.2 禁止装饰性 emoji）。
 * 与 nav.ts 分文件：nav.ts 保持零依赖纯数据，供 node 环境单测直接引用。
 */
export const NAV_ICONS: Readonly<Record<AnyNavId, LucideIcon>> = {
  projects: LayoutGrid,
  session: MessageSquare,
  plan: FileText,
  tasks: ListChecks,
  runs: History,
  memory: Brain,
  knowledge: BookOpen,
  settings: Settings,
};
