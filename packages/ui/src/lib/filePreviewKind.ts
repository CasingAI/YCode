import {
  inferImageMediaType,
  inferMediaPreview,
  isPdfPreviewPath,
  isPptxPreviewPath,
} from "@/lib/codeViewer.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";

/** 路径预览分类；`text` 是候选文本，未知扩展名仍需按读取结果判断二进制。 */
export type FilePreviewKind = "text" | "image" | "media" | "pdf" | "pptx" | "office";

/**
 * Side Pane 与文件工作台共用的路径预览分类。
 * 这里只组合已有的格式识别能力，避免新增一份支持格式名单。
 * SVG 虽然能被 inferImageMediaType 识别，但编辑器语义仍是源码文本，因此不归入 image。
 */
export function resolveFilePreviewKind(path?: string): FilePreviewKind {
  if (!path || !path.trim()) {
    return "text";
  }

  const imageMediaType = inferImageMediaType(path);
  if (imageMediaType && imageMediaType !== "image/svg+xml") {
    return "image";
  }

  if (inferMediaPreview(path)) {
    return "media";
  }

  if (isPdfPreviewPath(path)) {
    return "pdf";
  }

  if (isPptxPreviewPath(path)) {
    return "pptx";
  }

  if (getOfficeFilePreviewKind(path)) {
    return "office";
  }

  return "text";
}
