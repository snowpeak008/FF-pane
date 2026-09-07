/**
 * 任务落定事件派生（T9.7 B 栏落定高亮的事件源）。
 *
 * 事实源选择：**主进程 saveTask 落盘点**（最小面接入）。任务状态推进全部经
 * saveTask 落盘（编排器正常收尾 / 收尾异常兜底 / 退出钩子 / 启动修正），在
 * session/index.ts 的 saveTask 绑定处包一层「落盘后按状态派生事件」即覆盖全部
 * 落定路径，编排器与修正器本体零改动。渲染层轮询 tasks:list 或从 session:event
 * 的 end 反推都被否掉：前者是为一个角标常驻扫盘，后者拿不到修正 / 退出路径。
 *
 * 纯函数：无 IO，可直接单测。发布侧（窗口取值 + publishEvent）留在装配层。
 */

import type { Task } from "@ff-pane/shared";
import { isTaskSettledStatus, type TaskSettledEvent } from "../../shared-ipc/contracts";

/**
 * 从一次任务落盘派生落定事件；非落定状态（pending / running / accepted / cancelled）
 * 返回 null（不推送——accepted / cancelled 是用户亲手操作，无需再被提醒）。
 */
export function taskSettledEventOf(projectRoot: string, task: Task): TaskSettledEvent | null {
  if (!isTaskSettledStatus(task.status)) {
    return null;
  }
  return { projectRoot, taskId: task.id, status: task.status };
}
