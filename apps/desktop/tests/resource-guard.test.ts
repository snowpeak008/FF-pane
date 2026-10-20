/**
 * 开窗资源门槛：按设置拦；0 不检查；没设用默认（内存 1GB、磁盘 2GB）。
 */

import { describe, expect, it } from "vitest";
import { describeShortage, resourceLimitsFromConfig } from "../src/main/workbench/resource-guard";

const GB = 1024 ** 3;

describe("资源门槛", () => {
  it("没设用默认：内存 1GB、磁盘 2GB（16GB 机器常态的 1.8GB 可用不再误拦）", () => {
    const limits = resourceLimitsFromConfig({});
    expect(limits).toEqual({ memory: GB, disk: 2 * GB });
    expect(
      describeShortage({ freeMemoryBytes: 1.8 * GB, freeDiskBytes: { "C:\\": 50 * GB } }, limits),
    ).toBeUndefined();
    expect(
      describeShortage({ freeMemoryBytes: 0.6 * GB, freeDiskBytes: { "C:\\": 50 * GB } }, limits),
    ).toContain("可用内存只剩 0.6 GB");
    expect(
      describeShortage({ freeMemoryBytes: 8 * GB, freeDiskBytes: { "D:\\": 1 * GB } }, limits),
    ).toContain("D:\\ 可用空间只剩 1.0 GB");
  });

  it("设成 0 就不检查；设高了就按设置拦", () => {
    const off = resourceLimitsFromConfig({
      workbenchMinFreeMemoryMb: 0,
      workbenchMinFreeDiskMb: 0,
    });
    expect(
      describeShortage({ freeMemoryBytes: 0, freeDiskBytes: { "C:\\": 0 } }, off),
    ).toBeUndefined();
    const strict = resourceLimitsFromConfig({ workbenchMinFreeMemoryMb: 4096 });
    expect(describeShortage({ freeMemoryBytes: 3 * GB, freeDiskBytes: {} }, strict)).toContain(
      "低于设置的 4.0 GB",
    );
  });
});
