import { FILE_TEXT_WINDOW_CHANGED_CODE } from "@zcode/shared";
import type { FilesExternalChange } from "@/files-workbench/filesEditorTypes.js";
import type {
  FilesLargeTextWindowError,
  FilesLargeTextWindowSnapshot,
} from "@/files-workbench/filesLargeTextWindowTypes.js";

export function filesLargeTextErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function filesLargeTextErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return undefined;
}

export function isFilesLargeTextChangedError(error: unknown): boolean {
  return filesLargeTextErrorCode(error) === FILE_TEXT_WINDOW_CHANGED_CODE;
}

function isOfflineError(error: unknown): boolean {
  const message = filesLargeTextErrorMessage(error)?.toLowerCase() ?? "";
  return (
    message.includes("remote-workspace-disconnected") ||
    message.includes("disconnected") ||
    message.includes("offline") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("network")
  );
}

/** 无 expectedVersion 的有界探针遇到 ENOENT 才是文件消失；带版本读取会转成 changed。 */
export function isFilesLargeTextDeletedError(error: unknown): boolean {
  const code = filesLargeTextErrorCode(error);
  if (code === "ENOENT" || code === "FILE_NOT_FOUND") return true;
  const message = filesLargeTextErrorMessage(error)?.toLowerCase() ?? "";
  return (
    message.includes("enoent") ||
    message.includes("no such file") ||
    message.includes("file not found")
  );
}

/**
 * 窗口快照 → Store 的外部变化提示。
 *
 * 只描述磁盘状态，不携带或替换正文；脏草稿的基准由 edit / expectedVersion 保持。
 */
export function resolveFilesLargeTextExternalChange(
  snapshot: FilesLargeTextWindowSnapshot,
): FilesExternalChange | undefined {
  const error = snapshot.error;
  if (error?.kind === "deleted") {
    return { kind: "deleted", observedVersion: null };
  }
  if (error?.kind !== "changed" && error?.kind !== "binary") return undefined;
  return snapshot.observedVersion === undefined
    ? { kind: "changed" }
    : { kind: "changed", observedVersion: snapshot.observedVersion };
}

export function toFilesLargeTextReadError(error: unknown): FilesLargeTextWindowError {
  if (isFilesLargeTextChangedError(error)) {
    return {
      kind: "changed",
      code: FILE_TEXT_WINDOW_CHANGED_CODE,
      message: filesLargeTextErrorMessage(error),
    };
  }
  return {
    kind: isOfflineError(error) ? "offline" : "failed",
    code: filesLargeTextErrorCode(error),
    message: filesLargeTextErrorMessage(error),
  };
}
