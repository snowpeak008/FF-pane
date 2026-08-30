/**
 * T5.4 来源三单测：系统观察建议（设计文档 §8.2.4）。纯函数。
 * 覆盖：纠正识别（marker+短句）、跨调用累计、阈值触发一次、suggested 去重、相似归并。
 */

import type { HabitObservation } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { isCorrectiveMessage, observeCorrection } from "../src/index.js";

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `obs-${counter}`;
};

describe("isCorrectiveMessage", () => {
  it("带纠正词的短祈使句 → true", () => {
    expect(isCorrectiveMessage("先说思路再写代码")).toBe(true);
    expect(isCorrectiveMessage("不要写行尾注释")).toBe(true);
    expect(isCorrectiveMessage("下次记得先跑测试")).toBe(true);
  });

  it("无纠正词 / 过长 / 空 → false", () => {
    expect(isCorrectiveMessage("帮我做个登录页")).toBe(false);
    expect(isCorrectiveMessage("")).toBe(false);
    expect(isCorrectiveMessage(`先${"啊".repeat(90)}`)).toBe(false);
  });
});

describe("observeCorrection", () => {
  it("非纠正消息：原样返回，changed=false，无 suggestion", () => {
    const r = observeCorrection({ observations: [], message: "帮我做个登录页", now: 1, newId });
    expect(r.changed).toBe(false);
    expect(r.observations).toEqual([]);
    expect(r.suggestion).toBeUndefined();
  });

  it("累计到阈值（4）才建议一次；之后同类纠正不再重复建议", () => {
    let obs: readonly HabitObservation[] = [];
    const feed = (n: number) => {
      const last = observeCorrection({
        observations: obs,
        message: "先说思路再写代码",
        now: n,
        newId,
      });
      obs = last.observations;
      return last;
    };
    expect(feed(1).suggestion).toBeUndefined();
    expect(feed(2).suggestion).toBeUndefined();
    expect(feed(3).suggestion).toBeUndefined();
    const fourth = feed(4);
    expect(fourth.suggestion).toMatchObject({ count: 4 });
    expect(fourth.suggestion?.content).toContain("先说思路");
    // 第 5 次不再建议（suggested 去重）
    expect(feed(5).suggestion).toBeUndefined();
  });

  it("不同措辞但同义（高相似）归并到同一条累计", () => {
    let obs: readonly HabitObservation[] = [];
    for (const msg of ["先说思路再写代码", "先说思路，再写代码", "先说说思路再写代码"]) {
      obs = observeCorrection({ observations: obs, message: msg, now: 1, newId }).observations;
    }
    expect(obs).toHaveLength(1);
    expect(obs[0]?.count).toBe(3);
  });

  it("不相干的纠正各自独立累计", () => {
    let obs: readonly HabitObservation[] = [];
    obs = observeCorrection({
      observations: obs,
      message: "先跑测试再改",
      now: 1,
      newId,
    }).observations;
    obs = observeCorrection({
      observations: obs,
      message: "不要写行尾注释",
      now: 1,
      newId,
    }).observations;
    expect(obs).toHaveLength(2);
  });

  it("自定义阈值可覆盖", () => {
    const r1 = observeCorrection({
      observations: [],
      message: "先说思路",
      now: 1,
      newId,
      threshold: 1,
    });
    expect(r1.suggestion).toMatchObject({ count: 1 });
  });
});
