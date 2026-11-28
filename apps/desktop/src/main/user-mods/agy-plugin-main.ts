/**
 * agy 工具插件在主进程的接线：IPC 处理、启动时自动更新（只更新已装的）。
 * 规矩和判断都在 `agy-plugin.ts`；这里只把真实的 agy、文件系统、台账接上去。
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";
import type { AgyPluginActionResult, AgyPluginView } from "../../shared-ipc/contracts";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { agyCommandEnv, resolveAgyTarget } from "../workbench/agy-cli";
import {
  AGY_PLUGIN_NAME,
  AGY_PLUGIN_OWNER_FILE,
  type AgyPluginDeps,
  type AgyPluginFiles,
  type AgyPluginResult,
  type AgyPluginSpec,
  type AgyPluginStatus,
  autoUpdateAgyPlugin,
  getAgyPluginStatus,
  hasOwnerMarker,
  installAgyPlugin,
  uninstallAgyPlugin,
} from "./agy-plugin";
import { readLedger, USER_MODS_FILE_NAME, writeLedger } from "./ledger";

const AGY_TIMEOUT_MS = 60_000;
const READ_NAMES = ["plugin.json", "mcp_config.json", AGY_PLUGIN_OWNER_FILE] as const;

export interface AgyPluginMainOptions {
  readonly spec: AgyPluginSpec;
  readonly appVersion: string;
  /** FF-pane 自己的数据根（放台账和暂存目录）。 */
  readonly globalRoot: string;
  /** 有没有开着的 agy 窗口。 */
  readonly agyWindowsRunning: () => boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/** 兜底删目录前的护栏：必须正好是 `<插件目录>/ffpane-workbench`。 */
export function assertOwnPluginDir(target: string, pluginsDir: string): void {
  const resolved = resolve(target);
  if (
    basename(resolved) !== AGY_PLUGIN_NAME ||
    resolve(dirname(resolved)) !== resolve(pluginsDir)
  ) {
    throw new Error(`refusing to remove ${resolved}`);
  }
}

export function createAgyPluginDeps(options: AgyPluginMainOptions): AgyPluginDeps {
  const env = options.env ?? process.env;
  const pluginsDir = join(options.home ?? homedir(), ".gemini", "config", "plugins");
  const ledgerFile = join(options.globalRoot, USER_MODS_FILE_NAME);
  const stageDir = join(options.globalRoot, "agy-plugin-stage", AGY_PLUGIN_NAME);
  return {
    resolveAgy: () => resolveAgyTarget(env),
    runAgy: (args) =>
      new Promise((done) => {
        const agy = resolveAgyTarget(env);
        if (agy === undefined) {
          done({ code: 127, output: "没找到 agy" });
          return;
        }
        execFile(
          agy,
          [...args],
          {
            env: agyCommandEnv(env),
            timeout: AGY_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            const output = `${String(stdout)}${String(stderr)}`;
            if (error === null) {
              done({ code: 0, output });
              return;
            }
            const code =
              typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : 1;
            done({ code, output: output === "" ? error.message : output });
          },
        );
      }),
    readInstalled: async (dir) => {
      const files: Record<string, string> = {};
      for (const name of READ_NAMES) {
        try {
          files[name] = await readFile(join(dir, name), "utf8");
        } catch {
          // 缺的文件就是缺：状态判断会据此认为不是我们装的或内容不一致
        }
      }
      return Object.keys(files).length === 0 ? undefined : files;
    },
    writeStage: async (files: AgyPluginFiles) => {
      // 每次整个重建，免得暂存目录里留着上次的文件。
      await rm(stageDir, { recursive: true, force: true });
      await mkdir(stageDir, { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        await writeTextAtomic(join(stageDir, name), text);
      }
      return stageDir;
    },
    removeDir: async (dir) => {
      assertOwnPluginDir(dir, pluginsDir);
      // 删之前再确认一次归属标记。
      const markerText = await readFile(join(dir, AGY_PLUGIN_OWNER_FILE), "utf8").catch(
        () => undefined,
      );
      if (
        !hasOwnerMarker(
          markerText === undefined ? undefined : { [AGY_PLUGIN_OWNER_FILE]: markerText },
        )
      ) {
        throw new Error("refusing to remove a plugin without the FF-pane marker");
      }
      await rm(dir, { recursive: true, force: true });
    },
    pluginsDir: () => pluginsDir,
    agyWindowsRunning: options.agyWindowsRunning,
    readLedger: () => readLedger(ledgerFile),
    writeLedger: (ledger) => writeLedger(ledgerFile, ledger),
    now: () => Date.now(),
    appVersion: options.appVersion,
  };
}

function toView(status: AgyPluginStatus): AgyPluginView {
  switch (status.state) {
    case "installed":
      return {
        state: "installed",
        current: status.current,
        enabled: status.enabled,
        path: status.path,
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
      };
    case "foreign":
      return { state: "foreign" };
    default:
      return { state: status.state };
  }
}

function toResult(result: AgyPluginResult): AgyPluginActionResult {
  return result.ok
    ? { ok: true, status: toView(result.status) }
    : { ok: false, error: result.error, status: toView(result.status) };
}

type AgyPluginChannel = "agy-plugin:status" | "agy-plugin:install" | "agy-plugin:uninstall";

export function createAgyPluginHandlers(
  options: AgyPluginMainOptions,
): Pick<InvokeHandlers, AgyPluginChannel> {
  const deps = createAgyPluginDeps(options);
  return {
    "agy-plugin:status": async () => toView(await getAgyPluginStatus(deps, options.spec)),
    "agy-plugin:install": async () => toResult(await installAgyPlugin(deps, options.spec)),
    "agy-plugin:uninstall": async () => toResult(await uninstallAgyPlugin(deps, options.spec)),
  };
}

/** 状态查询给别处用（比如管理者开 agy 窗口时要不要提示没装插件）。 */
export function createAgyPluginStatusReader(
  options: AgyPluginMainOptions,
): () => Promise<AgyPluginView> {
  const deps = createAgyPluginDeps(options);
  return async () => toView(await getAgyPluginStatus(deps, options.spec));
}

/**
 * 启动时调用，不阻塞启动、不抛。只更新「已装且过期」的；没装的什么都不做。
 * 返回一句话给日志。
 */
export async function runAgyPluginAutoUpdate(options: AgyPluginMainOptions): Promise<string> {
  try {
    const result = await autoUpdateAgyPlugin(createAgyPluginDeps(options), options.spec);
    switch (result.action) {
      case "updated":
        return "agy ffpane 插件已自动更新";
      case "deferred":
        return `agy ffpane 插件更新推迟：${result.reason}`;
      case "failed":
        return `agy ffpane 插件更新失败：${result.error}`;
      default:
        return `agy ffpane 插件无需处理：${result.reason}`;
    }
  } catch (error) {
    return `agy ffpane 插件检查出错：${error instanceof Error ? error.message : String(error)}`;
  }
}
