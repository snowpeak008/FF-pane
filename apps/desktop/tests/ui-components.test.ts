import { readFileSync } from "node:fs";
import { TASK_STATUSES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  formatErrorDetail,
  hasErrorDetail,
  summarizeError,
} from "../src/renderer/src/components/states/error-text";
import {
  CAPABILITY_BADGE,
  CAPABILITY_LEVELS,
  TASK_STATUS_BADGE,
} from "../src/renderer/src/components/ui/badge.variants";
import {
  BUTTON_ICON_SIZE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  buttonVariants,
} from "../src/renderer/src/components/ui/button.variants";
import { cardVariants } from "../src/renderer/src/components/ui/card.variants";
import {
  DIALOG_SIZES,
  dialogContentVariants,
  isConfirmationSatisfied,
} from "../src/renderer/src/components/ui/dialog.variants";
import { inputVariants, textareaVariants } from "../src/renderer/src/components/ui/input.variants";
import {
  tableCellVariants,
  tableRowVariants,
} from "../src/renderer/src/components/ui/table.variants";
import {
  ALL_NAV_ITEMS,
  DEFAULT_ROUTE_PATH,
  NAV_IDS,
  NAV_ITEMS,
  navItemById,
  navItemByShortcut,
  SETTINGS_NAV_ITEM,
} from "../src/renderer/src/layout/nav";
import { NAV_ICONS } from "../src/renderer/src/layout/nav-icons";
import { shortcutHint } from "../src/renderer/src/layout/shortcuts";
import { cn } from "../src/renderer/src/lib/cn";
import { PAGE_SHORTCUT_ORDER, shortcutIndexOfPage } from "../src/renderer/src/stores/pages";

/**
 * W3.1b 组件库单测。
 *
 * 覆盖面说明：@testing-library/react 未预装且本工单不许装依赖，
 * 因此这里只断言**纯逻辑**——cva 变体输出、状态映射表的完整性、导航/路由表结构、
 * 错误原文提取。DOM 级行为（真实渲染、点击、折叠、主题切换）由 CDP 冒烟客观验收。
 */

/** 设计系统 §0 硬性规则 2：theme.css 已清空默认调色板，写了也不生效。 */
const DEFAULT_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

/** 收集全部变体函数在所有取值组合下产出的类名串，供护栏断言批量扫描。 */
function allVariantClassNames(): readonly string[] {
  const output: string[] = [];
  for (const variant of BUTTON_VARIANTS) {
    for (const size of BUTTON_SIZES) {
      output.push(buttonVariants({ variant, size }));
      output.push(buttonVariants({ variant, size, iconOnly: true }));
    }
  }
  for (const padding of ["none", "compact", "default"] as const) {
    output.push(cardVariants({ padding }));
    output.push(cardVariants({ padding, interactive: true, selected: true }));
  }
  for (const size of DIALOG_SIZES) {
    output.push(dialogContentVariants({ size }));
  }
  output.push(inputVariants({ invalid: true }), inputVariants({ invalid: false }));
  output.push(textareaVariants({ invalid: true }), textareaVariants({ invalid: false }));
  output.push(tableRowVariants({ density: "compact", interactive: true, selected: true }));
  output.push(tableCellVariants({ align: "right", mono: true, truncate: true }));
  for (const style of Object.values(TASK_STATUS_BADGE)) {
    output.push(style.badge, style.dot);
  }
  for (const style of Object.values(CAPABILITY_BADGE)) {
    output.push(style.badge, style.dot);
  }
  return output;
}

describe("设计系统护栏：不出现失效的默认调色板类名", () => {
  it("全部变体输出只用语义 token 类名", () => {
    for (const className of allVariantClassNames()) {
      expect(className, `出现了默认调色板类名：${className}`).not.toMatch(DEFAULT_PALETTE);
    }
  });

  it("全部变体输出不含任意值语法（§4 禁止 p-[7px] 一类写法）", () => {
    for (const className of allVariantClassNames()) {
      expect(className, `出现了任意值类名：${className}`).not.toMatch(/-\[[^\]]+\]/);
    }
  });
});

describe("Button 变体（设计系统 §5.1）", () => {
  it("5 个层级各自对应规范里的类名串", () => {
    const byVariant = Object.fromEntries(
      BUTTON_VARIANTS.map((variant) => [variant, buttonVariants({ variant })]),
    );
    expect(byVariant["primary"]).toContain("bg-primary text-primary-fg hover:bg-primary-hover");
    expect(byVariant["secondary"]).toContain("border-border-strong");
    expect(byVariant["secondary"]).toContain("bg-surface");
    expect(byVariant["ghost"]).toContain("text-fg-muted");
    expect(byVariant["ghost"]).not.toContain("bg-primary");
    expect(byVariant["danger"]).toContain("bg-danger text-danger-fg hover:bg-danger-hover");
    expect(byVariant["link"]).toContain("text-primary-text");
    expect(byVariant["link"]).toContain("hover:underline");
  });

  it("3 个尺寸对应 24 / 28 / 32px 三档高度", () => {
    expect(buttonVariants({ size: "sm" })).toContain("h-6");
    expect(buttonVariants({ size: "md" })).toContain("h-7");
    expect(buttonVariants({ size: "lg" })).toContain("h-8");
  });

  it("默认层级是 secondary、默认尺寸是 md（primary 每屏至多一个，不能当默认）", () => {
    expect(buttonVariants()).toBe(buttonVariants({ variant: "secondary", size: "md" }));
    expect(buttonVariants()).toContain("h-7");
  });

  it("状态矩阵三件套在所有层级上一致：过渡 / 按下位移 / 禁用", () => {
    for (const variant of BUTTON_VARIANTS) {
      for (const size of BUTTON_SIZES) {
        const className = buttonVariants({ variant, size });
        expect(className).toContain("transition-colors duration-100");
        expect(className).toContain("active:translate-y-px");
        expect(className).toContain("disabled:cursor-not-allowed");
        expect(className).toContain("disabled:opacity-55");
        expect(className).toContain("disabled:pointer-events-none");
      }
    }
  });

  it("图标按钮压成正方形，且经 cn() 合并后横向内边距归零", () => {
    for (const size of BUTTON_SIZES) {
      const merged = cn(buttonVariants({ size, iconOnly: true }));
      expect(merged).toContain(`size-${{ sm: 6, md: 7, lg: 8 }[size]}`);
      expect(merged).not.toContain("px-2");
      expect(merged).not.toContain("px-3");
    }
  });

  it("图标尺寸表覆盖全部尺寸档且取值只有 14 / 16", () => {
    for (const size of BUTTON_SIZES) {
      expect([14, 16]).toContain(BUTTON_ICON_SIZE[size]);
    }
  });

  it("调用方 className 覆写在合并链末尾生效", () => {
    const merged = cn(buttonVariants({ variant: "primary" }), "h-8");
    expect(merged).toContain("h-8");
    expect(merged).not.toContain("h-7");
  });
});

describe("Badge 状态映射完整性（设计系统 §3.3 / §3.4 / §5.7）", () => {
  it("任务 7 态全枚举，键集合与领域层 TASK_STATUSES 完全一致", () => {
    expect(Object.keys(TASK_STATUS_BADGE).sort()).toEqual([...TASK_STATUSES].sort());
    expect(TASK_STATUSES).toHaveLength(7);
  });

  it("每一态都有徽章底色与圆点，且底色两两不同", () => {
    const badges = new Set<string>();
    for (const status of TASK_STATUSES) {
      const style = TASK_STATUS_BADGE[status];
      expect(style.badge.length, `${status} 缺徽章类名`).toBeGreaterThan(0);
      expect(style.dot.length, `${status} 缺圆点类名`).toBeGreaterThan(0);
      expect(style.badge).toContain(`text-status-${status}-text`);
      badges.add(style.badge);
    }
    expect(badges.size).toBe(TASK_STATUSES.length);
  });

  it("done ≠ accepted：两者必须是不同色源（产品核心规则）", () => {
    expect(TASK_STATUS_BADGE.done.badge).not.toBe(TASK_STATUS_BADGE.accepted.badge);
    expect(TASK_STATUS_BADGE.done.dot).not.toBe(TASK_STATUS_BADGE.accepted.dot);
    expect(TASK_STATUS_BADGE.done.badge).toContain("status-done");
    expect(TASK_STATUS_BADGE.accepted.badge).toContain("status-accepted");
  });

  it("cancelled 与 pending 同为中性灰，靠形状区分：虚线边框 + 空心圆环", () => {
    expect(TASK_STATUS_BADGE.cancelled.badge).toContain("border-dashed");
    expect(TASK_STATUS_BADGE.cancelled.dot).toContain("border");
    expect(TASK_STATUS_BADGE.cancelled.dot).not.toContain("bg-status-cancelled");
    expect(TASK_STATUS_BADGE.pending.badge).not.toContain("border-dashed");
    expect(TASK_STATUS_BADGE.pending.dot).toContain("bg-status-pending");
  });

  it("只有 running 带动效（徽章上唯一允许的动画）", () => {
    for (const status of TASK_STATUSES) {
      const hasPulse = TASK_STATUS_BADGE[status].dot.includes("animate-pulse");
      expect(hasPulse, `${status} 的动效状态不符`).toBe(status === "running");
    }
  });

  it("能力三态全枚举，并复用 success / warning / cancelled 三族（不新增 token）", () => {
    expect(Object.keys(CAPABILITY_BADGE).sort()).toEqual([...CAPABILITY_LEVELS].sort());
    expect(CAPABILITY_LEVELS).toHaveLength(3);
    expect(CAPABILITY_BADGE.yes.badge).toContain("success");
    expect(CAPABILITY_BADGE.partial.badge).toContain("warning");
    expect(CAPABILITY_BADGE.no.badge).toContain("status-cancelled");
  });
});

describe("Input / Card / Table / Dialog 变体", () => {
  it("输入框错误态只换边框色，正常态用 border-strong（§5.2）", () => {
    expect(inputVariants({ invalid: true })).toContain("border-danger");
    expect(inputVariants({ invalid: false })).toContain("border-border-strong");
    expect(inputVariants()).toContain("h-7");
    expect(inputVariants({ withLeadingIcon: true })).toContain("pl-7");
  });

  it("文本域与输入框共用基准，只在高度与可拉伸上不同", () => {
    expect(textareaVariants()).toContain("bg-surface");
    expect(textareaVariants()).toContain("resize-y");
    expect(textareaVariants()).not.toContain("h-7");
  });

  it("卡片三档内边距 + 可点击 / 选中态（§5.3），且不带阴影", () => {
    expect(cardVariants({ padding: "compact" })).toContain("p-3");
    expect(cardVariants({ padding: "default" })).toContain("p-4");
    expect(cardVariants({ padding: "none" })).toContain("p-0");
    expect(cardVariants({ interactive: true })).toContain("hover:bg-surface-hover");
    expect(cardVariants({ selected: true })).toContain("border-primary");
    for (const padding of ["none", "compact", "default"] as const) {
      expect(cardVariants({ padding })).not.toContain("shadow");
    }
  });

  it("列表行两档行高 + 选中左边条（§5.6），且无斑马纹类名", () => {
    expect(tableRowVariants({ density: "compact" })).toContain("h-7");
    expect(tableRowVariants({ density: "default" })).toContain("h-8");
    expect(tableRowVariants({ selected: true })).toContain("border-l-primary");
    expect(tableRowVariants({ interactive: true })).toContain("hover:bg-surface-hover");
    expect(tableRowVariants()).not.toContain("odd:");
    expect(tableRowVariants()).not.toContain("even:");
  });

  it("单元格：数值右对齐、元信息 font-mono（§4.3 / §5.6）", () => {
    expect(tableCellVariants({ align: "right" })).toContain("text-right");
    expect(tableCellVariants({ mono: true })).toContain("font-mono");
    expect(tableCellVariants({ mono: true })).toContain("text-xs");
  });

  it("对话框三档宽度，且阴影只出现在浮层上（§4.5 / §5.5）", () => {
    expect(dialogContentVariants({ size: "confirm" })).toContain("max-w-md");
    expect(dialogContentVariants({ size: "form" })).toContain("max-w-2xl");
    expect(dialogContentVariants({ size: "diff" })).toContain("max-w-4xl");
    for (const size of DIALOG_SIZES) {
      expect(dialogContentVariants({ size })).toContain("shadow-overlay");
      expect(dialogContentVariants({ size })).toContain("rounded-lg");
    }
  });
});

describe("超危险确认：输入名称匹配（设计系统 §5.5）", () => {
  it("未要求输入名称时始终放行", () => {
    expect(isConfirmationSatisfied(undefined, "")).toBe(true);
    expect(isConfirmationSatisfied(undefined, "whatever")).toBe(true);
    expect(isConfirmationSatisfied("   ", "")).toBe(true);
  });

  it("要求输入名称时必须逐字匹配", () => {
    expect(isConfirmationSatisfied("my-project", "my-project")).toBe(true);
    expect(isConfirmationSatisfied("my-project", "")).toBe(false);
    expect(isConfirmationSatisfied("my-project", "my-projec")).toBe(false);
    expect(isConfirmationSatisfied("my-project", "My-Project")).toBe(false);
  });

  it("只容忍首尾空白（从资源管理器复制路径常带尾空格）", () => {
    expect(isConfirmationSatisfied("my-project", "  my-project  ")).toBe(true);
    expect(isConfirmationSatisfied("my-project", "my project")).toBe(false);
  });
});

describe("错误原文提取（设计系统 §6.2：禁止把错误吞掉）", () => {
  it("Error 优先取 stack（含 Name: message 首行）", () => {
    const error = new Error("spawn codex ENOENT");
    const detail = formatErrorDetail(error);
    expect(detail).toContain("spawn codex ENOENT");
    expect(detail).toContain("Error");
    expect(hasErrorDetail(error)).toBe(true);
  });

  it("无 stack 的 Error 退回 Name: message", () => {
    const error = new Error("boom");
    error.stack = "";
    expect(formatErrorDetail(error)).toBe("Error: boom");
  });

  it("沿 cause 链展开上游原因", () => {
    const root = new Error("EACCES: permission denied");
    root.stack = "";
    const wrapper = new Error("writing run log failed", { cause: root });
    wrapper.stack = "";
    const detail = formatErrorDetail(wrapper);
    expect(detail).toContain("writing run log failed");
    expect(detail).toContain("Caused by: Error: EACCES: permission denied");
  });

  it("cause 自引用不会无限递归", () => {
    const error = new Error("loop");
    error.stack = "";
    Object.defineProperty(error, "cause", { value: error });
    const detail = formatErrorDetail(error);
    expect(detail.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("字符串、普通对象、null 各有确定行为", () => {
    expect(formatErrorDetail("  raw stderr output  ")).toBe("raw stderr output");
    expect(formatErrorDetail({ code: "E_IPC", exitCode: 127 })).toContain('"code": "E_IPC"');
    expect(formatErrorDetail(null)).toBe("");
    expect(formatErrorDetail(undefined)).toBe("");
    expect(hasErrorDetail(null)).toBe(false);
  });

  it("概括取一行：Error 取 message，其余取原文首行", () => {
    expect(summarizeError(new Error("timed out after 30s"))).toBe("timed out after 30s");
    expect(summarizeError("line one\nline two")).toBe("line one");
    expect(summarizeError(null)).toBe("");
  });
});

describe("导航表与路由表结构（项目设计计划 §11 / 设计系统 §7）", () => {
  it("七个主页面 + 一个设置入口，共八条路由", () => {
    expect(NAV_ITEMS).toHaveLength(7);
    expect(ALL_NAV_ITEMS).toHaveLength(8);
    expect(NAV_IDS).toHaveLength(7);
    expect(NAV_ITEMS.map((item) => item.id)).toEqual([...NAV_IDS]);
    expect(SETTINGS_NAV_ITEM.id).toBe("settings");
  });

  it("id 与 path 均唯一，path 一律以 / 开头", () => {
    const ids = ALL_NAV_ITEMS.map((item) => item.id);
    const paths = ALL_NAV_ITEMS.map((item) => item.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toContain(" ");
    }
  });

  it("Ctrl+1~7 连续覆盖七个主页面，设置页不占键位", () => {
    expect(NAV_ITEMS.map((item) => item.shortcut)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(SETTINGS_NAV_ITEM.shortcut).toBeUndefined();
    for (let index = 1; index <= 7; index += 1) {
      expect(navItemByShortcut(index)?.shortcut).toBe(index);
    }
    expect(navItemByShortcut(0)).toBeUndefined();
    expect(navItemByShortcut(8)).toBeUndefined();
  });

  it("每条都有语言包 key、承接工单与图标", () => {
    for (const item of ALL_NAV_ITEMS) {
      expect(item.labelKey).toBe(`nav.${item.id}.label`);
      expect(item.questionKey).toBe(`nav.${item.id}.question`);
      expect(item.ticket).toMatch(/^[WT]\d+(?:\.\d+)?[a-z]?$/);
      expect(NAV_ICONS[item.id]).toBeDefined();
    }
    expect(Object.keys(NAV_ICONS)).toHaveLength(ALL_NAV_ITEMS.length);
  });

  it("默认落地页是项目列表，且在路由表内", () => {
    expect(DEFAULT_ROUTE_PATH).toBe("/projects");
    expect(ALL_NAV_ITEMS.some((item) => item.path === DEFAULT_ROUTE_PATH)).toBe(true);
  });

  it("navItemById 按 id 命中", () => {
    expect(navItemById("runs").path).toBe("/runs");
    expect(navItemById("settings")).toBe(SETTINGS_NAV_ITEM);
  });
});

describe("页面顺序只此一份注册表（T8.1 收敛）", () => {
  it("导航表的 id 序列就是页面注册表的键位序列（同一个数组，不是抄的）", () => {
    // toBe 是引用相等：抄一份内容相同的数组会红，而 toEqual 不会
    expect(NAV_IDS).toBe(PAGE_SHORTCUT_ORDER);
  });

  it("每条导航项的 shortcut 与注册表算出的序号逐项一致", () => {
    for (const item of NAV_ITEMS) {
      expect(item.shortcut, `${item.id} 的键位序号与注册表不符`).toBe(shortcutIndexOfPage(item.id));
    }
  });

  it("侧栏的键位提示串与 §7 的写法一致", () => {
    expect(shortcutHint(1)).toBe("Ctrl+1");
    expect(shortcutHint(7)).toBe("Ctrl+7");
  });

  it("布局层不再自带页面切换键位的匹配实现（键位判定唯一，归 command/ 注册表）", async () => {
    // T8.1 之前这里有 matchPageShortcut，与注册表的 nav-page-by-index 是同一组键位的
    // 第二个实现，两处都监听会让一次按键跳两页。它随 AppLayout 的 keydown 监听一并删除。
    const layoutShortcuts: Record<string, unknown> = await import(
      "../src/renderer/src/layout/shortcuts"
    );
    expect(Object.keys(layoutShortcuts)).toEqual(["shortcutHint"]);
  });
});

/** 组件库与布局引用到的全部语言包 key（硬编码在此，与代码里的 t() 调用一一对应）。 */
const REQUIRED_LOCALE_KEYS: readonly string[] = [
  "common.cancel",
  "common.confirm",
  "common.close",
  "common.retry",
  "common.copy",
  "common.copied",
  "common.loading",
  "common.errorDetail.show",
  "common.errorDetail.hide",
  "common.confirmName.label",
  "common.confirmName.hint",
  "nav.primary",
  "nav.collapse",
  "nav.expand",
  "page.placeholder.message",
  "page.notFound.message",
  "page.notFound.action",
  ...ALL_NAV_ITEMS.flatMap((item) => [item.labelKey, item.questionKey]),
  ...TASK_STATUSES.map((status) => `task.status.${status}`),
  ...CAPABILITY_LEVELS.map((level) => `capability.level.${level}`),
];

function readLocale(tag: string): Record<string, unknown> {
  const url = new URL(`../../../locales/${tag}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function lookup(pack: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((node, segment) => {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    return (node as Record<string, unknown>)[segment];
  }, pack);
}

describe("组件库文案齐备（设计系统 §0 规则 6：文案全在语言包）", () => {
  for (const tag of ["zh-CN", "en-US"]) {
    it(`${tag} 覆盖全部被引用的 key`, () => {
      const pack = readLocale(tag);
      for (const key of REQUIRED_LOCALE_KEYS) {
        const value = lookup(pack, key);
        expect(typeof value, `${tag} 缺 key：${key}`).toBe("string");
        expect((value as string).trim().length, `${tag} 的 ${key} 为空`).toBeGreaterThan(0);
      }
    });
  }

  it("插值占位符两语言一致（占位页与超危险确认）", () => {
    for (const tag of ["zh-CN", "en-US"]) {
      const pack = readLocale(tag);
      const placeholder = lookup(pack, "page.placeholder.message") as string;
      expect(placeholder).toContain("{{page}}");
      expect(placeholder).toContain("{{ticket}}");
      expect(lookup(pack, "common.confirmName.label")).toContain("{{name}}");
    }
  });
});
