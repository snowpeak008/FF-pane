/**
 * 配置草案与设置页保存走同一套规则：
 * 名称与至少一路、默认配置不能收窄范围、中转来源必须存在、
 * 名单外仍绑定的项目不许被收窄掉、不能取消唯一的默认配置。
 */

import type { ProjectConfigDraft } from "@ff-pane/shared";
import { isProjectConfigScopeOpen, projectNamesOutsideScope } from "@ff-pane/shared";
import {
  normalizeProjectConfigDraft,
  ProjectConfigDefaultRequiredError,
  ProjectConfigDraftInvalidError,
  ProjectConfigScopeBlockedError,
} from "@ff-pane/storage";

export interface ValidateWorkbenchConfigDraftInput {
  readonly draft: ProjectConfigDraft;
  readonly configId?: string;
  /** 正在更新的是唯一默认配置。此时草案不能把它改成非默认。 */
  readonly currentIsOnlyDefault?: boolean;
  readonly getProvider: (id: string) => Promise<unknown>;
  readonly boundProjects: readonly { readonly id: string; readonly name: string }[];
}

export async function validateWorkbenchConfigDraft(
  input: ValidateWorkbenchConfigDraftInput,
): Promise<ProjectConfigDraft> {
  const normalized = normalizeProjectConfigDraft(input.draft);
  if (normalized.isDefault === true && !isProjectConfigScopeOpen(normalized.projectIds)) {
    throw new ProjectConfigDraftInvalidError("默认配置对所有项目开放，不能限制范围");
  }
  if (input.currentIsOnlyDefault === true && normalized.isDefault !== true) {
    throw new ProjectConfigDefaultRequiredError();
  }
  for (const route of [normalized.claude, normalized.codex]) {
    if (route?.connectionMode !== "relay") {
      continue;
    }
    const providerId = route.providerId;
    if (providerId === undefined || (await input.getProvider(providerId)) === undefined) {
      throw new ProjectConfigDraftInvalidError("中转来源不存在");
    }
  }
  if (input.configId !== undefined) {
    const names = projectNamesOutsideScope(input.boundProjects, normalized.projectIds);
    if (names.length > 0) {
      throw new ProjectConfigScopeBlockedError(names);
    }
  }
  return normalized;
}
