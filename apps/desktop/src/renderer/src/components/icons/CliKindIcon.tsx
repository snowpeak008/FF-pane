/**
 * 工作台窗口种类图标（§9 界面精简）：标题栏只放图标、不写「Claude」「Codex」。
 * 五家各画一个能一眼分开的简化单色标志，不引外部图标包。名字由调用方放进悬浮提示。
 */

import type { WorkbenchWindowKind } from "@ff-pane/shared";
import { SquareTerminal } from "lucide-react";
import type { ReactElement } from "react";

export function CliKindIcon({
  kind,
  size = 14,
}: {
  readonly kind: WorkbenchWindowKind | undefined;
  readonly size?: number;
}): ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    focusable: false,
  } as const;
  switch (kind) {
    case "claude":
      // 橙色放射星
      return (
        <svg {...common} aria-hidden="true" className="shrink-0 text-[#d97757]">
          <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M8 1.5v13" />
            <path d="M1.5 8h13" />
            <path d="M3.4 3.4l9.2 9.2" />
            <path d="M12.6 3.4l-9.2 9.2" />
          </g>
        </svg>
      );
    case "codex":
      // 六边形套一个命令提示符
      return (
        <svg {...common} aria-hidden="true" className="shrink-0 text-fg">
          <path
            d="M8 1.2l5.9 3.4v6.8L8 14.8l-5.9-3.4V4.6z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M5.6 6.4L7.4 8l-1.8 1.6M8.6 10h2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "grok":
      // 斜杠穿过圆
      return (
        <svg {...common} aria-hidden="true" className="shrink-0 text-fg">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M13.8 2.2L2.2 13.8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "deepseek":
      // 蓝色鲸鱼尾
      return (
        <svg {...common} aria-hidden="true" className="shrink-0 text-[#4d6bfe]">
          <path
            d="M1.8 9.2c1.4 2.9 4.6 4.3 7.6 3.4 2.3-.7 3.8-2.6 4.1-4.8l1.3-1.6-1.9.2C11.8 4.3 9 3.4 6.6 4.4 4.9 5.1 3.9 6.6 3.8 8.3 3.3 8.9 2.6 9.2 1.8 9.2z"
            fill="currentColor"
          />
        </svg>
      );
    case "cursor":
      // 立方体
      return (
        <svg {...common} aria-hidden="true" className="shrink-0 text-fg">
          <path
            d="M8 1.5l5.6 3.2v6.6L8 14.5l-5.6-3.2V4.7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M2.4 4.7L8 8l5.6-3.3M8 8v6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
      );
    default:
      return <SquareTerminal aria-hidden size={size} className="shrink-0 text-fg-muted" />;
  }
}
