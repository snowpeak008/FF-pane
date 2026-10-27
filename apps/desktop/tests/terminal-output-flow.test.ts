/**
 * T11.0d：终端输出流控——只推挂着的终端，没回执的太多就攒着，攒太多就重画。
 */

import { describe, expect, it } from "vitest";
import { OutputFlow } from "../src/main/terminal/output-flow";

function setup(replay = "FULL") {
  const sent: { id: string; data: string; reset: boolean }[] = [];
  const flow = new OutputFlow({
    highWater: 10,
    lowWater: 4,
    maxHeld: 20,
    send: (id, data, reset) => sent.push({ id, data, reset }),
    replay: () => replay,
  });
  return { flow, sent };
}

describe("OutputFlow", () => {
  it("没挂着的终端不推", () => {
    const { flow, sent } = setup();
    flow.push("t1", "hello");
    expect(sent).toEqual([]);
    flow.attach("t1");
    flow.push("t1", "hello");
    expect(sent).toEqual([{ id: "t1", data: "hello", reset: false }]);
  });

  it("没回执的到上限就攒着，回执后一次补发", () => {
    const { flow, sent } = setup();
    flow.attach("t1");
    flow.push("t1", "aaaaaa");
    flow.push("t1", "bbbbbb");
    expect(sent.map((s) => s.data)).toEqual(["aaaaaa", "bbbbbb"]);
    flow.push("t1", "cc");
    flow.push("t1", "dd");
    expect(sent).toHaveLength(2);
    flow.ack("t1", 6);
    expect(sent).toHaveLength(2);
    flow.ack("t1", 6);
    expect(sent[2]).toEqual({ id: "t1", data: "ccdd", reset: false });
  });

  it("攒着时新来的也排在后面，顺序不乱", () => {
    const { flow, sent } = setup();
    flow.attach("t1");
    flow.push("t1", "0123456789");
    flow.push("t1", "x");
    flow.ack("t1", 3);
    flow.push("t1", "y");
    expect(sent.map((s) => s.data)).toEqual(["0123456789"]);
    flow.ack("t1", 7);
    expect(sent.map((s) => s.data)).toEqual(["0123456789", "xy"]);
  });

  it("攒的太多就扔掉，缓过来后发整份回放并要求清屏", () => {
    const { flow, sent } = setup("REPLAY-ALL");
    flow.attach("t1");
    flow.push("t1", "0123456789");
    for (let i = 0; i < 5; i += 1) {
      flow.push("t1", "zzzzz");
    }
    expect(flow.snapshot("t1")?.resync).toBe(true);
    flow.push("t1", "ignored-while-resync");
    flow.ack("t1", 10);
    expect(sent.at(-1)).toEqual({ id: "t1", data: "REPLAY-ALL", reset: true });
    flow.push("t1", "next");
    expect(sent).toHaveLength(2);
    flow.ack("t1", 10);
    expect(sent.at(-1)).toEqual({ id: "t1", data: "next", reset: false });
  });

  it("两个视图挂同一终端：都摘掉才停推；终端没了就清掉", () => {
    const { flow, sent } = setup();
    flow.attach("t1");
    flow.attach("t1");
    flow.detach("t1");
    flow.push("t1", "a");
    expect(sent).toHaveLength(1);
    flow.detach("t1");
    flow.push("t1", "b");
    expect(sent).toHaveLength(1);
    flow.attach("t2");
    flow.remove("t2");
    expect(flow.isAttached("t2")).toBe(false);
  });
});
