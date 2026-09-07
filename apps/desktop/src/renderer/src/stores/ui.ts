/**
 * ui store（W3.1c；T9.7 收展状态收敛）—— 全局 UI 偏好与布局状态，持久化到 localStorage。
 *
 * 收什么：侧栏折叠（A 栏）、B 栏折叠、当前页面、列表密度、当前项目选择。
 * 不收什么：
 * - 主题偏好 —— 归 theme/（W3.1a 已有独立 ThemeProvider + localStorage["ffpane.ui-theme"]）；
 * - 界面语言 —— 归 i18n/（localStorage["ffpane.ui-language"]）；
 * - 命令面板开合 —— 归 command/ 的 CommandPaletteProvider（浮层的开合是浮层自己的事，
 *   页面要打开它请用 useCommandPalette()，避免 stores 与 command 互相依赖）；
 * - 任何服务端数据 —— 见 stores/index.ts 的边界约定。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * T9.7 收展状态收敛（合同「顺带裁决历史重复」）
 * ════════════════════════════════════════════════════════════════════════════
 * 此前 A 栏折叠有两套并存：AppLayout 自持 localStorage["ffpane.ui-sidebar-collapsed"]
 * （实际生效的那套），与本 store 的 navCollapsed（W3.1c 定形后从未被消费的那套）。
 * 裁决：**收敛进本 store**，理由——
 * 1. B 栏折叠（secondaryPanelCollapsed）与快捷键（Ctrl+B / Ctrl+Shift+B，§7）都要跨
 *    组件读写，store 是既有的唯一跨组件状态通道；AppLayout 的私有 useState 无法承载。
 * 2. 旧键**迁移而非废弃**：用户的折叠偏好不该因内部重构丢失。persist version 1→2 的
 *    migrate 里读取旧键采纳其值，随后删除旧键（一次性，之后不再触碰）。
 * 3. detailPanelCollapsed **删除**：自 W3.1c 定形以来全仓零消费方（会话页右侧栏从未
 *    实现收展），是「为假想需求预留的状态」；将来右侧栏真做收展时按当时的形态再加，
 *    比留一个从未生效的字段诚实（非 MVP 红线：不留占位）。
 *
 * 持久化迁移路径与 theme/i18n 同一先例：Phase 3 暂存 localStorage，
 * 后续接入全局 config.json（项目设计计划 §10.1）时唯一改动点是这里的 storage 实现。
 */
import type { ProjectId } from "@ff-pane/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PageKey } from "./pages";

/** 列表密度（设计系统 §5.6：密集 28px / 默认 32px 行高）。 */
export type ListDensity = "compact" | "default";

export interface UiState {
  /** 当前页面（侧栏高亮与 Ctrl+1~7 的落点）。 */
  readonly activePage: PageKey;
  /** 主侧栏（A 栏）是否折叠。 */
  readonly navCollapsed: boolean;
  /** B 栏（次级侧栏，T9.7 项目切换器）是否折叠。A/B 独立收展。 */
  readonly secondaryPanelCollapsed: boolean;
  /** 列表行高档位。 */
  readonly listDensity: ListDensity;
  /** 当前项目选择（未选返回 null；项目本体数据经 IPC 查询，不进 store）。 */
  readonly activeProjectId: ProjectId | null;
}

export interface UiActions {
  readonly setActivePage: (page: PageKey) => void;
  readonly setNavCollapsed: (collapsed: boolean) => void;
  readonly toggleNavCollapsed: () => void;
  readonly setSecondaryPanelCollapsed: (collapsed: boolean) => void;
  readonly toggleSecondaryPanelCollapsed: () => void;
  readonly setListDensity: (density: ListDensity) => void;
  readonly setActiveProjectId: (projectId: ProjectId | null) => void;
  /** 项目列表已变（新建/移除/恢复）：递增刷新序号，让 B 栏等常驻消费者重取。 */
  readonly bumpProjectsRefresh: () => void;
}

/**
 * 非持久化的运行期信号：项目列表刷新序号（T9.7）。
 * B 栏常驻显示项目列表，而项目的增删发生在项目页——两者没有共享查询缓存，
 * 页面在增删成功后 bump 一次，B 栏据此重取。**不持久化**（重启后本就会重新查询）。
 */
export interface UiRuntimeState {
  readonly projectsRefreshSeq: number;
}

export type UiStore = UiState & UiRuntimeState & UiActions;

/** localStorage 键名；与 theme/i18n 的 "ffpane.*" 命名保持一致。 */
export const UI_STORE_STORAGE_KEY = "ffpane.ui-state";

/** T9.7 之前 AppLayout 自持的 A 栏折叠旧键（迁移后删除，见文件头收敛裁决）。 */
export const LEGACY_SIDEBAR_COLLAPSED_KEY = "ffpane.ui-sidebar-collapsed";

/** 当前持久化版本：1 = W3.1c 定形（双套并存）；2 = T9.7 收敛后。 */
export const UI_STORE_VERSION = 2;

const INITIAL_UI_STATE: UiState = {
  activePage: "projects",
  navCollapsed: false,
  secondaryPanelCollapsed: false,
  listDensity: "default",
  activeProjectId: null,
};

/**
 * persist v1 → v2 迁移（纯函数，单测直调）：
 * - navCollapsed 优先采纳旧 localStorage 键的值（那套才是 T9.7 前实际生效的），
 *   旧键不存在时保留 v1 blob 里的值；
 * - detailPanelCollapsed 丢弃（零消费方，见文件头裁决 3）；
 * - secondaryPanelCollapsed 取初始值（v1 时代不存在这个概念）。
 * legacySidebarValue 为旧键原始串（"1" = 折叠）；读不到（隐私模式 / 不存在）传 null。
 */
export function migrateUiState(persisted: unknown, legacySidebarValue: string | null): UiState {
  const blob =
    typeof persisted === "object" && persisted !== null
      ? (persisted as Record<string, unknown>)
      : {};
  const persistedNavCollapsed = blob["navCollapsed"] === true;
  const navCollapsed =
    legacySidebarValue === null ? persistedNavCollapsed : legacySidebarValue === "1";
  return {
    activePage:
      typeof blob["activePage"] === "string"
        ? (blob["activePage"] as PageKey)
        : INITIAL_UI_STATE.activePage,
    navCollapsed,
    secondaryPanelCollapsed: false,
    listDensity: blob["listDensity"] === "compact" ? "compact" : "default",
    activeProjectId:
      typeof blob["activeProjectId"] === "string" ? (blob["activeProjectId"] as ProjectId) : null,
  };
}

/** localStorage 的最小结构（不引 DOM lib：本模块也被 node 侧 tsconfig 编译）。 */
interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * 读旧键并删除（一次性迁移的副作用侧；隐私模式等读写失败按不存在处理）。
 * 模块加载时读取一次：persist 的 migrate 只在「已有 blob 且版本落后」时被调用，
 * 而「旧键在、v1 blob 不在」（store 从未写过盘）的场景 migrate 不会跑——
 * 初始状态也要采纳旧键，否则这类用户的折叠偏好会丢。
 * 经 globalThis 取 localStorage：node 环境单测 import 本模块时不触碰 DOM。
 */
function takeLegacySidebarValue(): string | null {
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  if (storage === undefined) {
    return null;
  }
  try {
    const value = storage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    storage.removeItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    return value;
  } catch {
    return null;
  }
}

const legacySidebarValue = takeLegacySidebarValue();

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      ...INITIAL_UI_STATE,
      ...(legacySidebarValue !== null ? { navCollapsed: legacySidebarValue === "1" } : {}),
      projectsRefreshSeq: 0,
      setActivePage: (page) => {
        set({ activePage: page });
      },
      setNavCollapsed: (collapsed) => {
        set({ navCollapsed: collapsed });
      },
      toggleNavCollapsed: () => {
        set((state) => ({ navCollapsed: !state.navCollapsed }));
      },
      setSecondaryPanelCollapsed: (collapsed) => {
        set({ secondaryPanelCollapsed: collapsed });
      },
      toggleSecondaryPanelCollapsed: () => {
        set((state) => ({ secondaryPanelCollapsed: !state.secondaryPanelCollapsed }));
      },
      setListDensity: (density) => {
        set({ listDensity: density });
      },
      setActiveProjectId: (projectId) => {
        set({ activeProjectId: projectId });
      },
      bumpProjectsRefresh: () => {
        set((state) => ({ projectsRefreshSeq: state.projectsRefreshSeq + 1 }));
      },
    }),
    {
      name: UI_STORE_STORAGE_KEY,
      version: UI_STORE_VERSION,
      migrate: (persisted) => migrateUiState(persisted, legacySidebarValue),
      // 只持久化偏好状态：action 与运行期信号（projectsRefreshSeq）不落盘；
      // 未来新增字段时旧数据缺字段由初始值补齐
      partialize: (state): UiState => ({
        activePage: state.activePage,
        navCollapsed: state.navCollapsed,
        secondaryPanelCollapsed: state.secondaryPanelCollapsed,
        listDensity: state.listDensity,
        activeProjectId: state.activeProjectId,
      }),
    },
  ),
);
