/**
 * T8.2 打包产物实证：Job Object 圈禁在**安装版**里真的能用。
 *
 * 为什么必须单独跑这一条（同 T6.6 的 MCP sidecar 实证）：单测跑在仓库源码树上，
 * 而 koffi 是原生模块——它在打包后能否加载，取决于三件单测覆盖不到的事：
 *   1. `@koromix/koffi-<platform>-<arch>/**` 有没有被 asarUnpack 解出来
 *      （asar 内的虚拟路径喂不进 dlopen）；
 *   2. koffi 的平台包解析逻辑在 app.asar.unpacked 布局下走不走得通；
 *   3. Electron 运行时（非 Node）能否 dlopen 这个 .node。
 * 任何一条不成立，产品在用户机器上就会静默降级回 taskkill /T ——
 * 功能看起来正常，只有「取消之后有进程赖着」这个症状，极难归因。
 *
 * 用法（先 pnpm package 出 win-unpacked）：
 *   node apps/desktop/scripts/live-job-object.mjs
 *
 * 判据四条，全过才算通过：
 *   ① 打包产物里的 koffi 能加载（不是仓库 node_modules 里的那份）——
 *      **须核对 `require.resolve('koffi')` 的路径以 app.asar 为前缀**。release/ 在仓库树内，
 *      asar 里若没有 koffi，Node 的向上解析会一路走到仓库根 node_modules/koffi 并照样成功，
 *      只看「加载没抛」会假阳性（T8.2 验收 §5-7 登记，v0.9.x 清债单补上）。
 *      electron-builder.yml 排除了 koffi 的源码/头文件/文档之后，这条同时证明「排除没伤到运行期 JS」。
 *   ② 能建 Job 并把进程圈进去
 *   ③ 被重父化、已脱离进程树的后台进程确实被 TerminateJobObject 带走
 *   ④ 对照：同一场景下 taskkill /T 带不走它（证明这条能力不是白加的）
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(desktopDir, "release", "win-unpacked");
const electronExe = join(unpacked, "FF-pane.exe");
/**
 * 按**生产同款方式**取 koffi：从 asar 内的 app 目录按模块名 require。
 *
 * 布局是分开的（这正是要验的一环）：koffi 的 JS 包在 app.asar **里**，而它真正
 * dlopen 的平台包 `@koromix/koffi-win32-x64/win32_x64/koffi.node` 被 asarUnpack
 * 解到了 app.asar.unpacked。Electron 的 asar 集成会把后者的路径重定向过去——
 * 这条链路走不走得通，只有在打包产物上跑才知道。
 */
const appAsar = join(unpacked, "resources", "app.asar");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 复现场景的三层结构（与 tests/process.test.ts 的回归用例同形）：
 *   顶层（取消时仍活着）→ 中间层（起完后台进程立刻退出）→ 后台进程（被重父化）
 * 逐层用 JSON.stringify 嵌进去，不手写多层引号——手写过一版，转义错了会静默变成
 * 「拿不到 pid」，于是判据在一个不存在的进程上求值、结论完全失真。
 */
const MID_SCRIPT = [
  "const {spawn}=require('node:child_process');",
  "const kid=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore',detached:true});",
  "kid.unref();",
  "process.stdout.write(String(kid.pid)+'\\n');",
  "process.exit(0);",
].join("");

const TOP_SCRIPT = [
  "const {spawn}=require('node:child_process');",
  `const mid=spawn(process.execPath,['-e',${JSON.stringify(MID_SCRIPT)}],{stdio:['ignore','pipe','ignore']});`,
  "mid.stdout.on('data',d=>process.stdout.write(d));",
  "setInterval(()=>{},1000);",
].join("");

function sh(cmd, args) {
  return new Promise((resolve_) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
    });
    p.stderr.on("data", (d) => {
      out += d.toString();
    });
    p.once("close", (code) => resolve_({ code, out }));
    p.once("error", () => resolve_({ code: -1, out }));
  });
}

async function pidAlive(pid) {
  const { out } = await sh("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
  return out.includes(`"${pid}"`);
}

if (process.platform !== "win32") {
  console.log("[live-job] 跳过：Job Object 是 Windows 专有能力");
  process.exit(0);
}
if (!existsSync(electronExe)) {
  console.error(`[live-job] 找不到打包产物：${electronExe}\n先跑 pnpm package`);
  process.exit(1);
}

/**
 * 在**打包产物的 Electron** 里执行的脚本（ELECTRON_RUN_AS_NODE=1 走 Node 模式）。
 * 以 app.asar 内的 app 为解析基准按模块名 require koffi —— 要验的就是「asar 里那份 JS
 * 壳 + 被解包到 app.asar.unpacked 的 .node」这条链路（布局见上方 appAsar 注释）。
 */
const inAppScript = `
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
// 以 asar 内的 app 为解析基准按模块名 require —— 与产品运行时同一条路径
const appRequire = createRequire(${JSON.stringify(join(appAsar, "index.js"))});
// 判据①的路径核对：解析到的必须是 asar 里那份，而不是仓库根 node_modules 里的
const koffiPath = appRequire.resolve('koffi');
const koffi = appRequire('koffi');
// 真正 dlopen 的 .node 应来自 @koromix/koffi-<platform>-<arch>（asarUnpack 解包目标）
const nativePath = Object.keys(require.cache).find((k) => k.endsWith('koffi.node')) ?? null;
const lib = koffi.load('kernel32.dll');
const CreateJobObjectW = lib.func('void* CreateJobObjectW(void* a, const char16_t* n)');
const AssignProcessToJobObject = lib.func('bool AssignProcessToJobObject(void* j, void* p)');
const TerminateJobObject = lib.func('bool TerminateJobObject(void* j, uint32_t c)');
const SetInformationJobObject = lib.func('bool SetInformationJobObject(void* j, int c, void* i, uint32_t l)');
const OpenProcess = lib.func('void* OpenProcess(uint32_t a, bool i, uint32_t p)');

const job = CreateJobObjectW(null, null);
const info = Buffer.alloc(144);
info.writeUInt32LE(0x2000, 16);
SetInformationJobObject(job, 9, info, info.length);

// 三层结构：顶层存活，中间层起后台进程后立刻退出（后台进程被重父化）
const TOP = ${JSON.stringify(TOP_SCRIPT)};

const top = spawn(process.execPath, ['-e', TOP], { windowsHide: true });
const h = OpenProcess(0x0100 | 0x0001, false, top.pid);
const assigned = AssignProcessToJobObject(job, h);

let out = '';
top.stdout.on('data', (d) => { out += d.toString(); });

let orphanPid = 0;
setTimeout(() => {
  orphanPid = Number(out.trim());
  console.log(JSON.stringify({
    step: 'ready', koffiLoaded: true, koffiPath, nativePath, assigned, topPid: top.pid, orphanPid,
  }));
  // 先让宿主用 taskkill /T 试一次（判据④），宿主再回来叫我们终止 Job
  process.stdin.once('data', () => {
    // 终止前先取证：那个已脱离进程树的后台进程，确实还在我们这个 Job 里
    // （这正是 Job Object 与 taskkill /T 的分野——前者看 Job 归属，后者看父子表）
    const IsProcessInJob = lib.func('bool IsProcessInJob(void* p, void* j, _Out_ bool* r)');
    let inJob = null;
    try {
      const h2 = OpenProcess(0x0400 /* PROCESS_QUERY_INFORMATION */, false, orphanPid);
      if (h2) {
        const r = [false];
        inJob = IsProcessInJob(h2, job, r) ? r[0] : 'query-failed';
      }
    } catch (e) { inJob = 'err:' + e.message; }
    const terminated = TerminateJobObject(job, 1);
    console.log(JSON.stringify({ step: 'terminated', terminated, inJob }));
    process.exit(0);
  });
}, 3000);
`;

console.log("[live-job] 用打包产物的 Electron 跑圈禁实证…");

const child = spawn(electronExe, ["-e", inAppScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

/** 等 stdout 里出现某个 step 的 JSON 行。 */
async function waitStep(step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.step === step) return parsed;
      } catch {
        /* 半行，继续等 */
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

const ready = await waitStep("ready", 30_000);
if (ready === null) {
  console.error(`[live-job] ✗ 判据①②失败：打包产物里的 koffi 没能加载/圈禁\nstderr: ${stderr}`);
  child.kill();
  process.exit(1);
}

/**
 * 判据①的路径核对。两个前缀都要成立：JS 壳解析自 app.asar 内，.node 来自 asarUnpack 的平台包。
 * 路径分隔符统一成 / 再比，Electron 报的 asar 虚拟路径与 Node 的 require.cache 键都可能混用 \ 与 /。
 */
const normalizePath = (value) => String(value ?? "").replaceAll("\\", "/");
const asarPrefix = `${normalizePath(join(appAsar, "node_modules", "koffi"))}/`;
const koffiFromAsar = normalizePath(ready.koffiPath).startsWith(asarPrefix);
const nativeFromPlatformPackage =
  ready.nativePath !== null &&
  normalizePath(ready.nativePath).includes("/node_modules/@koromix/koffi-") &&
  normalizePath(ready.nativePath).startsWith(normalizePath(appAsar));
console.log(
  koffiFromAsar
    ? `[live-job] ✓ 判据① koffi 从 app.asar 内加载成功（${ready.koffiPath}）`
    : `[live-job] ✗ 判据① koffi 解析到了 asar 之外：${ready.koffiPath}（应以 ${asarPrefix} 为前缀；asar 里没有 koffi 时 Node 会向上解析到仓库 node_modules 并照样成功——这正是要防的假阳性）`,
);
console.log(
  nativeFromPlatformPackage
    ? `[live-job] ✓ 判据① .node 来自打包产物的平台包（${ready.nativePath}）`
    : `[live-job] ✗ 判据① .node 路径不在预期位置：${ready.nativePath}`,
);
console.log(`[live-job] ✓ 判据② AssignProcessToJobObject = ${ready.assigned}`);

const { topPid, orphanPid } = ready;
if (!(await pidAlive(orphanPid))) {
  console.error("[live-job] ✗ 场景没起来：后台进程不存在");
  child.kill();
  process.exit(1);
}

// 判据④：对照组 —— taskkill /T 对这个已脱离进程树的后台进程无能为力
await sh("taskkill", ["/PID", String(topPid), "/T", "/F"]);
await sleep(1500);
const survivedTaskkill = await pidAlive(orphanPid);
console.log(
  survivedTaskkill
    ? "[live-job] ✓ 判据④ 对照：taskkill /T 之后它仍活着（这正是要根治的）"
    : "[live-job] ✗ 判据④ 对照失效：taskkill /T 就带走了，本场景证明不了圈禁的价值",
);

// 判据③：叫 Job 终止
child.stdin.write("go\n");
const terminated = await waitStep("terminated", 15_000);
if (terminated === null) {
  console.error(`[live-job] 诊断：没等到 terminated 步骤\nstdout=${stdout}\nstderr=${stderr}`);
}
await sleep(1500);
const goneAfterJob = !(await pidAlive(orphanPid));
console.log(
  goneAfterJob
    ? `[live-job] ✓ 判据③ TerminateJobObject 把它带走了（terminated=${terminated?.terminated}，终止前 IsProcessInJob=${terminated?.inJob}）`
    : `[live-job] ✗ 判据③ 失败：Job 终止后它仍存活（terminated=${terminated?.terminated} inJob=${terminated?.inJob}）`,
);

if (!goneAfterJob) {
  await sh("taskkill", ["/PID", String(orphanPid), "/F"]);
}
child.kill();

const allPass =
  ready.koffiLoaded &&
  koffiFromAsar &&
  nativeFromPlatformPackage &&
  ready.assigned &&
  survivedTaskkill &&
  goneAfterJob;
console.log(
  allPass
    ? "\n[live-job] ALL PASS：打包产物里圈禁真实可用，且确实解决了 taskkill /T 解决不了的那类残留"
    : "\n[live-job] FAILED：见上方判据",
);
process.exit(allPass ? 0 : 1);
