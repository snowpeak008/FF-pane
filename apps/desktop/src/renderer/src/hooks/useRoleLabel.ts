/**
 * 角色显示名解析（T8.4）：内置角色走语言包（session.role.*），自定义角色 ID 经
 * roles:list 查显示名（角色名是用户起的数据，不进语言包；查不到时回退显示原始 ID——
 * 被删角色的历史会话记录仍要可读，§1.4 红线 3）。
 *
 * 所有渲染 RoleRef 的地方共用本 hook，`t(\`session.role.${role}\`)` 的写法只对
 * 内置三字面量成立，不得直接用于 RoleRef。
 */

import type { RoleRef } from "@ff-pane/shared";
import { isRole } from "@ff-pane/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { queryData } from "../ipc/query";
import { useInvokeQuery } from "../ipc/useInvokeQuery";

/** 返回 RoleRef → 显示名 的解析函数（引用随语言与角色列表变化而更新）。 */
export function useRoleLabel(): (role: RoleRef) => string {
  const { t } = useTranslation();
  const { state } = useInvokeQuery("roles:list");
  const customRoles = queryData(state);
  return useCallback(
    (role: RoleRef): string => {
      if (isRole(role)) {
        return t(`session.role.${role}`);
      }
      return customRoles?.find((r) => r.id === role)?.name ?? role;
    },
    [t, customRoles],
  );
}
