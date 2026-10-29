import { createUuid } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { removeFilesEditorViewsForBuffer } from "@/files-workbench/filesEditorLayoutOperations.js";
import {
  filesFileBufferId,
  filesWorkspaceKey,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { normalizeFilesMonacoPath } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesEditorLayoutState } from "@/files-workbench/filesEditorLayout.js";
import type {
  FilesBuffer,
  FilesEditorFocusRequest,
  FilesEditorState,
  FilesPendingOpen,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export interface FilesEditorFileMutation {
  workspace: FilesWorkspaceRef;
  kind: "rename" | "move" | "delete";
  path: string;
  newPath?: string;
}

export interface FilesEditorFileMutationState extends FilesEditorState {
  layout: FilesEditorLayoutState;
  editorFocusRequest?: FilesEditorFocusRequest;
  pendingOpenInFlight?: FilesPendingOpen;
  lastFileMutation?: FilesEditorFileMutation;
}

export function filesEditorMutationMatchesPath(
  mutation: FilesEditorFileMutation,
  workspace: FilesWorkspaceRef,
  path: string,
): boolean {
  if (
    filesWorkspaceKey(workspace) !== filesWorkspaceKey(mutation.workspace) ||
    (workspace.workspaceRemoteSessionId?.trim() || "") !==
      (mutation.workspace.workspaceRemoteSessionId?.trim() || "")
  ) {
    return false;
  }
  const source = normalizeFilesMonacoPath(mutation.path).replace(/\/$/, "");
  const candidate = normalizeFilesMonacoPath(path);
  return candidate === source || candidate.startsWith(`${source}/`);
}

function migratePath(path: string, mutation: FilesEditorFileMutation): string {
  const source = normalizeFilesMonacoPath(mutation.path).replace(/\/$/, "");
  const suffix = normalizeFilesMonacoPath(path).slice(source.length);
  const target = mutation.newPath!.replace(/[\\/]+$/, "");
  return `${target}${target.includes("\\") ? suffix.replace(/\//g, "\\") : suffix}`;
}

/** 文件变更只协调既有缓冲与打开意图；磁盘 IO 和持久化由调用方负责。 */
export function applyFilesEditorFileMutation(
  state: FilesEditorFileMutationState,
  mutation: FilesEditorFileMutation,
): FilesEditorFileMutationState {
  if (mutation.kind !== "delete" && (!mutation.newPath || mutation.newPath === mutation.path)) {
    return state;
  }
  const matches = (workspace: FilesWorkspaceRef, path: string | undefined) =>
    path !== undefined && filesEditorMutationMatchesPath(mutation, workspace, path);
  const affected = state.buffers.filter((buffer) => matches(buffer.workspace, buffer.path));
  const affectedIds = new Set(affected.map((buffer) => buffer.id));
  const nextIdById = new Map<string, string>();
  const nextBufferById = new Map<string, FilesBuffer>();
  const removedIds = new Set<string>();
  let untitledSerial = state.untitledSerial;

  const preserveDraft = (buffer: FilesTextBuffer) => {
    const id = `untitled:${createUuid()}`;
    const draft: FilesTextBuffer = {
      ...buffer,
      id,
      path: undefined,
      title: `Untitled-${untitledSerial++}`,
      untitled: true,
      preview: undefined,
      loadState: undefined,
    };
    nextIdById.set(buffer.id, id);
    nextBufferById.set(buffer.id, draft);
  };

  // 大文件没有完整正文，不能转成 untitled；只能保留原路径与 edit，
  // 由外部变化提示阻止自动写回已删除 / 已改名的旧路径。
  const markExternalChanged = (buffer: FilesBuffer): FilesBuffer =>
    buffer.kind === "preview" ? buffer : { ...buffer, externalChange: { kind: "changed" } };

  for (const buffer of affected) {
    if (mutation.kind === "delete") {
      // 删除不能留下可保存回旧路径的脏标签；普通文本保留为 untitled，
      // 大文件保留原路径和补丁，只标记 deleted，不能静默丢弃。
      if (isFilesLargeTextBuffer(buffer) && isFilesBufferDirty(buffer)) {
        nextBufferById.set(buffer.id, {
          ...buffer,
          externalChange: { kind: "deleted" },
        });
        continue;
      }
      if (buffer.kind === "text" && isFilesBufferDirty(buffer)) preserveDraft(buffer);
      else removedIds.add(buffer.id);
      continue;
    }
    const path = migratePath(buffer.path!, mutation);
    const id = filesFileBufferId(buffer.workspace, path);
    const collision = state.buffers.find(
      (candidate) => candidate.id === id && !affectedIds.has(candidate.id),
    );
    if (collision && isFilesLargeTextBuffer(collision) && isFilesBufferDirty(collision)) {
      // 目标路径的脏大文件无法转 untitled；拒绝本次迁移，保留双方补丁与路径。
      nextBufferById.set(buffer.id, markExternalChanged(buffer));
      nextBufferById.set(collision.id, markExternalChanged(collision));
      continue;
    }
    if (collision) {
      // 目标磁盘路径可能已不存在，但它的旧脏缓冲仍在；不能让新身份覆盖未保存正文。
      if (collision.kind === "text" && isFilesBufferDirty(collision)) preserveDraft(collision);
      else removedIds.add(collision.id);
    }
    nextIdById.set(buffer.id, id);
    nextBufferById.set(buffer.id, {
      ...buffer,
      id,
      path,
      title: getPathLeaf(path),
      ...(buffer.kind === "text" && buffer.loadState ? { loadState: "unloaded" as const } : {}),
      // 脏大文件不 rebase：保留 baseVersion/edit，只提示 changed；
      // 干净大文件清掉旧基准，交给后续 watch / restore 重新探测版本。
      ...(isFilesLargeTextBuffer(buffer)
        ? isFilesBufferDirty(buffer)
          ? { externalChange: { kind: "changed" as const } }
          : { edit: undefined, externalChange: undefined }
        : {}),
    });
  }

  const buffers = state.buffers.flatMap((buffer) =>
    removedIds.has(buffer.id) ? [] : [nextBufferById.get(buffer.id) ?? buffer],
  );
  const openIds = state.openIds.flatMap((id) =>
    removedIds.has(id) ? [] : [nextIdById.get(id) ?? id],
  );
  let layout = state.layout;
  for (const id of removedIds) layout = removeFilesEditorViewsForBuffer(layout, id);
  layout = {
    ...layout,
    groups: Object.fromEntries(
      Object.entries(layout.groups).map(([id, group]) => [
        id,
        {
          ...group,
          views: group.views.map((view) => ({
            ...view,
            bufferId: nextIdById.get(view.bufferId) ?? view.bufferId,
          })),
        },
      ]),
    ),
  };
  const focusedGroup = layout.groups[layout.focusedGroupId];
  const activeId =
    state.activeId && !removedIds.has(state.activeId)
      ? (nextIdById.get(state.activeId) ?? state.activeId)
      : focusedGroup?.views.find((view) => view.id === focusedGroup.activeViewId)?.bufferId;

  const migrateRequest = <T extends FilesPendingOpen>(request: T | undefined): T | undefined => {
    if (!request || !matches(request.workspace, request.path)) return request;
    return mutation.kind === "delete"
      ? undefined
      : { ...request, path: migratePath(request.path, mutation) };
  };
  const queue = state.pendingOpenQueue ?? (state.pendingOpen ? [state.pendingOpen] : []);
  const pendingOpenQueue = queue.flatMap((request) => {
    const next = migrateRequest(request);
    return next ? [next] : [];
  });
  const invalidatedRead =
    state.pendingOpenInFlight &&
    matches(state.pendingOpenInFlight.workspace, state.pendingOpenInFlight.path);
  const explorerMatches = state.explorerWorkspaceKey === filesWorkspaceKey(mutation.workspace);
  const migrateExplorerPath = (path: string | undefined) => {
    if (!explorerMatches || !matches(mutation.workspace, path)) return path;
    return mutation.kind === "delete" ? undefined : migratePath(path!, mutation);
  };
  return {
    ...state,
    buffers,
    openIds,
    activeId,
    layout,
    untitledSerial,
    pendingOpen: pendingOpenQueue[0],
    pendingOpenQueue: pendingOpenQueue.length > 0 ? pendingOpenQueue : undefined,
    pendingOpenInFlight: invalidatedRead ? undefined : state.pendingOpenInFlight,
    editorFocusRequest: migrateRequest(state.editorFocusRequest),
    revealPath: migrateExplorerPath(state.revealPath),
    pendingSaveDirectory: migrateExplorerPath(state.pendingSaveDirectory),
    // 只保留最近一次已完成事实，供在途读取同步失效；不是重试队列，也不写入会话快照。
    lastFileMutation: { ...mutation },
  };
}
