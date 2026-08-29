/**
 * Task 读写（W1.2b）：tasks/task-<id>.json 单文件全量 Task（合同 + status，
 * 设计文档 §6.2 / §6.3 / §10.2）。JSON 内的 id 字段是权威，文件名只是索引；
 * 读入边界校验 status 字面量（§8.4 允许用户直改数据文件，非法值必须可理解地拒读）。
 */

import { join } from "node:path";
import type { Task, TaskId, TaskStatus } from "@ff-pane/shared";
import { isTaskStatus } from "@ff-pane/shared";
import type { ProjectLayout } from "../fs/index.js";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import type { RecordResult } from "./errors.js";
import { StorageInvalidRecordError } from "./errors.js";
import { taskFileName } from "./file-names.js";
import { readDirNames } from "./read-dir.js";

/** 保存任务记录（原子写整个文件）。返回落盘的文件路径。 */
export async function saveTask(layout: ProjectLayout, task: Task): Promise<string> {
  const file = join(layout.tasksDir, taskFileName(task.id));
  await writeJsonAtomic(file, task);
  return file;
}

/** 读取单个任务文件并做边界校验（status 字面量）。 */
async function loadTaskFile(file: string): Promise<RecordResult<Task>> {
  const result = await readJson<Task>(file);
  if (!result.ok) {
    return result;
  }
  if (!isTaskStatus(result.value.status)) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        file,
        "status",
        `任务状态非法: ${JSON.stringify(result.value.status)}`,
      ),
    };
  }
  return result;
}

/** 按 ID 读取任务。额外校验文件内 id 与请求一致（防手工改错文件内容）。 */
export async function loadTask(layout: ProjectLayout, id: TaskId): Promise<RecordResult<Task>> {
  const file = join(layout.tasksDir, taskFileName(id));
  const result = await loadTaskFile(file);
  if (!result.ok) {
    return result;
  }
  if (result.value.id !== id) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        file,
        "id",
        `文件内 id ${JSON.stringify(result.value.id)} 与请求的 ${JSON.stringify(id)} 不一致`,
      ),
    };
  }
  return result;
}

/**
 * 列出全部任务，可选按状态过滤。按文件名排序保证确定性。
 * 单个文件非法即整体拒读（fail fast：损坏必须显式暴露，路径与字段在错误里）；
 * 列举与读取之间文件被删除（not-found）按常态跳过；tasks/ 目录不存在视同无任务。
 */
export async function listTasks(
  layout: ProjectLayout,
  status?: TaskStatus,
): Promise<RecordResult<readonly Task[]>> {
  const namesResult = await readDirNames(layout.tasksDir);
  if (!namesResult.ok) {
    return namesResult;
  }
  const fileNames = namesResult.value
    .filter((name) => name.startsWith("task-") && name.endsWith(".json"))
    .toSorted();
  const tasks: Task[] = [];
  for (const name of fileNames) {
    const result = await loadTaskFile(join(layout.tasksDir, name));
    if (!result.ok) {
      if (result.error.code === "not-found") {
        continue;
      }
      return result;
    }
    if (status === undefined || result.value.status === status) {
      tasks.push(result.value);
    }
  }
  return { ok: true, value: tasks };
}
