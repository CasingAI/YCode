import { getPathLeaf } from "@/lib/path.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesOpenMode,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
  FilesPreviewBuffer,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export function filesWorkspaceKey(workspace: Pick<FilesWorkspaceRef, "workspacePath" | "workspaceIdentity">): string {
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
  return findFilesBuffer(state, id);
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
  const title = filesBufferTabTitle(buffer);
  return buffers.some(
    (candidate) =>
      candidate.id !== buffer.id &&
      filesBufferTabTitle(candidate) === title &&
      filesWorkspaceKey(candidate.workspace) !== filesWorkspaceKey(buffer.workspace),
  );
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
  patch: Partial<Pick<FilesTextBuffer, "text" | "savedText" | "path" | "untitled" | "title" | "truncated">>,
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
      next.preview === buffer.preview
    ) {
      return buffer;
    }
    changed = true;
    return next;
  });
  return changed ? { ...state, buffers } : state;
}

export function persistableDrafts(state: FilesEditorState): FilesPersistedDraft[] {
  return state.buffers.flatMap((buffer) => {
    if (!isFilesTextBuffer(buffer) || !isFilesBufferDirty(buffer)) {
      return [];
    }
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
  return state.openIds.flatMap((id) => {
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

export function restoreOpenFileIds(params: {
  drafts: readonly FilesPersistedDraft[];
  savedOpenIds: readonly string[];
}): string[] {
  const draftIds = new Set(params.drafts.map((draft) => draft.id));
  return params.savedOpenIds.filter((id) => draftIds.has(id) || id.startsWith("file:"));
}
