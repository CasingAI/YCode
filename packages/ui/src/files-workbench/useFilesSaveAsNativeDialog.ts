import { useCallback, useEffect, useRef, useState } from "react";
import { filesSaveAsDefaultPath } from "@/files-workbench/filesSaveAsPath.js";
import {
  canUseFilesSaveAsNativeDialog,
  FilesSaveAsNativeDialogController,
  type FilesSaveAsNativeDialogPlatform,
} from "@/files-workbench/filesSaveAsNativeDialog.js";

/**
 * 另存为弹窗的原生选路控制。
 *
 * 弹窗拥有目录、文件名、请求中状态和失败提示；本 hook 只把一次点击变成
 * `IPlatformService.showSaveDialog` 调用，并在结果仍属于当前打开目标时交给现有 `onConfirm`。
 * 关闭、卸载或更换缓冲 / 工作区 / 文件服务后，旧请求及其错误全部作废。
 */
export function useFilesSaveAsNativeDialog(params: {
  open: boolean;
  bufferId?: string;
  workspaceKey?: string;
  fileService?: unknown;
  allowNativePath: boolean;
  platform: FilesSaveAsNativeDialogPlatform | null | undefined;
  directory: string;
  fileName: string;
  title: string;
  onConfirm: (path: string) => void;
}): {
  available: boolean;
  pending: boolean;
  failed: boolean;
  openDialog: () => void;
} {
  const {
    open,
    bufferId,
    workspaceKey,
    fileService,
    allowNativePath,
    platform,
    directory,
    fileName,
    title,
    onConfirm,
  } = params;
  const controllerRef = useRef(new FilesSaveAsNativeDialogController());
  const activeRef = useRef(true);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  const available = canUseFilesSaveAsNativeDialog({ allowNativePath, platform });

  // 目标身份变化（关闭/重开、换缓冲或文件服务）或原生入口不再可用时，
  // 使未完成请求失效。读取目录是并发操作，不能因为读盘结果晚到就作废
  // 用户已经确认的系统路径，因此这里只认 available / buffer / fileService / open；
  // 迟到结果由 generation 直接丢弃。
  useEffect(() => {
    controllerRef.current.invalidate();
    setPending(false);
    setFailed(false);
  }, [available, bufferId, workspaceKey, fileService, open]);

  // 用户改目录或文件名后，旧的失败提示不再对应当前目标。
  useEffect(() => {
    setFailed(false);
  }, [directory, fileName]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      controllerRef.current.invalidate();
    };
  }, []);

  const openDialog = useCallback(() => {
    // 弹窗已关闭时不得再发起请求；关闭后的迟到结果由 invalidation 丢弃。
    if (!open || !available || controllerRef.current.pending) {
      return;
    }
    const showSaveDialog = platform?.showSaveDialog?.bind(platform);
    if (!showSaveDialog) {
      return;
    }
    setFailed(false);
    setPending(true);
    void controllerRef.current
      .run((options) => showSaveDialog(options), {
        defaultPath: filesSaveAsDefaultPath(directory, fileName),
        title,
      })
      .then((outcome) => {
        if (outcome.kind === "ignored" || !activeRef.current) {
          return;
        }
        setPending(false);
        if (outcome.kind === "path") {
          // 只复用现有确认动作：实际写入、冲突检查和缓冲更新仍由工作台完成。
          onConfirmRef.current(outcome.path);
        } else if (outcome.kind === "error") {
          setFailed(true);
        }
      });
  }, [available, directory, fileName, open, platform, title]);

  return { available, pending, failed, openDialog };
}
