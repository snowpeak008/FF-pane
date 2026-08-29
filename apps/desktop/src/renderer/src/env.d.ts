/// <reference types="vite/client" />
import type { FfPaneIpcApi } from "../../shared-ipc/client";

declare global {
  interface Window {
    /** preload（contextBridge）暴露的唯一受控 IPC API，见 src/preload/index.ts。 */
    readonly ffpane: FfPaneIpcApi;
  }
}
