import { createUuid } from "@zcode/shared";
import {
  replaceFilesBufferInState,
  discardFilesLargeTextEditsInState,
  initializeLargeTextEditInState,
  markLargeTextSavedInState,
  redoFilesLargeTextEditInState,
  restoreLargeTextEditInState,
  undoFilesLargeTextEditInState,
  updateFilesLargeTextBlockInState,
  type FilesLargeTextRestoreParams,
} from "@/files-workbench/filesLargeTextDraftModel.js";
import {
  setLargeTextExternalChangeInState,
  setTextExternalChangeInState,
} from "@/files-workbench/filesLargeTextDraftExternal.js";
import type {
  FilesEditorState,
  FilesExternalChange,
  FilesLargeTextBlockTarget,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 大文件块编辑的 Store actions。
 *
 * 放在独立模块里，避免主 Store 越过 max-lines；状态转换全部委托给纯函数，
 * 主 Store 只负责接入。Files Editor Store 仍是 edit / 脏态 / 历史的唯一所有者。
 */
export type FilesLargeTextEditSet = (
  updater: (state: FilesEditorState) => FilesEditorState,
) => void;

export type FilesLargeTextEditGet = () => FilesEditorState;

export interface FilesLargeTextEditActions {
  beginLargeTextSave: (id: string) => string | undefined;
  endLargeTextSave: (id: string, token: string) => void;
  /** 打开 / 恢复决策完成后建立补丁基准；相同基准幂等。 */
  initializeLargeTextEdit: (id: string, version: string, totalBytes: number) => void;
  /** 当前块整块替换；同一 offset 最多一条，非法块拒绝写入。 */
  updateLargeTextBlock: (id: string, block: FilesLargeTextBlockTarget, text: string) => void;
  undoLargeTextEdit: (id: string) => void;
  redoLargeTextEdit: (id: string) => void;
  /** 保存成功：更新基准并清空修改 / 历史；path 变化时只迁移路径与标题。 */
  markLargeTextSaved: (
    id: string,
    params: { path?: string; version: string; totalBytes: number },
  ) => void;
  /** 用户放弃修改：清空草稿与历史，保留基准。 */
  discardLargeTextEdits: (id: string) => void;
  /** IndexedDB 草稿恢复；只有无草稿或 baseVersion 一致时套用。 */
  restoreLargeTextEdit: (id: string, params: FilesLargeTextRestoreParams) => boolean;
  setLargeTextExternalChange: (id: string, change?: FilesExternalChange) => void;
  /** 普通文本外部变化只提示，不改正文或基准。 */
  setTextExternalChange: (id: string, change?: FilesExternalChange) => void;
}

export function createFilesLargeTextEditActions(
  set: FilesLargeTextEditSet,
  get: FilesLargeTextEditGet,
): FilesLargeTextEditActions {
  return {
    beginLargeTextSave: (id) => {
      let token: string | undefined;
      set((state) => replaceFilesBufferInState(state, id, (buffer) => {
        if (buffer.kind !== "large-text" || !buffer.edit || buffer.saveToken) return buffer;
        token = createUuid();
        return { ...buffer, saveToken: token };
      }));
      return token;
    },
    endLargeTextSave: (id, token) => {
      set((state) => replaceFilesBufferInState(state, id, (buffer) =>
        buffer.kind === "large-text" && buffer.saveToken === token
          ? { ...buffer, saveToken: undefined }
          : buffer,
      ));
    },
    initializeLargeTextEdit: (id, version, totalBytes) => {
      set((state) => initializeLargeTextEditInState(state, id, version, totalBytes));
    },
    updateLargeTextBlock: (id, block, text) => {
      set((state) => updateFilesLargeTextBlockInState(state, id, block, text));
    },
    undoLargeTextEdit: (id) => {
      set((state) => undoFilesLargeTextEditInState(state, id));
    },
    redoLargeTextEdit: (id) => {
      set((state) => redoFilesLargeTextEditInState(state, id));
    },
    markLargeTextSaved: (id, params) => {
      set((state) => markLargeTextSavedInState(state, id, params));
    },
    discardLargeTextEdits: (id) => {
      set((state) => discardFilesLargeTextEditsInState(state, id));
    },
    restoreLargeTextEdit: (id, params) => {
      const before = get();
      const after = restoreLargeTextEditInState(before, id, params);
      if (after === before) return false;
      set(() => after);
      return true;
    },
    setLargeTextExternalChange: (id, change) => {
      set((state) => setLargeTextExternalChangeInState(state, id, change));
    },
    setTextExternalChange: (id, change) => {
      set((state) => setTextExternalChangeInState(state, id, change));
    },
  };
}
