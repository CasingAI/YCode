import type { CommitTextFileResult } from "@zcode/shared";
import { findFilesBuffer, isFilesLargeTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { filesLargeTextWindowOwner } from "@/files-workbench/filesLargeTextWindowSeed.js";
import { reloadFilesLargeTextWindowAfterSave } from "@/files-workbench/filesLargeTextWindowStore.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesLargeTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 保存成功后重建大文件基准。
 *
 * 提交期间 Store 的 `saveToken` 已阻止块编辑 / 撤销 / 丢弃 / 草稿恢复，
 * 因此这里只校验缓冲身份和提交基准，不能也不需要把旧块坐标平移到新版本。
 */
export function applyLargeTextSavedResult(
  store: FilesEditorStore,
  buffer: FilesLargeTextBuffer,
  result: CommitTextFileResult,
): void {
  const latest = findFilesBuffer(store.getState(), buffer.id);
  if (
    !latest ||
    !isFilesLargeTextBuffer(latest) ||
    latest.path !== buffer.path ||
    latest.edit?.baseVersion !== buffer.edit?.baseVersion
  ) {
    return;
  }

  store.getState().markLargeTextSaved(buffer.id, {
    path: result.path,
    version: result.version,
    totalBytes: result.totalBytes,
  });
}

/**
 * 保存成功后按新版本重载当前窗口。
 *
 * 只触发展示层重载，不读盘、不回滚已提交结果：读取失败由窗口发布绑定新版本的
 * 可重试错误态，保存本身仍视为成功。统一 loader 会重新计算规范块起点并失效
 * 保存前在途的读取。
 */
export function refreshLargeTextWindowAfterSave(
  store: FilesEditorStore,
  bufferId: string,
  result: CommitTextFileResult,
): void {
  const latest = findFilesBuffer(store.getState(), bufferId);
  // 基准更新被并发改动拒绝时不要按旧缓冲路径读取新版本。
  if (!latest || !isFilesLargeTextBuffer(latest) || latest.path !== result.path) return;
  reloadFilesLargeTextWindowAfterSave({
    owner: filesLargeTextWindowOwner(latest),
    totalBytes: result.totalBytes,
    version: result.version,
  });
}
