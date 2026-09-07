/**
 * SecondaryPanelProvider（T9.7）—— B 栏的投送 context（照 CommandPaletteProvider 装配款式：
 * 自足挂载、context + 消费 hook、页面经 hook 投送不直接触碰容器）。
 *
 * B 栏首要内容是项目快速切换器（ProjectSwitcher，AppLayout 直接渲染为默认内容）。
 * 页面可经 useSecondaryPanel().setContent 投送自己的内容顶替默认（后续可选批次：
 * 计划页版本列表 / 会话页恢复面板 / 任务页在飞区），卸载时 restore 回默认——
 * 本单只铺装管道，尚无页面消费方。
 *
 * 收展状态不在这里：归 ui store（secondaryPanelCollapsed），Provider 只管内容。
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface SecondaryPanelContextValue {
  /** 页面投送的内容（null = 用默认内容，即项目切换器）。 */
  readonly content: ReactNode | null;
  /** 投送内容；返回恢复函数（卸载时调用，回到默认内容）。 */
  readonly setContent: (content: ReactNode) => () => void;
}

const SecondaryPanelContext = createContext<SecondaryPanelContextValue | null>(null);

export function SecondaryPanelProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [content, setContentState] = useState<ReactNode | null>(null);

  const setContent = useCallback((next: ReactNode) => {
    setContentState(next);
    return () => {
      setContentState(null);
    };
  }, []);

  const value = useMemo<SecondaryPanelContextValue>(
    () => ({ content, setContent }),
    [content, setContent],
  );

  return <SecondaryPanelContext.Provider value={value}>{children}</SecondaryPanelContext.Provider>;
}

export function useSecondaryPanel(): SecondaryPanelContextValue {
  const value = useContext(SecondaryPanelContext);
  if (value === null) {
    throw new Error("useSecondaryPanel must be used inside <SecondaryPanelProvider>");
  }
  return value;
}
