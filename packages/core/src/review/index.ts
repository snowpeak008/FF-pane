/**
 * Reviewer 角色（T7.2，设计文档 §3.1）barrel：审查材料组装 + 结论合同与解析。
 *
 * 权限那一半不在这里：Reviewer 的默认信封（只读 + verify_only）早在 W1.4c 就已随
 * §7 角色默认表落在 `../permission/envelope.ts`，本模块只管"给它看什么、怎么读回结论"。
 */

export * from "./material.js";
export * from "./review-output.js";
