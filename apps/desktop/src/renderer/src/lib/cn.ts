import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 类名合并工具：clsx 负责条件拼接，tailwind-merge 负责同族冲突去重
 * （后写的赢，如 `cn("p-2", "p-4")` → `p-4`），使组件的 className 覆写可预期。
 * Phase 3 所有组件的 className 入参一律经此函数合并，禁止字符串直接拼接。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
