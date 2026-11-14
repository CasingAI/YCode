export type FilesBufferKind = "text" | "preview" | "large-text";

export type FilesTextBufferLoadState = "unloaded" | "loading" | "error";

/** 加载失败的明确原因；`too-large` 表示合法文本超过受控字节上限。 */
export type FilesTextBufferLoadError = "too-large";

/** 文本缓冲加载状态写入；错误原因只与 `error` 态一起保留。 */
export type FilesTextLoadStateSetter = (
  id: string,
  loadState: FilesTextBufferLoadState | undefined,
  loadError?: FilesTextBufferLoadError,
) => void;

/** 工作台打开方式：预览可被下一次单击替换；固定不会。 */
export type FilesOpenMode = "preview" | "keep";

export interface FilesWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

/**
 * legacy large-text 标签恢复前对保留块补丁记录的只读查询。
 *
 * `missing` 才能转完整正文；`error` 表示 IndexedDB 读取失败，必须保留旧标签
 * 以便重试，不能把失败当成“没有草稿”而切模型造成孤儿记录。
 */
export type FilesRetainedLargeTextDraftLookup =
  | { kind: "missing" }
  | { kind: "ready"; baseVersion: string; baseTotalBytes: number }
  | { kind: "error"; error: unknown };

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

/**
 * 完整文本缓冲绑定的运行时正文文档。
 *
 * 正文的唯一运行时副本在 Monaco 模型里；Store 只保存元数据、脏态基线与快照。
 * 局部输入只推进模型版本号，不读全文；保存 / 持久化 / 冲突判定等显式边界
 * 才通过 `getText` 取一致快照。
 */
export interface FilesTextDocumentBinding {
  /** 读取当前全文。只允许在显式快照点调用，不能进入逐键路径。 */
  getText(): string;
  /** Monaco 公开的替代版本号；撤销回到保存点会回到同一个值。 */
  getVersionId(): number;
  /** 同步替换整份正文；用于外部重载、草稿恢复与权威覆盖。 */
  replaceText(text: string): void;
  /** 读取有界首行，供语言 / Markdown 模式判断；不得扫描整份超长单行。 */
  getFirstLine(maxLength?: number): string | undefined;
  /** 正文长度；用于空正文判断，不复制正文。 */
  getLength(): number;
  /** 模型销毁后不能再作为正文来源，调用方回退到缓冲快照。 */
  isDisposed(): boolean;
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
  /** `loadState: "error"` 时的明确原因；不写入持久化。 */
  loadError?: FilesTextBufferLoadError;
  /** 预览标签；固定打开为 undefined。 */
  preview?: boolean;
  /**
   * 打开 / 自动重载 / 上次成功保存得到的磁盘版本。
   * 运行时字段，不写入 localStorage，也不作为跨重启的保存依据。
   */
  diskVersion?: string;
  /** 外部修改 / 删除提示；脏草稿只提示，不自动覆盖。 */
  externalChange?: FilesExternalChange;
  /** 绑定的运行时正文文档；未挂载编辑器或已销毁时不存在。 */
  document?: FilesTextDocumentBinding;
  /**
   * 当前 model 上仍挂载的编辑器视图数。分屏共享同一 model 时只有最后一个
   * 视图卸载才能固化正文并解绑；否则仍存活视图的输入会失去权威副本。
   */
  documentAttachments?: number;
  /**
   * 已保存点对应的文档版本号。
   * `null` 表示绑定时草稿已经脏（没有干净基线）；`undefined` 表示未绑定。
   */
  savedDocumentVersionId?: number | null;
  /** 最近一次已计入 revision 的文档版本号，用于合并同一 model 的重复监听回调。 */
  notedDocumentVersionId?: number;
  /** 每次局部输入递增，供标签脏标记与派生投影重渲染。 */
  documentRevision?: number;
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
  /**
   * 局部正文输入代次。每次已绑定文档发生内容变化时递增；
   * 持久化 owner 订阅该值做去抖，不读正文。保存 / 关闭等边界仍显式 flush。
   * 只读投影构造的状态对象可以省略（按 0 处理）。
   */
  textChangeEpoch?: number;
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
   * localStorage 草稿的合并 epoch；与 IndexedDB 记录 `updatedAt` 比较，
   * 决定冷启动时同 id 的本地草稿还是异步大草稿胜出。旧会话可缺省。
   */
  updatedAt?: number;
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
