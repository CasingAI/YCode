import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isMissingFileError } from "@/lib/fileReadError.js";
import {
  ImagePreviewLoadController,
  type ImagePreviewLoadState,
  type ImagePreviewLoadSource,
} from "@/lib/imagePreviewLoadController.js";
import { readImagePreviewBlob, type ImagePreviewFileService } from "@/lib/imagePreviewData.js";
import { logger } from "@/logger.js";

/**
 * helper 用结构化 code 表达 64 MiB 超限，不依赖错误文案；旧 readMediaPreview 的
 * 4 MiB 超限没有该 code，会保持通用图片不可用提示，避免误报成 64 MiB。
 */
function isImagePreviewTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "too-large"
  );
}

export interface UseImagePreviewParams {
  /** 必须来自 useWorkspaceServices，保持本地 / Desktop / 远程工作区路由一致。 */
  fileService: ImagePreviewFileService;
  path?: string | null;
  mediaType?: string | null;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  workspaceRemoteSessionId?: string | null;
}

export function useImagePreview({
  fileService,
  path,
  mediaType,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: UseImagePreviewParams): ImagePreviewLoadState {
  const [controller] = useState(
    () =>
      new ImagePreviewLoadController({
        readImagePreviewBlob,
        isMissingFileError,
        isTooLargeError: isImagePreviewTooLargeError,
        onError: ({ error, path: sourcePath }) => {
          // 诊断日志保留路径与错误；UI 文案按 errorKind 本地化，不直接展示绝对路径。
          logger.error(`[PreviewPane] 读取图片预览失败 path=${sourcePath}:`, error);
        },
      }),
  );
  const source = useMemo<ImagePreviewLoadSource | null>(
    () =>
      path && mediaType
        ? {
            fileService,
            path,
            mediaType,
            workspacePath: workspacePath ?? undefined,
            workspaceIdentity: workspaceIdentity ?? undefined,
            workspaceRemoteSessionId: workspaceRemoteSessionId ?? undefined,
          }
        : null,
    [fileService, mediaType, path, workspaceIdentity, workspacePath, workspaceRemoteSessionId],
  );

  useEffect(() => {
    controller.setSource(source);
    return () => {
      controller.setSource(null);
    };
  }, [controller, source]);

  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
