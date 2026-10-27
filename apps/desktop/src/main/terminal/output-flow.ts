/**
 * 终端输出流控（T11.0d）。不碰 Electron，单测直接测。
 *
 * 以前主进程每 12ms 把每个终端的输出都推给界面：没显示的终端（别的标签页）界面收了也是丢掉，
 * 界面忙或卡住时消息就堆在主进程里。现在：
 * - 只推界面挂着的终端（attach）；没挂的照样进回放缓冲，挂上时界面自己取回放。
 * - 界面写进 xterm 后回执（ack）。没回执的超过 highWater 就先攒着；攒的超过 maxHeld 就扔掉，
 *   记下要重画，等界面缓过来（没回执的降到 lowWater 以下）发一次整份回放并让它先清屏。
 * 字节数按字符串长度算，两边一致。
 */

export interface OutputFlowOptions {
  readonly highWater: number;
  readonly lowWater: number;
  readonly maxHeld: number;
  readonly send: (id: string, data: string, reset: boolean) => void;
  /** 重画时用的整份回放。 */
  readonly replay: (id: string) => string;
}

export const OUTPUT_FLOW_DEFAULTS = {
  highWater: 1024 * 1024,
  lowWater: 256 * 1024,
  maxHeld: 1024 * 1024,
} as const;

interface FlowState {
  /** 挂着它的界面数（同一终端可能被两个视图同时挂，按引用计数）。 */
  attached: number;
  unacked: number;
  held: string[];
  heldLength: number;
  resync: boolean;
}

export class OutputFlow {
  private readonly states = new Map<string, FlowState>();

  constructor(private readonly options: OutputFlowOptions) {}

  attach(id: string): void {
    const state = this.states.get(id);
    if (state !== undefined) {
      state.attached += 1;
      return;
    }
    this.states.set(id, { attached: 1, unacked: 0, held: [], heldLength: 0, resync: false });
  }

  detach(id: string): void {
    const state = this.states.get(id);
    if (state === undefined) {
      return;
    }
    state.attached -= 1;
    if (state.attached <= 0) {
      this.states.delete(id);
    }
  }

  /** 终端没了。 */
  remove(id: string): void {
    this.states.delete(id);
  }

  isAttached(id: string): boolean {
    return this.states.has(id);
  }

  push(id: string, data: string): void {
    const state = this.states.get(id);
    if (state === undefined || data.length === 0) {
      return;
    }
    if (state.resync) {
      return;
    }
    if (state.unacked < this.options.highWater && state.held.length === 0) {
      state.unacked += data.length;
      this.options.send(id, data, false);
      return;
    }
    state.held.push(data);
    state.heldLength += data.length;
    if (state.heldLength > this.options.maxHeld) {
      state.held = [];
      state.heldLength = 0;
      state.resync = true;
    }
  }

  ack(id: string, length: number): void {
    const state = this.states.get(id);
    if (state === undefined) {
      return;
    }
    state.unacked = Math.max(0, state.unacked - Math.max(0, length));
    if (state.unacked >= this.options.lowWater) {
      return;
    }
    if (state.resync) {
      state.resync = false;
      const full = this.options.replay(id);
      state.unacked += full.length;
      this.options.send(id, full, true);
      return;
    }
    if (state.held.length > 0) {
      const data = state.held.join("");
      state.held = [];
      state.heldLength = 0;
      state.unacked += data.length;
      this.options.send(id, data, false);
    }
  }

  /** 诊断用。 */
  snapshot(id: string): Readonly<FlowState> | undefined {
    const state = this.states.get(id);
    return state === undefined ? undefined : { ...state, held: [...state.held] };
  }
}
