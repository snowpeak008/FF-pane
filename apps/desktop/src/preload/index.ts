import { contextBridge, ipcRenderer } from "electron";
import { createIpcClient } from "../shared-ipc/client";

/**
 * preload：主进程与渲染进程之间唯一的桥。
 * 仅暴露契约化的 invoke / subscribe 两个方法（见 shared-ipc/client.ts），
 * 渲染进程无法触达任何 Node / Electron API。
 * 本文件以 CJS 打包为 index.cjs（见 electron.vite.config.ts），从而保持 sandbox: true。
 */
contextBridge.exposeInMainWorld("ffpane", createIpcClient(ipcRenderer));
