// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试夹具是"待扫描的源码"，需要以普通字符串承载 ${} 字面片段
import { describe, expect, it } from "vitest";
import { findCjkViolations, isCjkChar, shouldScanFile } from "./check-i18n.mjs";

describe("check-i18n / isCjkChar", () => {
  it("识别汉字、CJK 标点与全角符号", () => {
    for (const char of ["中", "文", "。", "、", "：", "！"]) {
      expect(isCjkChar(char), `应判为 CJK：${char}`).toBe(true);
    }
  });

  it("放行 ASCII 与常见西文符号", () => {
    for (const char of ["a", "Z", "0", ".", ":", "…", "·", " "]) {
      expect(isCjkChar(char), `不应判为 CJK：${char}`).toBe(false);
    }
  });
});

describe("check-i18n / findCjkViolations", () => {
  it("检出 JSX 文本中的 CJK", () => {
    const source = 'const x = <main>正在加载</main>;\nconst y = "ok";\n';
    const violations = findCjkViolations(source);
    expect(violations.length).toBe(4);
    expect(violations[0]).toMatchObject({ line: 1, column: 17, char: "正" });
    expect(violations[0].lineText).toContain("<main>");
  });

  it("检出单引号、双引号与模板字面量中的 CJK", () => {
    const source = ["const a = '错';", 'const b = "误";', "const c = `文${a}案`;"].join("\n");
    const chars = findCjkViolations(source).map((v) => v.char);
    expect(chars).toEqual(["错", "误", "文", "案"]);
  });

  it("行注释与块注释中的 CJK 一律豁免", () => {
    const source = [
      "// 行注释：中文允许",
      "/* 块注释：中文允许",
      " * 跨行也允许 */",
      'const ok = "clean";',
      "const alsoOk = 1; // 尾随注释：中文允许",
    ].join("\n");
    expect(findCjkViolations(source)).toEqual([]);
  });

  it("模板字面量 ${} 内的代码与注释不误报，其中的字符串照常检出", () => {
    const clean = "const s = `count: ${items.length /* 数量 */}`;";
    expect(findCjkViolations(clean)).toEqual([]);

    const dirty = 'const s = `count: ${label("个数")}`;';
    expect(findCjkViolations(dirty).map((v) => v.char)).toEqual(["个", "数"]);
  });

  it("嵌套模板字面量整体可检出", () => {
    const source = "const s = `外${cond ? `内${x}层` : fallback}部`;";
    expect(findCjkViolations(source).map((v) => v.char)).toEqual(["外", "内", "层", "部"]);
  });

  it("转义字符不干扰状态机，行列号按源码位置上报", () => {
    const source = 'const a = "\\" ok";\nconst b = <p>第二行</p>;';
    const violations = findCjkViolations(source);
    expect(violations.map((v) => v.char)).toEqual(["第", "二", "行"]);
    expect(violations[0]).toMatchObject({ line: 2, column: 14 });
  });

  it("纯英文源码零违规", () => {
    const source = 'const t = useTranslation();\nreturn <main>{t("app.loading")}</main>;\n';
    expect(findCjkViolations(source)).toEqual([]);
  });
});

describe("check-i18n / shouldScanFile", () => {
  it("只扫 .ts/.tsx 源码", () => {
    expect(shouldScanFile("src/App.tsx")).toBe(true);
    expect(shouldScanFile("src/i18n/index.ts")).toBe(true);
    expect(shouldScanFile("index.html")).toBe(false);
    expect(shouldScanFile("assets/logo.svg")).toBe(false);
  });

  it("豁免测试文件、冒烟自测与 locales 目录（Windows 反斜杠路径同样生效）", () => {
    expect(shouldScanFile("src/App.test.tsx")).toBe(false);
    expect(shouldScanFile("tests/resolve.test.ts")).toBe(false);
    expect(shouldScanFile("src/smoke.ts")).toBe(false);
    expect(shouldScanFile("locales/zh-CN.json")).toBe(false);
    expect(shouldScanFile("src\\locales\\extra.ts")).toBe(false);
    expect(shouldScanFile("src\\App.tsx")).toBe(true);
  });
});
