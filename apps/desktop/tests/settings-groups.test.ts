import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_GROUP,
  isSettingsGroup,
  resolveSettingsGroup,
  SETTINGS_GROUPS,
} from "../src/renderer/src/stores/settings-groups";
import { migrateUiState, useUiStore } from "../src/renderer/src/stores/ui";

describe("T11.9 设置页分组", () => {
  it("分组顺序固定，第一组是默认组", () => {
    expect(SETTINGS_GROUPS).toEqual(["general", "workbench", "models", "tools"]);
    expect(DEFAULT_SETTINGS_GROUP).toBe("general");
  });

  it("只认清单里的组名", () => {
    expect(isSettingsGroup("models")).toBe(true);
    expect(isSettingsGroup("skills-later")).toBe(false);
    expect(isSettingsGroup(undefined)).toBe(false);
    expect(isSettingsGroup(3)).toBe(false);
  });

  it("地址里的组优先，其次上次那一组，最后第一组", () => {
    expect(resolveSettingsGroup("tools", "models")).toBe("tools");
    expect(resolveSettingsGroup(null, "models")).toBe("models");
    expect(resolveSettingsGroup("nope", "workbench")).toBe("workbench");
    expect(resolveSettingsGroup("nope", "also-nope")).toBe("general");
    expect(resolveSettingsGroup(null, undefined)).toBe("general");
  });

  it("旧的 ui-state 没有分组字段时用第一组，坏值也回到第一组", () => {
    expect(migrateUiState({ activePage: "settings" }, null).settingsGroup).toBe("general");
    expect(migrateUiState({ settingsGroup: "models" }, null).settingsGroup).toBe("models");
    expect(migrateUiState({ settingsGroup: "bogus" }, null).settingsGroup).toBe("general");
  });

  it("记住上次打开的组", () => {
    useUiStore.getState().setSettingsGroup("tools");
    expect(useUiStore.getState().settingsGroup).toBe("tools");
    useUiStore.getState().setSettingsGroup("general");
  });
});
