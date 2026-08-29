/**
 * Run 权限执行层（W2.7a，设计文档 §7 / §29）。纯逻辑、零 IO。
 *
 * 把 W1.4c 的权限数学变成 Run 级可执行裁决：
 * - assembleRunEnvelope  Run 启动前按权限公式装配最终信封 + 装配审计记录；
 * - judgeFileChange      每次写文件的事前拦截（项目外恒拒、合同禁止项、删除越界）；
 * - judgeCommand         每条命令的事前拦截（verify_only 白名单与危险操作送审）；
 * - auditRunEvidence     Run 结束后对证据的事后越界审计。
 *
 * T2.0 已证明三家 CLI 会把权限拒绝伪装成成功，Runtime 自带的沙箱与审批一律不可信，
 * 本层是 FF-pane 唯一可信的权限事实源。事件到裁决入参的桥接属 W2.7b。
 */

export * from "./assemble.js";
export * from "./audit.js";
export * from "./forbidden.js";
export * from "./judge.js";
export * from "./resolve.js";
export * from "./types.js";
