/**
 * 应用导航表（项目设计计划 §11 的七个页面 + 设置页）。
 *
 * 本文件是纯数据：路由表、侧栏顺序、快捷键映射、占位页文案全部由它派生，
 * 因此 tests/ui-components.test.ts 可以在 node 环境里直接断言结构完整性。
 * 图标映射在 nav-icons.ts（依赖 lucide-react），两者以 NavId 关联。
 *
 * 唯一的依赖是 stores/pages.ts（零依赖的页面注册表）：**页面顺序只此一份**（T8.1 收敛）。
 */
import { PAGE_SHORTCUT_ORDER } from "../stores/pages";

/**
 * 七个主页面的 id，顺序即侧栏顺序，也是 Ctrl+1 ~ Ctrl+7 的顺序（设计系统 §7）。
 * 直接取自页面注册表——此前这里手抄了一份同样的七个 id，与注册表各自维护。
 */
export const NAV_IDS = PAGE_SHORTCUT_ORDER;

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

/** 承接各页面的工单号（占位页据此说明"这里归谁做"）。 */
const NAV_TICKETS: Readonly<Record<NavId, string>> = {
  projects: "W3.3",
  session: "W3.4a",
  plan: "W3.5a",
  tasks: "W3.6a",
  runs: "W3.7a",
  memory: "W3.8a",
  knowledge: "T6.5",
};

/**
 * 七个主页面。
 *
 * 顺序与快捷键序号一律由 stores/pages.ts 的注册表派生（T8.1 收敛）——
 * 此前 shortcut 是手写的 1~7，与注册表的 PAGE_SHORTCUT_ORDER 是两份同形清单：
 * 调整页面顺序时只改一处，另一处会静默不同步（侧栏第 3 项的 tooltip 写着 Ctrl+3，
 * 按下去却跳到别的页面）。现在两者不可能不一致。
 *
 * 说明一处口径统一：W3.1b 派工单里第一页写作"总览"，而设计系统 §7 的键位表、
 * 项目设计计划 §11.1、开发计划 §16.3 的 W3.3 一致称其为"项目列表"，
 * 三处文档口径一致，故此处采用 projects / 项目列表。
 */
export const NAV_ITEMS: readonly NavItem[] = NAV_IDS.map((id, index) => ({
  id,
  path: `/${id}`,
  labelKey: `nav.${id}.label`,
  questionKey: `nav.${id}.question`,
  ticket: NAV_TICKETS[id],
  // 序号即在注册表键位序列中的位置（1 起）——这里遍历的就是那条序列本身，
  // 故直接用 index + 1，与 shortcutIndexOfPage 同一定义（下方单测钉住两者一致）
  shortcut: index + 1,
}));

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

// 此前还有 navItemByShortcut（按序号反查条目）。它的唯一消费方是 layout/shortcuts.ts 的
// matchPageShortcut，后者随 AppLayout 自建键盘监听在 T8.1 删除；按同一判据本函数亦删除
// （v0.9.x 清债单）。序号→页面的判定只在 command/ 注册表（nav-page-by-index）一处。
