export type FilesBufferKind = "text" | "preview";

export type FilesTextBufferLoadState = "unloaded" | "loading" | "error";

/** 工作台打开方式：预览可被下一次单击替换；固定不会。 */
export type FilesOpenMode = "preview" | "keep";

export interface FilesWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export interface FilesMonacoRevealPosition {
  workspace: FilesWorkspaceRef;
  path: string;
  line: number;
  column: number;
}

/**
 * 打开文件后把键盘焦点交给目标编辑器的请求。
 *
 * 一次性意图：请求可能早于编辑器创建发出（文件还没打开），
 * 目标编辑器就绪时消费同一个 requestId 即可生效。
 */
export interface FilesEditorFocusRequest {
  workspace: FilesWorkspaceRef;
  path: string;
  requestId: number;
}

export type FilesMonacoOpenPath = (
  workspace: FilesWorkspaceRef,
  path: string,
  position?: Pick<FilesMonacoRevealPosition, "line" | "column">,
) => boolean | Promise<boolean>;

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
  /** 干净文件标签恢复后延迟读取正文；已加载缓冲不设置此字段。 */
  loadState?: FilesTextBufferLoadState;
  /** 预览标签；固定打开为 undefined。 */
  preview?: boolean;
}

export interface FilesPreviewBuffer {
  id: string;
  kind: "preview";
  path: string;
  title: string;
  workspace: FilesWorkspaceRef;
  /** 预览标签；固定打开为 undefined。 */
  preview?: boolean;
}

export type FilesBuffer = FilesTextBuffer | FilesPreviewBuffer;

export interface FilesPendingOpen {
  workspace: FilesWorkspaceRef;
  path: string;
  preview?: boolean;
}

export interface FilesEditorState {
  buffers: FilesBuffer[];
  openIds: string[];
  activeId?: string;
  explorerWorkspaceKey?: string;
  revealPath?: string;
  pendingSaveDirectory?: string;
  pendingOpen?: FilesPendingOpen;
  pendingOpenQueue?: FilesPendingOpen[];
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
  preview?: boolean;
}

export interface FilesPersistedSession {
  version: 1;
  explorerWorkspaceKey?: string;
  activeId?: string;
  openFileIds: string[];
  openTabs: FilesPersistedOpenTab[];
  drafts: FilesPersistedDraft[];
}
