/**
 * T10.4' 实机：真实 claude / codex 经 resolveDirectCliTarget 直启（如 --version）。
 * 不消耗额度；不碰 ~/.aiworkbench；绕开 cmd.exe。
 *
 * 用法：node apps/desktop/scripts/live-workbench-cli.mjs
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(desktopDir, "package.json"));

async function runVersion(command) {
  const adapters = require("@ff-pane/adapters");
  const target = adapters.resolveDirectCliTarget(command, ["--version"], process.env);
  if (target === undefined) {
    return { ok: false, reason: `unresolvable (no cmd fallback): ${command}` };
  }
  return await new Promise((settle) => {
    const child = spawn(target.file, [...target.args], {
      env: process.env,
      shell: false,
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", (error) => {
      settle({
        ok: false,
        reason: String(error),
        resolved: target.resolvedCommand,
        kind: target.kind,
      });
    });
    child.on("close", (code) => {
      settle({
        ok: code === 0 && out.trim().length > 0,
        code,
        out: out.trim().slice(0, 200),
        resolved: target.resolvedCommand,
        file: target.file,
        kind: target.kind,
      });
    });
  });
}

const results = {
  claude: await runVersion("claude"),
  codex: await runVersion("codex"),
};
console.log(JSON.stringify(results, null, 2));
const allOk = results.claude.ok && results.codex.ok;
console.log(allOk ? "ALL PASS" : "FAIL");
process.exit(allOk ? 0 : 1);
