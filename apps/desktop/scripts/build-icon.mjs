/**
 * 应用图标：从 resources/icon 下的两张 SVG 生成 icon.png 和 icon.ico。
 *
 * - icon.svg：正式稿，用于 48px 及以上。
 * - icon-small.svg：小尺寸简化稿（F 放大、去掉文字行、加外框），用于 32px 及以下。
 * - icon.ico 每个尺寸都存 PNG 数据，安装包、窗口、根目录启动器共用这一个文件。
 *
 * 用法：node apps/desktop/scripts/build-icon.mjs
 * 渲染借用本机 Edge（Playwright channel: msedge），不下载浏览器。
 * 改了 SVG 之后重跑本脚本；根目录 FF-pane.exe 的图标是编译时写进去的，要另外重新编译启动器：
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize+
 *     /win32icon:apps\desktop\resources\icon\icon.ico /out:FF-pane.exe launcher\FF-pane.cs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const iconDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icon");
const SMALL_MAX = 32;
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;

const fullSvg = readFileSync(join(iconDir, "icon.svg"), "utf8");
const smallSvg = readFileSync(join(iconDir, "icon-small.svg"), "utf8");

async function renderPng(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${sized}</body></html>`,
  );
  return page.screenshot({ omitBackground: true });
}

/** ICO：6 字节文件头 + 每张 16 字节目录项 + 各张 PNG 原样拼接。256 在目录项里写 0。 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const browser = await chromium.launch({ channel: "msedge" });
try {
  const page = await browser.newPage();
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, png: await renderPng(page, size <= SMALL_MAX ? smallSvg : fullSvg, size) });
  }
  writeFileSync(join(iconDir, "icon.ico"), buildIco(images));
  writeFileSync(join(iconDir, "icon.png"), await renderPng(page, fullSvg, PNG_SIZE));
  console.log(`[build-icon] 已写出 ${join(iconDir, "icon.ico")} 与 icon.png`);
} finally {
  await browser.close();
}
