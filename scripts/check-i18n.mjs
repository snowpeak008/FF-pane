#!/usr/bin/env node
/**
 * check-i18n.mjs —— UI 硬编码文案扫描（T0.3，Node 内置模块实现，零第三方依赖）。
 *
 * 判定规则：扫描 apps/desktop/src/renderer 下的 .ts/.tsx 源码，
 * 用字符级状态机区分 注释 / 字符串 / 模板字面量 / 其余代码（含 JSX 文本），
 * 凡出现在「注释以外」的 CJK 字符（覆盖字符串字面量与 JSX 文本）即判为硬编码，
 * 逐条打印 文件:行:列 与所在行内容，并以退出码 1 结束；无违规退出码 0。
 *
 * 豁免机制：
 *  - locales/ 语言包目录（本就不在扫描根内，路径过滤再兜底一层）
 *  - *.test.ts / *.test.tsx 测试文件，以及冒烟自测 smoke.ts（同属测试代码）
 *  - 行注释与块注释（中文注释是仓库惯例，允许）
 *
 * 附带约定：renderer 内开发者日志（console.*、throw）不属于 UI 文案但同样会被检出，
 * 一律写英文或迁入语言包；主进程（src/main）不在扫描范围，日志语言不受限。
 *
 * 核心函数以命名导出暴露，供 scripts/check-i18n.test.mjs 单测。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 扫描根（相对仓库根）。 */
export const SCAN_ROOT = "apps/desktop/src/renderer";

/**
 * CJK 判定字符集：
 * 统一表意文字（U+4E00-U+9FFF）、扩展 A（U+3400-U+4DBF）、兼容表意（U+F900-U+FAFF）、
 * CJK 符号与标点（U+3000-U+303F，如 、。「」）、全半角形式（U+FF00-U+FFEF，如 ：！？）。
 */
const CJK_PATTERN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/** 判断单个字符是否属于 CJK 判定字符集。 */
export function isCjkChar(char) {
  return CJK_PATTERN.test(char);
}

/**
 * 文件豁免规则：只扫 .ts/.tsx；排除测试文件与 locales 路径段。
 * @param {string} relativePath 相对扫描根的路径（任意分隔符）
 */
export function shouldScanFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const fileName = normalized.split("/").at(-1) ?? normalized;
  if (!/\.tsx?$/.test(fileName)) {
    return false;
  }
  if (/\.test\.tsx?$/.test(fileName)) {
    return false;
  }
  // 冒烟自测（T0.2）按测试文件豁免：其中文诊断输出面向开发者终端，非 UI 文案
  if (fileName === "smoke.ts") {
    return false;
  }
  if (normalized.split("/").includes("locales")) {
    return false;
  }
  return true;
}

/**
 * 核心判定：返回源码中注释以外的全部 CJK 字符位置。
 * 状态机覆盖：行注释、块注释、单/双引号字符串、模板字面量（含 ${} 嵌套）；
 * 其余内容（含 JSX 文本、JSX 属性、正则字面量）一律按代码对待并参与检出。
 * @param {string} source
 * @returns {{ line: number; column: number; char: string; lineText: string }[]}
 */
export function findCjkViolations(source) {
  const violations = [];
  const sourceLines = source.split(/\r?\n/);
  /** @type {"code" | "lineComment" | "blockComment" | "single" | "double" | "template"} */
  let state = "code";
  /** 模板字面量 ${} 嵌套的花括号深度栈（支持 `a${cond ? `${x}` : "y"}b` 一类嵌套）。 */
  const templateBraceDepths = [];
  let line = 1;
  let column = 0;
  let i = 0;

  const record = (char) => {
    violations.push({
      line,
      column,
      char,
      lineText: (sourceLines[line - 1] ?? "").trim(),
    });
  };
  const advanceOver = (char) => {
    if (char === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "\n") {
      if (state === "lineComment") {
        state = "code";
      }
      advanceOver(char);
      i += 1;
      continue;
    }
    column += 1;

    switch (state) {
      case "code": {
        if (char === "/" && next === "/") {
          state = "lineComment";
          i += 2;
          column += 1;
          continue;
        }
        if (char === "/" && next === "*") {
          state = "blockComment";
          i += 2;
          column += 1;
          continue;
        }
        if (char === "'") {
          state = "single";
        } else if (char === '"') {
          state = "double";
        } else if (char === "`") {
          state = "template";
        } else if (char === "{" && templateBraceDepths.length > 0) {
          templateBraceDepths[templateBraceDepths.length - 1] += 1;
        } else if (char === "}" && templateBraceDepths.length > 0) {
          templateBraceDepths[templateBraceDepths.length - 1] -= 1;
          if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
            templateBraceDepths.pop();
            state = "template";
          }
        } else if (isCjkChar(char)) {
          record(char);
        }
        i += 1;
        continue;
      }
      case "single":
      case "double": {
        const quote = state === "single" ? "'" : '"';
        if (char === "\\" && next !== undefined) {
          advanceOver(next);
          i += 2;
          continue;
        }
        if (char === quote) {
          state = "code";
        } else if (isCjkChar(char)) {
          record(char);
        }
        i += 1;
        continue;
      }
      case "template": {
        if (char === "\\" && next !== undefined) {
          advanceOver(next);
          i += 2;
          continue;
        }
        if (char === "`") {
          state = "code";
        } else if (char === "$" && next === "{") {
          templateBraceDepths.push(1);
          state = "code";
          i += 2;
          column += 1;
          continue;
        } else if (isCjkChar(char)) {
          record(char);
        }
        i += 1;
        continue;
      }
      case "lineComment": {
        i += 1;
        continue;
      }
      case "blockComment": {
        if (char === "*" && next === "/") {
          state = "code";
          i += 2;
          column += 1;
          continue;
        }
        i += 1;
        continue;
      }
    }
  }
  return violations;
}

/**
 * 扫描目录：返回 { relativePath, violations } 列表（仅含有违规的文件）。
 * @param {string} rootDir 扫描根的绝对路径
 */
export async function scanDirectory(rootDir) {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const absolutePath = path.join(entry.parentPath, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);
    if (!shouldScanFile(relativePath)) {
      continue;
    }
    const violations = findCjkViolations(await readFile(absolutePath, "utf8"));
    if (violations.length > 0) {
      results.push({ relativePath, violations });
    }
  }
  return results;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scanRoot = path.join(repoRoot, SCAN_ROOT);
  const results = await scanDirectory(scanRoot);
  if (results.length === 0) {
    console.log(`[check-i18n] PASS —— ${SCAN_ROOT} 无硬编码 CJK 文案`);
    return 0;
  }
  let total = 0;
  for (const { relativePath, violations } of results) {
    const displayPath = `${SCAN_ROOT}/${relativePath.replaceAll("\\", "/")}`;
    for (const violation of violations) {
      total += 1;
      const location = `${displayPath}:${violation.line}:${violation.column}`;
      console.error(
        `[check-i18n] ${location} —— 硬编码 CJK 字符 "${violation.char}"：${violation.lineText}`,
      );
    }
  }
  console.error(
    `[check-i18n] FAIL —— 检出 ${total} 处硬编码 CJK 文案，请迁入 locales/*.json 并经 t() 引用`,
  );
  return 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await main();
}
