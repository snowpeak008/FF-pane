/**
 * T9.10 白屏回归的单测级拦截（T9.4b 顺手项）：
 * preload 产物 `require(...)` 目标仅限 `electron`。
 * 源码级同时钉住 contracts.ts 不对 @ff-pane/shared 做运行时再导出
 * （`pnpm test` 在 `pnpm build` 之前，产物不存在则跳过产物断言）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(here, "../out/preload/index.cjs");
const contractsSource = resolve(here, "../src/shared-ipc/contracts.ts");

describe("preload 产物依赖守卫（T9.10 白屏回归）", () => {
  it("contracts.ts 不对 @ff-pane/shared 做运行时再导出", () => {
    const text = readFileSync(contractsSource, "utf8");
    expect(text).not.toMatch(/export\s*\{[^}]*\}\s*from\s*["']@ff-pane\/shared["']/);
  });

  it.skipIf(!existsSync(artifact))("preload 产物 require() 目标仅限 electron", () => {
    const text = readFileSync(artifact, "utf8");
    const requires = [...text.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]);
    expect(requires.length).toBeGreaterThan(0);
    for (const target of requires) {
      expect(target, `非法 require：${target}`).toBe("electron");
    }
  });
});
