/**
 * 终端输出回执（T11.0d）：xterm 写完一批就记一笔，50ms 合并一次告诉主进程。
 * 主进程按回执流控：界面忙或卡住时不再一直往里推。
 */

import { invokeQuery } from "../../ipc/query";

const ACK_FLUSH_MS = 50;

const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  for (const [id, length] of pending) {
    void invokeQuery("terminal:ack", { id, length });
  }
  pending.clear();
}

export function ackTerminalOutput(id: string, length: number): void {
  if (length <= 0) {
    return;
  }
  pending.set(id, (pending.get(id) ?? 0) + length);
  if (timer === null) {
    timer = setTimeout(flush, ACK_FLUSH_MS);
  }
}
