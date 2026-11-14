import type {
  FilesEditorState,
  FilesTextBuffer,
  FilesTextDocumentBinding,
} from "@/files-workbench/filesEditorTypes.js";

/** 语言 / Markdown 模式判断只读这么多字符的首行；超长单行不退化成全文扫描。 */
export const FILES_TEXT_FIRST_LINE_MAX_CHARS = 2048;

/**
 * 保存基线按绑定对象（= Monaco model 版本域）保留。
 *
 * 绑定是 model 单例；同一个 model 在主题切换 / 拖组 / 分屏重建后仍回到同一
 * 版本域，必须恢复原基线，才能让“撤销回保存点”继续判为 clean。包装对象
 * 身份（buffer / React 组件）不能作为版本域依据。
 */
const savedVersionByDocument = new WeakMap<FilesTextDocumentBinding, number | null>();

/** 记住某个 model 版本域的保存基线；绑定销毁后随 WeakMap 一起回收。 */
export function rememberFilesTextDocumentSavedVersion(
  document: FilesTextDocumentBinding,
  versionId: number | null,
): void {
  savedVersionByDocument.set(document, versionId);
}

/**
 * 正文被外部整体替换后，旧基线不再属于新版本身份。
 *
 * 典型场景：编辑器卸载后磁盘重载更新缓冲，再挂载时 model 被 `setValue`
 * 重写；此时不能沿用卸载前的版本号。
 */
export function forgetFilesTextDocumentSavedVersion(document: FilesTextDocumentBinding): void {
  savedVersionByDocument.delete(document);
}

export function filesTextDocumentSavedVersion(
  document: FilesTextDocumentBinding,
): number | null | undefined {
  return savedVersionByDocument.get(document);
}

/**
 * 取当前有效的运行时正文文档。
 *
 * 绑定可能随编辑器卸载被销毁；销毁后不能再用它读正文，调用方必须回退到
 * `buffer.text` 快照，而不是把空串当正文。
 */
export function activeFilesTextDocument(
  buffer: FilesTextBuffer,
): FilesTextDocumentBinding | undefined {
  const document = buffer.document;
  return document && !document.isDisposed() ? document : undefined;
}

/** 当前文档版本号；未绑定或已销毁时为 undefined。 */
export function filesTextBufferDocumentVersionId(buffer: FilesTextBuffer): number | undefined {
  return activeFilesTextDocument(buffer)?.getVersionId();
}

/**
 * 绑定文档的脏态：只比较 O(1) 的替代版本号，不读全文。
 *
 * `savedDocumentVersionId === null` 表示绑定时草稿已经脏，没有干净基线；
 * 撤销回到保存点会回到同一版本号，自动恢复 clean。
 */
export function filesTextBufferDocumentIsDirty(buffer: FilesTextBuffer): boolean {
  const document = activeFilesTextDocument(buffer);
  if (!document) return false;
  if (buffer.savedDocumentVersionId === null) return true;
  if (buffer.savedDocumentVersionId === undefined) return true;
  return document.getVersionId() !== buffer.savedDocumentVersionId;
}

/**
 * 显式正文快照：绑定存在时读模型，否则使用缓冲里的上次快照。
 *
 * 只允许在保存、冲突探测、持久化等边界调用；逐键路径不得调用。
 */
export function snapshotFilesTextBuffer(buffer: FilesTextBuffer): string {
  return activeFilesTextDocument(buffer)?.getText() ?? buffer.text;
}

/** 保存 / 冲突 / 持久化使用的原子快照：正文与版本号必须来自同一时刻。 */
export function captureFilesTextSnapshot(buffer: FilesTextBuffer): {
  text: string;
  documentVersionId?: number;
} {
  const document = activeFilesTextDocument(buffer);
  if (!document) {
    return { text: buffer.text };
  }
  return { text: document.getText(), documentVersionId: document.getVersionId() };
}

/** 首行读取：绑定存在时只取有界区间，不扫描超长单行。 */
export function filesTextBufferFirstLine(
  buffer: FilesTextBuffer,
  maxLength = FILES_TEXT_FIRST_LINE_MAX_CHARS,
): string | undefined {
  const document = activeFilesTextDocument(buffer);
  if (document) return document.getFirstLine(maxLength);
  return textFirstLine(buffer.text, maxLength);
}

function textFirstLine(text: string, maxLength: number): string | undefined {
  if (!text) return undefined;
  const bounded = text.slice(0, maxLength);
  const end = bounded.search(/[\r\n]/);
  const line = end < 0 ? bounded : bounded.slice(0, end);
  return line.length > 0 ? line : undefined;
}

/** 空正文判断：绑定存在时用 O(1) 长度，不复制正文。 */
export function filesTextBufferIsEmpty(buffer: FilesTextBuffer): boolean {
  const document = activeFilesTextDocument(buffer);
  return document ? document.getLength() === 0 : buffer.text.length === 0;
}

/**
 * 迁移 / 转存时把正文固化成快照并解除绑定。
 *
 * 新缓冲会使用新的 Monaco model，旧的运行时文档不再属于它；带着旧绑定
 * 会让正文读取指向已经回收的模型。
 */
export function detachFilesTextBufferDocument(buffer: FilesTextBuffer): FilesTextBuffer {
  if (!buffer.document) return buffer;
  const text = snapshotFilesTextBuffer(buffer);
  return {
    ...buffer,
    text,
    document: undefined,
    savedDocumentVersionId: undefined,
    documentRevision: undefined,
  };
}

/**
 * 编辑器挂载后绑定运行时文档。
 *
 * 分屏的两个视图共享同一个 Monaco model，provider 返回同一个绑定对象；第二次
 * attach 只增加引用计数，绝不重算基线，否则一次重挂载就会抹掉保存点。
 */
export function attachTextDocumentInState(
  state: FilesEditorState,
  id: string,
  document: FilesTextDocumentBinding,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (buffer.id !== id || buffer.kind !== "text") {
      return buffer;
    }
    if (buffer.document === document) {
      if (document.isDisposed()) return buffer;
      changed = true;
      return {
        ...buffer,
        documentAttachments: (buffer.documentAttachments ?? 1) + 1,
      };
    }
    const previous = activeFilesTextDocument(buffer);
    // 旧绑定已销毁时无法再读版本号，只能用卸载时固化的正文快照判断脏态；
    // 不能因为「曾经有文档」就无条件把干净缓冲标脏，否则分屏重挂载会误报。
    const wasDirty = previous
      ? filesTextBufferDocumentIsDirty(buffer)
      : buffer.text !== buffer.savedText;
    // 同一 model 的版本域在卸载后仍保留基线；新的 model 不能沿用旧版本号。
    const remembered = filesTextDocumentSavedVersion(document);
    const savedDocumentVersionId =
      remembered !== undefined ? remembered : wasDirty ? null : document.getVersionId();
    rememberFilesTextDocumentSavedVersion(document, savedDocumentVersionId);
    changed = true;
    return {
      ...buffer,
      document,
      documentAttachments: 1,
      savedDocumentVersionId,
      notedDocumentVersionId: document.getVersionId(),
      documentRevision: buffer.documentRevision ?? 0,
    };
  });
  return changed ? { ...state, buffers } : state;
}

/**
 * 局部输入回调：只推进 revision / epoch，不读全文、不比较正文。
 *
 * 分屏共享同一 model 时会多次触发，但每次都是常数开销；持久化 owner 订阅
 * epoch 做去抖，真正的正文快照发生在 persist 边界。
 */
export function noteTextDocumentChangeInState(
  state: FilesEditorState,
  id: string,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (buffer.id !== id || buffer.kind !== "text") return buffer;
    const document = activeFilesTextDocument(buffer);
    if (!document) return buffer;
    // 分屏共享 model 时每个视图各有一个内容监听器；同一版本号只记一次，
    // 否则一次按键会推进两次 revision / epoch。
    const versionId = document.getVersionId();
    if (buffer.notedDocumentVersionId === versionId) return buffer;
    changed = true;
    return {
      ...buffer,
      notedDocumentVersionId: versionId,
      documentRevision: (buffer.documentRevision ?? 0) + 1,
      preview: undefined,
    };
  });
  return changed ? { ...state, buffers, textChangeEpoch: (state.textChangeEpoch ?? 0) + 1 } : state;
}

/**
 * 编辑器卸载前解除一个视图的绑定。
 *
 * 只有最后一个视图离开时才固化正文并解绑；分屏关闭其中一个视图时，仍存活
 * 视图继续编辑同一个 model，Store 必须保留权威文档与保存基线。
 *
 * 必须在 Monaco 模型销毁前调用，否则正文只剩上一次快照。
 */
export function detachTextDocumentInState(
  state: FilesEditorState,
  id: string,
  document: FilesTextDocumentBinding,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (buffer.id !== id || buffer.kind !== "text" || buffer.document !== document) {
      return buffer;
    }
    const remaining = (buffer.documentAttachments ?? 1) - 1;
    if (remaining > 0) {
      changed = true;
      return { ...buffer, documentAttachments: remaining };
    }
    changed = true;
    const text = document.isDisposed() ? buffer.text : document.getText();
    // 卸载只是暂时没有视图，版本域仍属于这个 model；先记住基线，
    // 同一 model 重新挂载时才能恢复“撤销回保存点即 clean”。
    rememberFilesTextDocumentSavedVersion(document, buffer.savedDocumentVersionId ?? null);
    return {
      ...buffer,
      text,
      document: undefined,
      documentAttachments: undefined,
      savedDocumentVersionId: undefined,
      notedDocumentVersionId: undefined,
      documentRevision: undefined,
    };
  });
  return changed ? { ...state, buffers } : state;
}

/**
 * 程序化正文替换（外部重载、草稿恢复、测试注入）的 Store 状态更新。
 *
 * 调用方必须已同步 `document.replaceText(text)`；这里只用当前版本号重建
 * 基线：回到 `savedText` 视为 clean，否则视为脏且没有可撤销的干净基线。
 */
export function updateTextInState(
  state: FilesEditorState,
  id: string,
  text: string,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.map((buffer) => {
    if (buffer.id !== id || buffer.kind !== "text") return buffer;
    const document = activeFilesTextDocument(buffer);
    const savedDocumentVersionId =
      text === buffer.savedText
        ? document?.getVersionId()
        : document
          ? null
          : buffer.savedDocumentVersionId;
    if (document && savedDocumentVersionId !== undefined) {
      rememberFilesTextDocumentSavedVersion(document, savedDocumentVersionId);
    }
    const next: FilesTextBuffer = {
      ...buffer,
      text,
      ...(document
        ? {
            savedDocumentVersionId,
            documentRevision: (buffer.documentRevision ?? 0) + 1,
          }
        : undefined),
    };
    if (
      next.text === buffer.text &&
      next.savedDocumentVersionId === buffer.savedDocumentVersionId &&
      next.documentRevision === buffer.documentRevision
    ) {
      return buffer;
    }
    next.preview = undefined;
    changed = true;
    return next;
  });
  return changed ? { ...state, buffers, textChangeEpoch: (state.textChangeEpoch ?? 0) + 1 } : state;
}
