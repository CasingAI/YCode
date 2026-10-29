import { getPathLeaf } from "@/lib/path.js";
import type {
  FilesBuffer,
  FilesLargeTextBuffer,
  FilesPreviewBuffer,
  FilesTextBuffer,
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

export function isFilesLargeTextBuffer(buffer: FilesBuffer): buffer is FilesLargeTextBuffer {
  return buffer.kind === "large-text";
}

export function isFilesPreviewTab(buffer: FilesBuffer): boolean {
  return buffer.preview === true;
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

export function createLargeTextFileBuffer(params: {
  workspace: FilesWorkspaceRef;
  path: string;
  /** 恢复旧会话时保留原缓冲 ID；新打开不传，使用路径派生的稳定 ID。 */
  id?: string;
  totalBytes?: number;
  readonlyReason?: "encoding";
  preview?: boolean;
}): FilesLargeTextBuffer {
  return {
    id: params.id ?? filesFileBufferId(params.workspace, params.path),
    kind: "large-text",
    path: params.path,
    title: getPathLeaf(params.path),
    workspace: params.workspace,
    preview: params.preview === true ? true : undefined,
    totalBytes: params.totalBytes,
    readonlyReason: params.readonlyReason,
  };
}

export function createRestoredLargeTextBuffer(params: {
  id: string;
  workspace: FilesWorkspaceRef;
  path: string;
  preview?: boolean;
}): FilesLargeTextBuffer {
  return createLargeTextFileBuffer({
    id: params.id,
    workspace: params.workspace,
    path: params.path,
    preview: params.preview,
  });
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
  /** 恢复旧会话时保留原缓冲 ID；新打开不传，使用路径派生的稳定 ID。 */
  id?: string;
}): FilesPreviewBuffer {
  return {
    id: params.id ?? filesFileBufferId(params.workspace, params.path),
    kind: "preview",
    path: params.path,
    title: getPathLeaf(params.path),
    workspace: params.workspace,
  };
}
