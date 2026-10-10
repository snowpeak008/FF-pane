/** 画板上和带标记预览里的身份条，让人和窗口对上项目内的哪一张图。 */

export interface ProjectImageTag {
  readonly fileName: string;
  readonly path: string;
  /** 例如：项目内图片 shot.png .ffpane/canvas/shot.png */
  readonly label: string;
}

export function projectImageTag(imageRelative: string): ProjectImageTag {
  const path = imageRelative.trim().replace(/\\/g, "/");
  const fileName = path.split("/").pop() ?? path;
  return {
    fileName,
    path,
    label: `项目内图片 ${fileName} ${path}`,
  };
}
