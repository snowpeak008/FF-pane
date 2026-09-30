/** 工作台布局文件损坏（合法 JSON 但结构不符）。 */
export class WorkbenchLayoutsFileInvalidError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`workbench-layouts.json 结构不符合约定（${reason}）: ${path}`);
    this.name = "WorkbenchLayoutsFileInvalidError";
    this.path = path;
    this.reason = reason;
  }
}
