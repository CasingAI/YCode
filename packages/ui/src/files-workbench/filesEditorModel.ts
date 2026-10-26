import { getPathLeaf } from "@/lib/path.js";
import { filesMonacoPathsEqual } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesOpenMode,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
  FilesPreviewBuffer,
  FilesTextBuffer,
  FilesTextBufferLoadState,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export function filesWorkspaceKey(
  workspace: Pick<FilesWorkspaceRef, "workspacePath" | "workspaceIdentity">,
): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

export function filesFileBufferId(workspace: FilesWorkspaceRef, path: string): string {
  return `file:${filesWorkspaceKey(workspace)}:${path}`;
}

export function isFilesTextBuffer(buffer: FilesBuffer): buffer is FilesTextBuffer {
  return buffer.kind === "text";
}

export function isFilesPreviewBuffer(buffer: FilesBuffer): buffer is FilesPreviewBuffer {
  return buffer.kind === "preview";
}

export function isFilesPreviewTab(buffer: FilesBuffer): boolean {
  return buffer.preview === true;
}

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
 * 已加载完成的可写文本缓冲才可保存；图片等只读预览不算，
 * 恢复中的正文尚未读盘，不能把占位空文本另存为真实文件。
 */
export function canSaveFilesBuffer(buffer: FilesBuffer): boolean {
  return isFilesTextBuffer(buffer) && buffer.loadState === undefined;
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

export function createUntitledTextBuffer(params: {
  id: string;
  title: string;
  workspace: FilesWorkspaceRef;
}): FilesTextBuffer {
  return {
    id: params.id,
    kind: "text",
    untitled: true,
    title: params.title,
    text: "",
    savedText: "",
    workspace: params.workspace,
  };
}

export function createTextFileBuffer(params: {
  workspace: FilesWorkspaceRef;
  path: string;
  text: string;
  truncated?: boolean;
}): FilesTextBuffer {
  return {
    id: filesFileBufferId(params.workspace, params.path),
    kind: "text",
    untitled: false,
    path: params.path,
    title: getPathLeaf(params.path),
    text: params.text,
    savedText: params.text,
    workspace: params.workspace,
    truncated: params.truncated,
  };
}

export function createRestoredTextFileBuffer(params: {
  id: string;
  workspace: FilesWorkspaceRef;
  path: string;
  preview?: boolean;
}): FilesTextBuffer {
  return {
    id: params.id,
    kind: "text",
    untitled: false,
    path: params.path,
    title: getPathLeaf(params.path),
    text: "",
    savedText: "",
    workspace: params.workspace,
    preview: params.preview === true ? true : undefined,
    loadState: "unloaded",
  };
}

export function createPreviewBuffer(params: {
  workspace: FilesWorkspaceRef;
  path: string;
}): FilesPreviewBuffer {
  return {
    id: filesFileBufferId(params.workspace, params.path),
    kind: "preview",
    path: params.path,
    title: getPathLeaf(params.path),
    workspace: params.workspace,
  };
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
      "text" | "savedText" | "path" | "untitled" | "title" | "truncated" | "loadState"
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
  params: { text: string; truncated?: boolean },
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
    };
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
