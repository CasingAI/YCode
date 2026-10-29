export type FilesBufferKind = "text" | "preview" | "large-text";

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

/**
 * 外部改动 / 删除提示。只用于 UI 提示，绝不自动替换草稿或重置基准。
 * `observedVersion` 是探测时看到的磁盘版本；`null` 表示探测时文件已不存在。
 */
export interface FilesExternalChange {
  kind: "changed" | "deleted";
  observedVersion?: string | null;
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
  /** 干净文件标签恢复后延迟读取正文；已加载缓冲不设置此字段。 */
  loadState?: FilesTextBufferLoadState;
  /** 预览标签；固定打开为 undefined。 */
  preview?: boolean;
  /**
   * 打开 / 自动重载 / 上次成功保存得到的磁盘版本。
   * 运行时字段，不写入 localStorage，也不作为跨重启的保存依据。
   */
  diskVersion?: string;
  /** 外部修改 / 删除提示；脏草稿只提示，不自动覆盖。 */
  externalChange?: FilesExternalChange;
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

/**
 * 固定块模型中的单块修改。
 *
 * 坐标始终基于 `baseVersion` 的原文件字节，不随其它块的增删重排；
 * 同一 `offset` 最多一条，EOF 追加使用 `deleteBytes: 0`。
 */
export interface FilesLargeTextBlockChange {
  blockIndex: number;
  /** 原文件（baseVersion）字节坐标中的块起点。 */
  offset: number;
  /** 本块在原文件中的字节数；EOF 追加时为 0。 */
  deleteBytes: number;
  /** 本块原始文本，用于脏态、撤销与丢弃。 */
  originalText: string;
  /** 当前块文本；空串表示删除整块内容。 */
  text: string;
}

/**
 * `updateLargeTextBlock` 的入参：当前已加载的磁盘原块。
 *
 * `hasDecodingErrors` 来自 range store 对本块精确字节范围的校验；
 * 为 true 时 Store 拒绝产生修改记录，非法块永远只读。
 */
export interface FilesLargeTextBlockTarget {
  blockIndex: number;
  offset: number;
  deleteBytes: number;
  originalText: string;
  hasDecodingErrors?: boolean;
}

/**
 * 全 buffer 撤销 / 重做历史项。
 *
 * 只记录一次用户编辑涉及的单个块文本，不复制全文；`before` / `after`
 * 为 `undefined` 表示该块当时没有修改记录（显示基准原文）。
 */
export interface FilesLargeTextEditHistoryEntry {
  blockIndex: number;
  offset: number;
  deleteBytes: number;
  originalText: string;
  before?: string;
  after?: string;
}

/** 固定块编辑草稿；Files Editor Store 是唯一所有者，跨 split 共享。 */
export interface FilesLargeTextEditState {
  /** 块坐标与补丁基准所对应的磁盘版本。 */
  baseVersion: string;
  baseTotalBytes: number;
  changes: FilesLargeTextBlockChange[];
  undoStack: FilesLargeTextEditHistoryEntry[];
  redoStack: FilesLargeTextEditHistoryEntry[];
  /** 每次 edit / undo / redo / discard / save 递增，供派生投影判断是否重建。 */
  revision: number;
}

/**
 * 大文本缓冲。
 *
 * 只保存标签与工作区身份；当前磁盘原块由 buffer 作用域的 range store 按需读取。
 * `totalBytes` 与 `readonlyReason` 只是读取决策留下的元数据，不写入持久化。
 * 编辑草稿（`edit`）由 Files Editor Store 独占，IndexedDB 只异步备份补丁。
 */
export interface FilesLargeTextBuffer {
  id: string;
  kind: "large-text";
  path: string;
  title: string;
  workspace: FilesWorkspaceRef;
  /** 预览标签；固定打开为 undefined。 */
  preview?: boolean;
  /** 读取决策首窗得到的文件总字节数，仅用于初始提示。 */
  totalBytes?: number;
  /**
   * 整体存在非法 UTF-8 的提示。只用于 UI 提示，不是 whole-file 永久只读：
   * 每次保存以各块 `hasDecodingErrors` 决定补丁范围。
   */
  readonlyReason?: "encoding";
  /** 固定块编辑草稿；未初始化时不存在。 */
  edit?: FilesLargeTextEditState;
  /** 提交期间跨 split 只读；只由 Store 的 begin/end 保存动作持有。 */
  saveToken?: string;
  /** 外部修改 / 删除提示；脏大文件不自动重基线。 */
  externalChange?: FilesExternalChange;
}

export type FilesBuffer = FilesTextBuffer | FilesPreviewBuffer | FilesLargeTextBuffer;

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
  /**
   * 旧版 256 KiB 截断草稿标记。新代码不再产生截断文本，但必须保留该标记，
   * 避免把不完整正文当成完整草稿恢复后可保存。
   */
  truncated?: boolean;
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
