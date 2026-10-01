/**
 * 单测把 workspace 包指到 src，避免 package.json exports 落到 dist 造成假通过。
 * 桌面应用运行时仍走 dist（electron-vite externalizeDeps）。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function srcEntry(relativePath: string): string {
  return resolve(repoRoot, relativePath);
}

export const workspaceSrcAlias: Array<{ find: RegExp; replacement: string }> = [
  {
    find: /^@ff-pane\/rag\/retrieve$/,
    replacement: srcEntry("packages/rag/src/retrieve/index.ts"),
  },
  { find: /^@ff-pane\/core$/, replacement: srcEntry("packages/core/src/index.ts") },
  { find: /^@ff-pane\/shared$/, replacement: srcEntry("packages/shared/src/index.ts") },
  { find: /^@ff-pane\/storage$/, replacement: srcEntry("packages/storage/src/index.ts") },
  { find: /^@ff-pane\/adapters$/, replacement: srcEntry("packages/adapters/src/index.ts") },
  { find: /^@ff-pane\/rag$/, replacement: srcEntry("packages/rag/src/index.ts") },
];
