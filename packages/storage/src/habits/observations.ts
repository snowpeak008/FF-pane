/**
 * 跨会话「纠正观察」记录持久化（T5.4 来源三，设计文档 §8.2.4）：整文件 JSON
 * observations.json = `{ version, observations[] }`，经 W1.2a 原子写与安全读。
 * 与 providers 同款：not-found 归一为空集；JSON 损坏由 fs 层隔离，下次读回空集。
 *
 * 观察记录只是"系统建议"的中间账本，可随时清空重建（不是真实数据源）；候选一旦生成
 * 就落到 habits/ 成为习惯候选，与本账本解耦。
 */

import type { HabitObservation } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";

/** observations.json 的当前格式版本。 */
export const OBSERVATIONS_FILE_VERSION = 1;

/** observations.json 的整文件结构。 */
export interface ObservationsFile {
  readonly version: typeof OBSERVATIONS_FILE_VERSION;
  readonly observations: readonly HabitObservation[];
}

/** 纠正观察记录存取接口。 */
export interface ObservationStore {
  /** 列出全部观察记录。文件不存在视为空集。 */
  listObservations(): Promise<readonly HabitObservation[]>;
  /** 整表原子写回。 */
  saveObservations(observations: readonly HabitObservation[]): Promise<void>;
}

/** 读入整文件；not-found / 结构不符归一为空集（账本可重建，宽容读）。 */
async function loadObservations(observationsFile: string): Promise<readonly HabitObservation[]> {
  const result = await readJson<unknown>(observationsFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  const file = raw as { readonly version?: unknown; readonly observations?: unknown };
  if (file.version !== OBSERVATIONS_FILE_VERSION || !Array.isArray(file.observations)) {
    return [];
  }
  return file.observations as readonly HabitObservation[];
}

/** 创建绑定到指定 observations.json 路径的存储（路径由宿主注入，与布局层约定一致）。 */
export function createObservationStore(observationsFile: string): ObservationStore {
  return {
    async listObservations(): Promise<readonly HabitObservation[]> {
      return loadObservations(observationsFile);
    },
    async saveObservations(observations: readonly HabitObservation[]): Promise<void> {
      const file: ObservationsFile = { version: OBSERVATIONS_FILE_VERSION, observations };
      await writeJsonAtomic(observationsFile, file);
    },
  };
}
