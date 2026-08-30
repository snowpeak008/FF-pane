/**
 * ui store（W3.1c）—— 全局 UI 偏好与布局状态，持久化到 localStorage。
 *
 * 收什么：侧栏折叠、当前页面、右侧详情栏折叠、列表密度、当前项目选择。
 * 不收什么：
 * - 主题偏好 —— 归 theme/（W3.1a 已有独立 ThemeProvider + localStorage["ffpane.ui-theme"]）；
 * - 界面语言 —— 归 i18n/（localStorage["ffpane.ui-language"]）；
 * - 命令面板开合 —— 归 command/ 的 CommandPaletteProvider（浮层的开合是浮层自己的事，
 *   页面要打开它请用 useCommandPalette()，避免 stores 与 command 互相依赖）；
 * - 任何服务端数据 —— 见 stores/index.ts 的边界约定。
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
  /** 主侧栏是否折叠。 */
  readonly navCollapsed: boolean;
  /** 右侧详情/概要栏是否折叠（会话页 §11.2、任务页 §11.4）。 */
  readonly detailPanelCollapsed: boolean;
  /** 列表行高档位。 */
  readonly listDensity: ListDensity;
  /** 当前项目选择（未选返回 null；项目本体数据经 IPC 查询，不进 store）。 */
  readonly activeProjectId: ProjectId | null;
}

export interface UiActions {
  readonly setActivePage: (page: PageKey) => void;
  readonly setNavCollapsed: (collapsed: boolean) => void;
  readonly toggleNavCollapsed: () => void;
  readonly setDetailPanelCollapsed: (collapsed: boolean) => void;
  readonly toggleDetailPanelCollapsed: () => void;
  readonly setListDensity: (density: ListDensity) => void;
  readonly setActiveProjectId: (projectId: ProjectId | null) => void;
}

export type UiStore = UiState & UiActions;

/** localStorage 键名；与 theme/i18n 的 "ffpane.*" 命名保持一致。 */
export const UI_STORE_STORAGE_KEY = "ffpane.ui-state";

const INITIAL_UI_STATE: UiState = {
  activePage: "projects",
  navCollapsed: false,
  detailPanelCollapsed: false,
  listDensity: "default",
  activeProjectId: null,
};

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      ...INITIAL_UI_STATE,
      setActivePage: (page) => {
        set({ activePage: page });
      },
      setNavCollapsed: (collapsed) => {
        set({ navCollapsed: collapsed });
      },
      toggleNavCollapsed: () => {
        set((state) => ({ navCollapsed: !state.navCollapsed }));
      },
      setDetailPanelCollapsed: (collapsed) => {
        set({ detailPanelCollapsed: collapsed });
      },
      toggleDetailPanelCollapsed: () => {
        set((state) => ({ detailPanelCollapsed: !state.detailPanelCollapsed }));
      },
      setListDensity: (density) => {
        set({ listDensity: density });
      },
      setActiveProjectId: (projectId) => {
        set({ activeProjectId: projectId });
      },
    }),
    {
      name: UI_STORE_STORAGE_KEY,
      version: 1,
      // 只持久化状态，不持久化 action；未来新增字段时旧数据缺字段由初始值补齐
      partialize: (state): UiState => ({
        activePage: state.activePage,
        navCollapsed: state.navCollapsed,
        detailPanelCollapsed: state.detailPanelCollapsed,
        listDensity: state.listDensity,
        activeProjectId: state.activeProjectId,
      }),
    },
  ),
);
