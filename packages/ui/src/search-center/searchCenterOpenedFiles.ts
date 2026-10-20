import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { getPathLeaf } from "@/lib/path.js";

export interface SearchCenterOpenedFile {
  path: string;
  name: string;
  relativePath: string;
}

/**
 * 空查询时展示的「已打开文件」列表。
 *
 * 只取当前工作区的缓冲（身份 key = workspaceIdentity?.trim() || workspacePath），
 * 活动文件排在最前，其余保持工作台标签的打开顺序。
 * 这里不维护第二份打开文件状态：数据直接来自 filesEditorStore。
 */
export function buildSearchCenterOpenedFiles(params: {
  buffers: readonly FilesBuffer[];
  openIds: readonly string[];
  activeId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): SearchCenterOpenedFile[] {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  const buffersById = new Map(params.buffers.map((buffer) => [buffer.id, buffer]));
  const files: SearchCenterOpenedFile[] = [];
  for (const id of params.openIds) {
    const buffer = buffersById.get(id);
    if (!buffer || !buffer.path) {
      continue;
    }
    if (filesWorkspaceKey(buffer.workspace) !== workspaceKey) {
      continue;
    }
    files.push({
      path: buffer.path,
      name: getPathLeaf(buffer.path),
      relativePath: toWorkspaceRelativePath(params.workspacePath, buffer.path),
    });
  }

  const activeBuffer = params.activeId ? buffersById.get(params.activeId) : undefined;
  const activePath = activeBuffer?.path;
  if (!activePath) {
    return files;
  }
  const activeIndex = files.findIndex((file) => file.path === activePath);
  if (activeIndex <= 0) {
    return files;
  }
  const [active] = files.splice(activeIndex, 1);
  return active ? [active, ...files] : files;
}
