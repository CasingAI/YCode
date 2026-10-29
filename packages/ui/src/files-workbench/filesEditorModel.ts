import { getPathLeaf } from "@/lib/path.js";
import { filesMonacoPathsEqual } from "@/files-workbench/filesMonacoTypescriptPath.js";
import {
  filesFileBufferId,
  filesWorkspaceKey,
  isFilesLargeTextBuffer,
  isFilesPreviewTab,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorBufferModel.js";
import { hasFilesLargeTextEditChanges } from "@/files-workbench/filesLargeTextDraftModel.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesOpenMode,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
  FilesTextBuffer,
  FilesTextBufferLoadState,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export * from "@/files-workbench/filesEditorBufferModel.js";
export * from "@/files-workbench/filesLargeTextDraftModel.js";
export * from "@/files-workbench/filesLargeTextDraftExternal.js";

function withOpenMode(buffer: FilesBuffer, mode: FilesOpenMode): FilesBuffer {
  if (mode === "preview") {
    return { ...buffer, preview: true };
  }
  if (!buffer.preview) {
    return buffer;
  }
  return { ...buffer, preview: undefined };
}

/** VS Code 默认 openPositioning:right：新标签插在当前焦点右侧。 */
export function insertFilesOpenIdAfterActive(
  openIds: readonly string[],
  activeId: string | undefined,
  id: string,
): string[] {
  const activeIndex = activeId ? openIds.indexOf(activeId) : -1;
  if (activeIndex < 0) {
    return [...openIds, id];
  }
  const next = [...openIds];
  next.splice(activeIndex + 1, 0, id);
  return next;
}

export function isFilesBufferDirty(buffer: FilesBuffer): boolean {
  if (isFilesLargeTextBuffer(buffer)) {
    return hasFilesLargeTextEditChanges(buffer.edit);
  }
  if (!isFilesTextBuffer(buffer)) {
    return false;
  }
  if (buffer.untitled && buffer.text === "" && buffer.savedText === "") {
    return false;
  }
  return buffer.text !== buffer.savedText;
}

/**
 * 保存 / 另存为的统一置灰规则（应用菜单 canSave 与标签右键共用）：
 * 已加载完成的完整可写文本缓冲，或存在有效固定块修改的大文本缓冲才可保存。
 * 图片等只读预览、尚未读盘的恢复文本不算。
 *
 * 大文件只要已建立编辑基准即可保存（含干净文件的另存为）；
 * `changes` 为空时保存流程应 no-op 或流式复制，而不是禁用入口。
 * `readonlyReason === "encoding"` 只是整体提示，不会整体禁用保存。
 *
 * 旧版截断文本只有局部正文；把它写回会静默丢数据，因此同样不可保存。
 */
export function canSaveFilesBuffer(buffer: FilesBuffer): boolean {
  if (isFilesLargeTextBuffer(buffer)) {
    return buffer.edit !== undefined;
  }
  return isFilesTextBuffer(buffer) && buffer.loadState === undefined && buffer.truncated !== true;
}

export function detectFilesSaveConflict(params: {
  currentText: string;
  savedText: string;
  diskText?: string;
}): "ok" | "conflict" {
  if (params.diskText === undefined) {
    return "ok";
  }
  if (params.diskText === params.savedText || params.diskText === params.currentText) {
    return "ok";
  }
  return "conflict";
}

export function findFilesBuffer(state: FilesEditorState, id: string): FilesBuffer | undefined {
  return state.buffers.find((buffer) => buffer.id === id);
}

export function findFilesFileBuffer(
  state: FilesEditorState,
  workspace: FilesWorkspaceRef,
  path: string,
): FilesBuffer | undefined {
  const id = filesFileBufferId(workspace, path);
  const exact = findFilesBuffer(state, id);
  if (exact) return exact;

  // Equivalent paths must reuse a buffer because Monaco canonicalizes their URIs.
  return state.buffers.find(
    (buffer) =>
      buffer.path !== undefined &&
      filesWorkspaceKey(buffer.workspace) === filesWorkspaceKey(workspace) &&
      filesMonacoPathsEqual(buffer.path, path),
  );
}

export function filesBufferTabTitle(buffer: FilesBuffer): string {
  if (isFilesTextBuffer(buffer) && buffer.untitled) {
    return buffer.title;
  }
  return getPathLeaf(buffer.path ?? buffer.title);
}

export function filesBufferTabTooltip(buffer: FilesBuffer): string {
  if (isFilesTextBuffer(buffer) && buffer.untitled) {
    return buffer.title;
  }
  const workspaceName = getPathLeaf(buffer.workspace.workspacePath);
  const path = buffer.path ?? buffer.title;
  return `${path} — ${workspaceName}`;
}

export function needsFilesWorkspaceDisambiguation(
  buffers: readonly FilesBuffer[],
  buffer: FilesBuffer,
): boolean {
  // 单个查询走同一份 O(N) 结果，避免调用方逐 tab 调用时退化成 O(N²)。
  return resolveFilesWorkspaceDisambiguatedIds(buffers).has(buffer.id);
}

/**
 * 一次性算出需要「工作区后缀消歧」的 tab 集合。
 *
 * 语义与逐对比较一致：同一 title 下出现 ≥2 个不同 workspace key 时，
 * 该 title 组内每个成员都存在「同名且不同工作区」的另一 tab，全部需要消歧。
 * 复杂度 O(N)：过去逐 tab 调 needsFilesWorkspaceDisambiguation 是 O(N²) 次
 * getPathLeaf 正则；恢复 400+ 个打开文件时这段计算在启动渲染里占 20 秒以上
 * （2026-10-15 cpuprofile：41% 采样在 getPathLeaf，冻结 26s）。
 */
export function resolveFilesWorkspaceDisambiguatedIds(
  buffers: readonly FilesBuffer[],
): ReadonlySet<string> {
  // title -> 出现过的 workspace key 集合
  const workspaceKeysByTitle = new Map<string, Set<string>>();
  // title -> 该 title 下所有 buffer id
  const idsByTitle = new Map<string, string[]>();
  for (const buffer of buffers) {
    const title = filesBufferTabTitle(buffer);
    const keys = workspaceKeysByTitle.get(title);
    if (keys) {
      keys.add(filesWorkspaceKey(buffer.workspace));
    } else {
      workspaceKeysByTitle.set(title, new Set([filesWorkspaceKey(buffer.workspace)]));
      idsByTitle.set(title, []);
    }
    idsByTitle.get(title)?.push(buffer.id);
  }
  const disambiguated = new Set<string>();
  for (const [title, keys] of workspaceKeysByTitle) {
    if (keys.size > 1) {
      for (const id of idsByTitle.get(title) ?? []) disambiguated.add(id);
    }
  }
  return disambiguated;
}

export function resolveExplorerWorkspaceKey(params: {
  preferredKey?: string;
  workspaceKeys: readonly string[];
}): string | undefined {
  if (params.workspaceKeys.length === 0) {
    return undefined;
  }
  if (params.preferredKey && params.workspaceKeys.includes(params.preferredKey)) {
    return params.preferredKey;
  }
  return params.workspaceKeys[0];
}

export function openBufferInState(
  state: FilesEditorState,
  buffer: FilesBuffer,
  mode: FilesOpenMode = "keep",
): FilesEditorState {
  const existing = state.buffers.find((candidate) => candidate.id === buffer.id);
  if (existing) {
    const buffers =
      mode === "keep" && existing.preview
        ? state.buffers.map((candidate) =>
            candidate.id === buffer.id ? withOpenMode(candidate, "keep") : candidate,
          )
        : state.buffers;
    const openIds = state.openIds.includes(buffer.id)
      ? state.openIds
      : [...state.openIds, buffer.id];
    return {
      ...state,
      buffers,
      openIds,
      activeId: buffer.id,
    };
  }

  const incoming = withOpenMode(buffer, mode);
  const previewId =
    mode === "preview"
      ? state.openIds.find((id) => {
          const openBuffer = findFilesBuffer(state, id);
          return openBuffer ? isFilesPreviewTab(openBuffer) : false;
        })
      : undefined;
  if (!previewId) {
    return {
      ...state,
      buffers: [...state.buffers, incoming],
      openIds: insertFilesOpenIdAfterActive(state.openIds, state.activeId, incoming.id),
      activeId: incoming.id,
    };
  }

  const previewIndex = state.openIds.indexOf(previewId);
  const openIds = [...state.openIds];
  openIds.splice(previewIndex, 1, incoming.id);
  return {
    ...state,
    buffers: [...state.buffers.filter((candidate) => candidate.id !== previewId), incoming],
    openIds,
    activeId: incoming.id,
  };
}

export function closeBufferInState(state: FilesEditorState, id: string): FilesEditorState {
  const target = state.buffers.find((buffer) => buffer.id === id);
  // 大文件提交 token 是 buffer 的生命周期租约：保存期间任何关闭路径都不得移除它。
  if (target?.kind === "large-text" && target.saveToken) return state;
  const openIds = state.openIds.filter((openId) => openId !== id);
  const buffers = state.buffers.filter((buffer) => buffer.id !== id);
  const activeIndex = state.openIds.indexOf(id);
  let activeId = state.activeId;
  if (state.activeId === id) {
    activeId = openIds[Math.max(0, activeIndex - 1)];
  }
  return {
    ...state,
    buffers,
    openIds,
    activeId,
  };
}

export function updateTextBuffer(
  state: FilesEditorState,
  id: string,
  patch: Partial<
    Pick<
      FilesTextBuffer,
      | "text"
      | "savedText"
      | "path"
      | "untitled"
      | "title"
      | "truncated"
      | "loadState"
      | "diskVersion"
      | "externalChange"
    >
  >,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (buffer.id !== id || !isFilesTextBuffer(buffer)) {
      return buffer;
    }
    const next: FilesTextBuffer = { ...buffer, ...patch };
    if (patch.text !== undefined && patch.text !== buffer.text) {
      next.preview = undefined;
    }
    if (
      next.text === buffer.text &&
      next.savedText === buffer.savedText &&
      next.path === buffer.path &&
      next.untitled === buffer.untitled &&
      next.title === buffer.title &&
      next.truncated === buffer.truncated &&
      next.loadState === buffer.loadState &&
      next.diskVersion === buffer.diskVersion &&
      next.externalChange?.kind === buffer.externalChange?.kind &&
      next.externalChange?.observedVersion === buffer.externalChange?.observedVersion &&
      next.preview === buffer.preview
    ) {
      return buffer;
    }
    changed = true;
    return next;
  });
  return changed ? { ...state, buffers } : state;
}

export function loadTextBufferInState(
  state: FilesEditorState,
  id: string,
  params: { text: string; truncated?: boolean; version?: string },
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (!isFilesTextBuffer(buffer) || buffer.id !== id || buffer.loadState !== "loading") {
      return buffer;
    }
    changed = true;
    return {
      ...buffer,
      text: params.text,
      savedText: params.text,
      truncated: params.truncated,
      loadState: undefined,
      diskVersion: params.version ?? buffer.diskVersion,
      externalChange: undefined,
    };
  });
  return changed ? { ...state, buffers } : state;
}

/**
 * 大文本决策拿到首窗总大小时补全元数据；不保存窗口正文或偏移。
 *
 * 恢复标签在首次决策前只有路径元数据；写入 totalBytes 后 viewer 才不会继续
 * 把该标签当成「尚未决策」而重复触发恢复读取。
 */
export function setLargeTextTotalBytesInState(
  state: FilesEditorState,
  id: string,
  totalBytes: number | undefined,
  readonlyReason?: "encoding",
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (
      !isFilesLargeTextBuffer(buffer) ||
      buffer.id !== id ||
      (buffer.totalBytes === totalBytes && buffer.readonlyReason === readonlyReason)
    ) {
      return buffer;
    }
    changed = true;
    return { ...buffer, totalBytes, readonlyReason };
  });
  return changed ? { ...state, buffers } : state;
}

/**
 * 恢复 / 重载决策发现磁盘文件已回到可编辑阈值内：
 * 在原 ID、原标签位置与预览标记内把只读大文本缓冲替换为完整文本缓冲。
 */
export function completeLargeTextBufferAsTextInState(
  state: FilesEditorState,
  id: string,
  params: { text: string },
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || buffer.id !== id) {
      return buffer;
    }
    changed = true;
    const textBuffer: FilesTextBuffer = {
      id: buffer.id,
      kind: "text",
      untitled: false,
      path: buffer.path,
      title: buffer.title,
      text: params.text,
      savedText: params.text,
      workspace: buffer.workspace,
      preview: buffer.preview,
    };
    return textBuffer;
  });
  return changed ? { ...state, buffers } : state;
}

export function setTextBufferLoadStateInState(
  state: FilesEditorState,
  id: string,
  loadState: FilesTextBufferLoadState | undefined,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (!isFilesTextBuffer(buffer) || buffer.id !== id || buffer.loadState === loadState) {
      return buffer;
    }
    changed = true;
    return { ...buffer, loadState };
  });
  return changed ? { ...state, buffers } : state;
}

export function persistableDrafts(state: FilesEditorState): FilesPersistedDraft[] {
  const seen = new Set<string>();
  return state.buffers.flatMap((buffer) => {
    if (!isFilesTextBuffer(buffer) || !isFilesBufferDirty(buffer) || seen.has(buffer.id)) {
      return [];
    }
    seen.add(buffer.id);
    return [
      {
        id: buffer.id,
        path: buffer.path,
        title: buffer.title,
        text: buffer.text,
        savedText: buffer.savedText,
        workspace: buffer.workspace,
        untitled: buffer.untitled,
        truncated: buffer.truncated === true ? true : undefined,
      },
    ];
  });
}

export function persistableOpenTabs(state: FilesEditorState): FilesPersistedOpenTab[] {
  const seen = new Set<string>();
  return state.openIds.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const buffer = findFilesBuffer(state, id);
    if (!buffer) {
      return [];
    }
    if (isFilesTextBuffer(buffer) && buffer.untitled && !isFilesBufferDirty(buffer)) {
      return [];
    }
    return [
      {
        id: buffer.id,
        kind: buffer.kind,
        path: buffer.path,
        workspace: buffer.workspace,
        untitled: isFilesTextBuffer(buffer) ? buffer.untitled : undefined,
        preview: buffer.preview === true ? true : undefined,
      },
    ];
  });
}
