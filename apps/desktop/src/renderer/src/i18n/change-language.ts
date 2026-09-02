/**
 * 界面语言切换的时序逻辑（v0.9.x 清债单，T8.1 验收 §6 登记的竞态）。
 *
 * 本文件不依赖 DOM / i18next：localStorage 写入、系统语言 IPC、i18next.changeLanguage
 * 三件副作用全部由调用方经 `LanguageChangeIo` 注入，因此可在 vitest node 环境里用
 * 手动放行的 deferred 精确复现「后选的先完成、先选的后到」这个顺序（与 ipc/api.ts
 * 「纯逻辑可单测」同一取舍）。装配在 i18n/index.ts。
 */
import { type LanguageSetting, resolveUiLanguage, type SupportedLanguage } from "./resolve";

export interface LanguageChangeIo {
  /** 持久化设置值（三态）。不抛：写不进也要继续切语言。 */
  readonly persist: (setting: LanguageSetting) => void;
  /** 现问一次系统语言（BCP 47；失败时给空串，由解析层落回退语言）。 */
  readonly fetchSystemLocale: () => Promise<string>;
  /** 真正让界面切到某种语言（i18next.changeLanguage）。 */
  readonly applyLanguage: (language: SupportedLanguage) => Promise<void>;
}

/** 一次切换的结果：过期（被更晚的调用取代）时为 false。 */
export type ChangeLanguage = (setting: LanguageSetting) => Promise<boolean>;

/**
 * 构造带序号守卫的切换函数。
 *
 * 选「跟随系统」要先 await 一次 IPC 才知道该切成什么，若用户在这次往返期间又选了
 * 具体语言，两次 applyLanguage 的完成顺序不受控，旧的那次可能后到、把新选择覆盖掉
 * ——设置值与选择器都已是新值，界面却停在旧语言，重启才自愈。处置：每次调用先领一个
 * 递增序号，await 回来后发现自己已不是最新一号就放弃，不再 applyLanguage。
 */
export function createLanguageChanger(io: LanguageChangeIo): ChangeLanguage {
  let sequence = 0;
  return async (setting) => {
    sequence += 1;
    const mine = sequence;
    io.persist(setting);
    const language =
      setting === "system" ? resolveUiLanguage(null, await io.fetchSystemLocale()) : setting;
    if (mine !== sequence) {
      // 等 IPC 期间用户又选了别的：这次的结果已过期，交给最新那次去切
      return false;
    }
    await io.applyLanguage(language);
    return true;
  };
}
