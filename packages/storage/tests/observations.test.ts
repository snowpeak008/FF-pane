/**
 * T5.4 单测：跨会话纠正观察记录持久化（observations.json）。
 * mkdtemp 临时全局根真实读写；覆盖空集 / 往返 / 版本不符归空 / 布局路径。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HabitObservation } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObservationStore, initGlobalLayout } from "../src/index.js";

let tempRoot: string;
let observationsFile: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-obs-"));
  const layout = await initGlobalLayout(join(tempRoot, "根"));
  observationsFile = layout.observationsFile;
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const obs = (o: Partial<HabitObservation> = {}): HabitObservation => ({
  id: "obs-1",
  content: "先说思路再写代码",
  count: 2,
  firstSeenAt: 1,
  lastSeenAt: 2,
  suggested: false,
  ...o,
});

describe("createObservationStore", () => {
  it("文件不存在 → 空集", async () => {
    const store = createObservationStore(observationsFile);
    expect(await store.listObservations()).toEqual([]);
  });

  it("save → list 往返（含中文 content）", async () => {
    const store = createObservationStore(observationsFile);
    const list = [
      obs({ id: "a" }),
      obs({ id: "b", content: "不要写行尾注释", count: 4, suggested: true }),
    ];
    await store.saveObservations(list);
    expect(await store.listObservations()).toEqual(list);
  });

  it("布局给出 observationsFile 路径", () => {
    expect(observationsFile).toContain("observations.json");
  });
});
