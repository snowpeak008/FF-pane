/**
 * storage 记录层（W1.2b）：Plan / Task / Run 三对象的读写 API，构建在 W1.2a
 * 文件层（原子写、安全读、错误族）之上。
 *
 * 核心取舍：Plan 采用 meta.json 权威 + md 渲染视图的双文件方案（理由与写入
 * 顺序见 ./plan.ts 模块注释）；Task / Run 为纯 JSON 记录，文件（目录）名由
 * ID 百分号编码安全化派生（见 ./file-names.ts），JSON 内字段是权威、文件名只是索引。
 * 读取一律返回 RecordResult 判别联合，状态字面量在读入边界用 shared 守卫校验。
 */

export * from "./errors.js";
export * from "./file-names.js";
export * from "./plan.js";
export * from "./run.js";
export * from "./task.js";
