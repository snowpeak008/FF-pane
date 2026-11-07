// 测试里直接用 node 跑 .ts 源文件时（--experimental-strip-types），相对导入不带扩展名会找不到；
// 找不到时补上 .ts 再找一次。只给 workbench-hook-digest.test.ts 起 hook 进程用。
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (/^\\.\\.?\\//.test(specifier) && !specifier.endsWith(".ts")) {
      return next(specifier + ".ts", context);
    }
    throw error;
  }
}
`)}`,
);
