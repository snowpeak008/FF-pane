/**
 * 项目摘要（T7.4）。
 *
 * 卡片只回答数据目录在不在。计划、任务、Run、会话登记不在这里读取，旧文件留在磁盘上。
 *
 * 读取一律经注入的 `ProjectSummarySources`，汇总规则可以脱离 Electron 单测。
 * 本文件不产出面向用户的文案：出错时给的是源码枚举（`ProjectSummaryPart`）。
 */

import type { ProjectRegistryEntry } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import type {
  ProjectSummary,
  ProjectSummaryPart,
  ProjectSummaryView,
} from "../shared-ipc/contracts";

/** 汇总所需的读取，全部由宿主注入。 */
export interface ProjectSummarySources {
  /** `.workbench/` 是否存在（探测失败一律按不存在处理，见 summarizeProject 注释）。 */
  readonly workbenchPresent: (layout: ProjectLayout) => Promise<boolean>;
  /** 项目根路径 → 布局（纯路径解析）。 */
  readonly resolveLayout: (projectRootDir: string) => ProjectLayout;
}

/** 数据目录不存在（或整份汇总崩了）时的零值摘要。 */
function emptySummary(unavailable: readonly ProjectSummaryPart[]): ProjectSummary {
  return { workbenchPresent: false, activeTaskCount: 0, taskCount: 0, unavailable };
}

/** 单路读取的结果：拿到值，或这一路不可用。 */
type PartResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * 跑一路读取并把失败吞掉。
 *
 * 吞异常而不是上抛：一个项目的 sessions.json 坏了，用户仍应看得见它的计划版本与任务数，
 * 也仍应看得见**别的项目**（§单文件失败不中断批量）。失败以 `unavailable` 如实上报，
 * 不伪装成"这一路是空的"。
 */
async function readPart<T>(read: () => Promise<T>): Promise<PartResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/**
 * 汇总单个项目。**不抛错**。只看数据目录在不在。
 *
 * `.workbench/` 不存在时直接给零值摘要。界面据 `workbenchPresent` 如实标注。
 */
export async function summarizeProject(
  layout: ProjectLayout,
  sources: ProjectSummarySources,
): Promise<ProjectSummary> {
  const present = await readPart(() => sources.workbenchPresent(layout));
  if (!present.ok || !present.value) {
    return emptySummary([]);
  }

  // T10.11：不再读取计划、任务、Run、会话登记。旧文件留在磁盘上。
  return {
    workbenchPresent: true,
    activeTaskCount: 0,
    taskCount: 0,
    unavailable: [],
  };
}

/**
 * 汇总整份注册表。
 *
 * 逐项目独立 try：一个项目的路径解析或汇总整体崩掉（坏盘、路径非法），其余项目照常出结果
 * ——项目列表是用户找回工作现场的入口，它不该因为其中一个项目出事就整页红。崩掉的那个
 * 项目四路全标 `unavailable`，卡片如实显示读不到，而不是显示成空项目。
 */
export async function summarizeProjects(
  entries: readonly ProjectRegistryEntry[],
  sources: ProjectSummarySources,
): Promise<readonly ProjectSummaryView[]> {
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const layout = sources.resolveLayout(entry.rootPath);
        return { entry, summary: await summarizeProject(layout, sources) };
      } catch {
        return { entry, summary: emptySummary(["plan", "task", "run", "session"]) };
      }
    }),
  );
}
