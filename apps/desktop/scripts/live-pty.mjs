/**
 * T10.1 打包产物实证：安装目录里 @lydell/node-pty 能从 asar 解析并 spawn。
 *
 * 用法（先 electron-builder --dir 出 win-unpacked）：
 *   node apps/desktop/scripts/live-pty.mjs
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(desktopDir, "release", "win-unpacked");
const electronExe = join(unpacked, "FF-pane.exe");
const appAsar = join(unpacked, "resources", "app.asar");
const unpackedPty = join(
  unpacked,
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "@lydell",
  "node-pty-win32-x64",
  "prebuilds",
  "win32-x64",
  "conpty.node",
);

if (process.platform !== "win32") {
  console.log("[live-pty] skip: Windows-only check");
  process.exit(0);
}
if (!existsSync(electronExe)) {
  console.error(`[live-pty] FAIL missing ${electronExe} — run electron-builder --dir first`);
  process.exit(1);
}
if (!existsSync(unpackedPty)) {
  console.error(`[live-pty] FAIL conpty.node not unpacked at ${unpackedPty}`);
  process.exit(1);
}
console.log("[live-pty] PASS unpacked conpty.node present");

const marker = "ffpane-live-pty-ok";
const inAppScript = `
const { createRequire } = require('node:module');
const { join } = require('node:path');
const appRequire = createRequire(${JSON.stringify(join(appAsar, "index.js"))});
const ptyPath = appRequire.resolve('@lydell/node-pty');
const normalize = (value) => String(value ?? '').replaceAll('\\\\', '/');
const asarPrefix = normalize(${JSON.stringify(join(appAsar, "node_modules", "@lydell", "node-pty"))}) + '/';
if (!normalize(ptyPath).startsWith(asarPrefix) && !normalize(ptyPath).includes('app.asar')) {
  console.error(JSON.stringify({ step: 'fail', reason: 'resolve-not-from-asar', ptyPath }));
  process.exit(3);
}
const pty = appRequire('@lydell/node-pty');
const term = pty.spawn('cmd.exe', ['/d', '/s', '/c', 'echo ${marker}'], {
  name: 'xterm',
  cols: 80,
  rows: 24,
  cwd: process.env.TEMP || '.',
});
let buf = '';
term.onData((d) => {
  buf += d;
  if (buf.includes('${marker}')) {
    console.log(JSON.stringify({ step: 'ok', ptyPath, buf }));
    try { term.kill(); } catch (_) {}
    process.exit(0);
  }
});
term.onExit(() => {
  if (buf.includes('${marker}')) {
    console.log(JSON.stringify({ step: 'ok', ptyPath, buf }));
    process.exit(0);
  }
  console.error(JSON.stringify({ step: 'fail', reason: 'no-marker', buf }));
  process.exit(5);
});
setTimeout(() => {
  console.error(JSON.stringify({ step: 'fail', reason: 'timeout', buf }));
  try { term.kill(); } catch (_) {}
  process.exit(6);
}, 10000);
`;

const child = spawn(electronExe, ["-e", inAppScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});
child.on("exit", (code) => {
  if (code === 0 && stdout.includes('"step":"ok"')) {
    console.log("[live-pty] PASS load+spawn from packaged asar");
    console.log(stdout.trim());
    console.log("[live-pty] ALL PASS");
    process.exit(0);
  }
  console.error(`[live-pty] FAIL exit=${String(code)}`);
  console.error(`stdout: ${stdout}`);
  console.error(`stderr: ${stderr}`);
  process.exit(code ?? 1);
});
