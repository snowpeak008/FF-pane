/**
 * 应用导航表（项目设计计划 §11 的七个页面 + 设置页）。
 *
 * 本文件是纯数据、零依赖：路由表、侧栏顺序、快捷键映射、占位页文案全部由它派生，
 * 因此 tests/ui-components.test.ts 可以在 node 环境里直接断言结构完整性。
 * 图标映射在 nav-icons.ts（依赖 lucide-react），两者以 NavId 关联。
 */

/** 七个主页面的 id，顺序即侧栏顺序，也是 Ctrl+1 ~ Ctrl+7 的顺序（设计系统 §7）。 */
export const NAV_IDS = [
  "projects",
  "session",
  "plan",
  "tasks",
  "runs",
  "memory",
  "knowledge",
] as const;

export type NavId = (typeof NAV_IDS)[number];

/** 设置页不占 Ctrl+1~7 的位置：它挂在侧栏底部，全局键位是 Ctrl+,（归 W3.1c 注册）。 */
export type SettingsNavId = "settings";

export type AnyNavId = NavId | SettingsNavId;

export interface NavItem {
  readonly id: AnyNavId;
  /** 路由路径（HashRouter 下实际地址为 #/<path>）。 */
  readonly path: string;
  /** 语言包 key：侧栏标签。 */
  readonly labelKey: string;
  /** 语言包 key：该页面回答的问题，用作 tooltip 与占位页说明。 */
  readonly questionKey: string;
  /** 实现该页面的工单号，占位页据此说明"这里归谁做"。 */
  readonly ticket: string;
  /** 页面切换快捷键的序号（1~7）；设置页为 undefined。 */
  readonly shortcut?: number;
}

/**
 * 七个主页面。
 *
 * 说明一处口径统一：本工单派工单里第一页写作"总览"，而设计系统 §7 的键位表、
 * 项目设计计划 §11.1、开发计划 §16.3 的 W3.3 一致称其为"项目列表"，
 * 三处文档口径一致，故此处采用 projects / 项目列表。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "projects",
    path: "/projects",
    labelKey: "nav.projects.label",
    questionKey: "nav.projects.question",
    ticket: "W3.3",
    shortcut: 1,
  },
  {
    id: "session",
    path: "/session",
    labelKey: "nav.session.label",
    questionKey: "nav.session.question",
    ticket: "W3.4a",
    shortcut: 2,
  },
  {
    id: "plan",
    path: "/plan",
    labelKey: "nav.plan.label",
    questionKey: "nav.plan.question",
    ticket: "W3.5a",
    shortcut: 3,
  },
  {
    id: "tasks",
    path: "/tasks",
    labelKey: "nav.tasks.label",
    questionKey: "nav.tasks.question",
    ticket: "W3.6a",
    shortcut: 4,
  },
  {
    id: "runs",
    path: "/runs",
    labelKey: "nav.runs.label",
    questionKey: "nav.runs.question",
    ticket: "W3.7a",
    shortcut: 5,
  },
  {
    id: "memory",
    path: "/memory",
    labelKey: "nav.memory.label",
    questionKey: "nav.memory.question",
    ticket: "W3.8a",
    shortcut: 6,
  },
  {
    id: "knowledge",
    path: "/knowledge",
    labelKey: "nav.knowledge.label",
    questionKey: "nav.knowledge.question",
    ticket: "T6.5",
    shortcut: 7,
  },
];

/** 设置入口，固定在侧栏底部。 */
export const SETTINGS_NAV_ITEM: NavItem = {
  id: "settings",
  path: "/settings",
  labelKey: "nav.settings.label",
  questionKey: "nav.settings.question",
  ticket: "W3.2a",
};

/** 全部可路由条目（七页面 + 设置），路由表按此生成。 */
export const ALL_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, SETTINGS_NAV_ITEM];

/** 应用落地页：项目列表（§11.1「我有哪些项目，各自到哪了」）。 */
export const DEFAULT_ROUTE_PATH = "/projects";

/** 按 id 取条目；id 是字面量联合，故必定命中。 */
export function navItemById(id: AnyNavId): NavItem {
  const found = ALL_NAV_ITEMS.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`nav item not found: ${id}`);
  }
  return found;
}

/** 按快捷键序号（1~7）取条目；越界返回 undefined。 */
export function navItemByShortcut(index: number): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.shortcut === index);
}
