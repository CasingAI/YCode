export type FilesBufferKind = "text" | "preview";

export interface FilesWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export interface FilesTextBuffer {
  id: string;
  kind: "text";
  untitled: boolean;
  path?: string;
  title: string;
  text: string;
  savedText: string;
  workspace: FilesWorkspaceRef;
  truncated?: boolean;
}

export interface FilesPreviewBuffer {
  id: string;
  kind: "preview";
  path: string;
  title: string;
  workspace: FilesWorkspaceRef;
}

export type FilesBuffer = FilesTextBuffer | FilesPreviewBuffer;

export interface FilesPendingOpen {
  workspace: FilesWorkspaceRef;
  path: string;
}

export interface FilesEditorState {
  buffers: FilesBuffer[];
  openIds: string[];
  activeId?: string;
  explorerWorkspaceKey?: string;
  revealPath?: string;
  pendingSaveDirectory?: string;
  pendingOpen?: FilesPendingOpen;
  untitledSerial: number;
}

export type FilesSaveConflictDecision = "overwrite" | "reload";

export type FilesDirtyCloseDecision = "save" | "discard" | "cancel";

export interface FilesPersistedDraft {
  id: string;
  path?: string;
  title: string;
  text: string;
  savedText: string;
  workspace: FilesWorkspaceRef;
  untitled: boolean;
}

export interface FilesPersistedOpenTab {
  id: string;
  kind: FilesBufferKind;
  path?: string;
  workspace: FilesWorkspaceRef;
  untitled?: boolean;
}

export interface FilesPersistedSession {
  version: 1;
  explorerWorkspaceKey?: string;
  activeId?: string;
  openFileIds: string[];
  openTabs: FilesPersistedOpenTab[];
  drafts: FilesPersistedDraft[];
}
