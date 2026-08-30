/**
 * stores 出口与约定（W3.1c）—— zustand 按领域切分，页面工单只从这里导入。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 一、边界：什么能进 store，什么不能
 * ════════════════════════════════════════════════════════════════════════════
 * 能进：
 *   1. UI 状态：折叠、当前页面、选中项、标签页、过滤词、草稿、密度…
 *   2. 订阅缓存：只能由主进程事件推送累积、且没有等价查询的数据
 *      （流式输出增量、Run 进度、候选角标数量）。
 * 不能进：
 *   3. 经 IPC 查询得到的服务端数据。理由有三：
 *      - 会立刻变旧，而 store 没有失效机制，页面之间互相看到过期数据；
 *      - 万级记忆条目 / 十万级知识块必须虚拟化 + 服务端过滤（设计系统 §1.1），
 *        全量进 store 等于把数据库搬进内存；
 *      - 三态（骨架/空/错）与查询是一体的，状态形态已由 ipc/query.ts 统一提供。
 *      查询结果留在组件本地状态：`const { state, refetch } = useInvokeQuery(...)`。
 *   4. 主题偏好（theme/）、界面语言（i18n/）、命令面板开合（command/）——各有其主。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 二、切分与命名
 * ════════════════════════════════════════════════════════════════════════════
 *   ui       全局 UI 偏好与布局（**已实现**，持久化 localStorage["ffpane.ui-state"]）
 *   session  会话页 UI 状态 + 流式输出缓存（类型骨架，实现归 W3.3a/W3.3b）
 *   tasks    任务页 UI 状态 + Run 进度缓存（类型骨架，实现归 W3.6a/W3.6b）
 *   memory   记忆页 UI 状态 + 候选角标（类型骨架，实现归 W3.5a/W3.5b）
 *
 * 一个领域一个 store，禁止跨 store 互相 import（要联动就在组件层组合）。
 * 状态与 action 平铺在同一对象：`XxxState & XxxActions`，action 名一律
 * `setX` / `toggleX` / `resetXxxUi`；action 引用在 store 生命周期内保持稳定。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 三、消费方式
 * ════════════════════════════════════════════════════════════════════════════
 *   const navCollapsed = useUiStore((s) => s.navCollapsed);        // ✔ 细粒度选择器
 *   const toggle = useUiStore((s) => s.toggleNavCollapsed);        // ✔ action 单独取
 *   const store = useUiStore();                                    // ✘ 整店订阅，任意字段变化都重渲染
 * 需要多字段时分多次 useUiStore 调用，或用 useShallow 包裹（zustand/react/shallow）。
 *
 * 只实现不改接口：类型骨架里的状态形态是各页面工单的契约，要改先改本目录。
 */
export {
  INITIAL_MEMORY_UI_STATE,
  type MemoryStore,
  type MemoryTab,
  type MemoryUiActions,
  type MemoryUiState,
} from "./memory";
export {
  isPageKey,
  PAGE_KEYS,
  PAGE_SHORTCUT_ORDER,
  type PageKey,
  pageKeyByShortcutIndex,
  shortcutIndexOfPage,
} from "./pages";
export {
  INITIAL_SESSION_UI_STATE,
  type SessionSidePanelTab,
  type SessionStore,
  type SessionUiActions,
  type SessionUiState,
  type StreamingTurn,
  useSessionStore,
} from "./session";
export {
  INITIAL_TASKS_UI_STATE,
  type RunProgressSnapshot,
  type TasksStore,
  type TasksUiActions,
  type TasksUiState,
} from "./tasks";
export {
  type ListDensity,
  UI_STORE_STORAGE_KEY,
  type UiActions,
  type UiState,
  type UiStore,
  useUiStore,
} from "./ui";
