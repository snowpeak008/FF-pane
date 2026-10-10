/**
 * 窗口左上角的应用菜单。Windows 上 Electron 默认是英文的 File / Edit / View / Window。
 * 这里按界面语言换成中文或英文，快捷键仍用各角色自带的。
 */

import { Menu, type MenuItemConstructorOptions } from "electron";

export type AppMenuLanguage = "zh-CN" | "en-US";

const LABELS = {
  "zh-CN": {
    file: "文件",
    quit: "退出",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    delete: "删除",
    selectAll: "全选",
    view: "查看",
    reload: "重新加载",
    forceReload: "强制重新加载",
    toggleDevTools: "切换开发者工具",
    resetZoom: "重置缩放",
    zoomIn: "放大",
    zoomOut: "缩小",
    togglefullscreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    close: "关闭",
  },
  "en-US": {
    file: "File",
    quit: "Quit",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    delete: "Delete",
    selectAll: "Select All",
    view: "View",
    reload: "Reload",
    forceReload: "Force Reload",
    toggleDevTools: "Toggle Developer Tools",
    resetZoom: "Reset Zoom",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    togglefullscreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    close: "Close",
  },
} as const;

/** 系统语言或界面语言落到菜单用的两种语言。认不出时用中文。 */
export function resolveAppMenuLanguage(locale: string): AppMenuLanguage {
  const primary = locale.trim().toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
  return primary === "en" ? "en-US" : "zh-CN";
}

export function appMenuTemplate(language: AppMenuLanguage): MenuItemConstructorOptions[] {
  const label = LABELS[language];
  return [
    {
      label: label.file,
      submenu: [{ role: "quit", label: label.quit }],
    },
    {
      label: label.edit,
      submenu: [
        { role: "undo", label: label.undo },
        { role: "redo", label: label.redo },
        { type: "separator" },
        { role: "cut", label: label.cut },
        { role: "copy", label: label.copy },
        { role: "paste", label: label.paste },
        { role: "delete", label: label.delete },
        { type: "separator" },
        { role: "selectAll", label: label.selectAll },
      ],
    },
    {
      label: label.view,
      submenu: [
        { role: "reload", label: label.reload },
        { role: "forceReload", label: label.forceReload },
        { role: "toggleDevTools", label: label.toggleDevTools },
        { type: "separator" },
        { role: "resetZoom", label: label.resetZoom },
        { role: "zoomIn", label: label.zoomIn },
        { role: "zoomOut", label: label.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: label.togglefullscreen },
      ],
    },
    {
      label: label.window,
      submenu: [
        { role: "minimize", label: label.minimize },
        { role: "close", label: label.close },
      ],
    },
  ];
}

export function installAppMenu(language: AppMenuLanguage): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(language)));
}
