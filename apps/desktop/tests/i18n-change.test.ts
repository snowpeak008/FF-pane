import { describe, expect, it } from "vitest";
import { createLanguageChanger } from "../src/renderer/src/i18n/change-language";
import type { LanguageSetting, SupportedLanguage } from "../src/renderer/src/i18n/resolve";

/**
 * changeUiLanguage 的快速连续切换竞态（T8.1 验收 §6 登记，v0.9.x 清债单处置）。
 *
 * 场景：选「跟随系统」要先 await 一次 app:get-locale 再 changeLanguage；若用户在这次
 * IPC 往返期间又选了具体语言，旧的那次可能后到、把新选择覆盖掉。这里把 IPC 做成可手动
 * 放行的 deferred，精确制造「后选的先完成、先选的后到」这个顺序。
 * 被测对象是 i18n/index.ts 装配用的同一个 createLanguageChanger（三件副作用由注入替代）。
 */

interface Deferred {
  readonly promise: Promise<string>;
  readonly resolve: (locale: string) => void;
}

function deferred(): Deferred {
  let resolve!: (locale: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("changeUiLanguage：快速连续切换时以最后一次选择为准", () => {
  it("「跟随系统」的 IPC 尚未返回时又选了具体语言，过期的系统语言结果被丢弃", async () => {
    const persisted: LanguageSetting[] = [];
    const applied: SupportedLanguage[] = [];
    let pendingLocale = deferred();
    const change = createLanguageChanger({
      persist: (setting) => {
        persisted.push(setting);
      },
      fetchSystemLocale: () => pendingLocale.promise,
      applyLanguage: async (language) => {
        applied.push(language);
      },
    });

    // 第一次：选跟随系统，卡在 IPC 上
    const first = change("system");
    expect(applied).toEqual([]);

    // 第二次：紧接着选 en-US，不需要 IPC，立刻切
    const second = change("en-US");
    expect(await second).toBe(true);
    expect(applied).toEqual(["en-US"]);

    // 此时系统语言才回来（zh-CN）：若无序号守卫，这里会再 applyLanguage("zh-CN")
    // 把用户刚选的 en-US 覆盖掉——设置值是 en-US、界面却是中文
    pendingLocale.resolve("zh-CN");
    expect(await first).toBe(false);
    expect(applied).toEqual(["en-US"]);
    // 设置值按调用顺序写入，最终是最后一次选择
    expect(persisted).toEqual(["system", "en-US"]);

    // 守卫只丢过期结果，不影响之后正常的「跟随系统」
    pendingLocale = deferred();
    const third = change("system");
    pendingLocale.resolve("zh-CN");
    expect(await third).toBe(true);
    expect(applied).toEqual(["en-US", "zh-CN"]);
    expect(persisted).toEqual(["system", "en-US", "system"]);
  });
});
