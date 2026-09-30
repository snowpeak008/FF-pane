/**
 * windowId → 存活 PTY id（切标签 / 切项目卸载 xterm 后复用；重载后由对账回填）。
 */

const liveTerminalByWindow = new Map<string, string>();

/** 登记窗口与 PTY 的运行期绑定。 */
export function rememberLiveTerminal(windowId: string, terminalId: string): void {
  liveTerminalByWindow.set(windowId, terminalId);
}

/** 清除单个窗口槽。 */
export function forgetLiveTerminal(windowId: string): void {
  liveTerminalByWindow.delete(windowId);
}

/** 批量清除窗口槽（关标签 / 移除项目）。 */
export function forgetLiveTerminals(windowIds: readonly string[]): void {
  for (const windowId of windowIds) {
    liveTerminalByWindow.delete(windowId);
  }
}

/** 读取窗口当前绑定的 PTY id（若有）。 */
export function peekLiveTerminal(windowId: string): string | undefined {
  return liveTerminalByWindow.get(windowId);
}

/** 测试用：清空全部槽。 */
export function clearLiveTerminalsForTests(): void {
  liveTerminalByWindow.clear();
}
