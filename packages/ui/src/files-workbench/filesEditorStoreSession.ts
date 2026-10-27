import { resolveFilesBufferKind } from "@/files-workbench/filesEditorKind.js";
import { createLayoutForOpenIds } from "@/files-workbench/filesEditorStoreLayout.js";
import {
  createPreviewBuffer,
  createRestoredTextFileBuffer,
  createUntitledTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer, FilesPersistedSession } from "@/files-workbench/filesEditorTypes.js";

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()];
}

export function restoreFilesEditorSession(
  session: FilesPersistedSession,
  previousUntitledSerial: number,
) {
  const uniqueDrafts = uniqueById(session.drafts);
  const uniqueOpenTabs = uniqueById(session.openTabs);
  const draftBuffers: FilesBuffer[] = uniqueDrafts.map((draft) => ({
    id: draft.id,
    kind: "text",
    untitled: draft.untitled,
    path: draft.path,
    title: draft.title,
    text: draft.text,
    savedText: draft.savedText,
    workspace: draft.workspace,
  }));
  const draftIds = new Set(draftBuffers.map((buffer) => buffer.id));
  const restoredBuffers = uniqueOpenTabs.flatMap<FilesBuffer>((tab, index) => {
    if (draftIds.has(tab.id)) return [];
    // 旧版本可能把图片 / PDF / Office 等误记为文本标签。干净标签按当前共用分类
    // 直接修正为预览，不在恢复元数据时读盘；保留原 ID 与预览标记，避免改变标签顺序。
    // 草稿在上面已优先返回，这里只处理没有草稿正文的干净标签。
    if (
      tab.path &&
      (tab.kind === "preview" || (!tab.untitled && resolveFilesBufferKind(tab.path) === "preview"))
    ) {
      return [
        {
          ...createPreviewBuffer({
            workspace: tab.workspace,
            path: tab.path,
            id: tab.id,
          }),
          preview: tab.preview === true ? true : undefined,
        },
      ];
    }
    if (tab.untitled) {
      return [
        createUntitledTextBuffer({
          id: tab.id,
          title: `Untitled-${index + 1}`,
          workspace: tab.workspace,
        }),
      ];
    }
    if (tab.path) {
      return [
        createRestoredTextFileBuffer({
          id: tab.id,
          path: tab.path,
          workspace: tab.workspace,
          preview: tab.preview,
        }),
      ];
    }
    return [];
  });
  const buffers = [...draftBuffers, ...restoredBuffers];
  const availableIds = new Set(buffers.map((buffer) => buffer.id));
  const openIds = [
    ...new Set([
      ...session.openFileIds,
      ...uniqueOpenTabs.map((tab) => tab.id),
      ...draftBuffers.map((buffer) => buffer.id),
    ]),
  ].filter((id) => availableIds.has(id));
  const activeId =
    session.activeId && openIds.includes(session.activeId) ? session.activeId : openIds.at(-1);

  return {
    buffers,
    explorerWorkspaceKey: session.explorerWorkspaceKey,
    activeId,
    openIds,
    layout: createLayoutForOpenIds(openIds, activeId),
    untitledSerial: Math.max(
      previousUntitledSerial,
      uniqueOpenTabs.filter((tab) => tab.untitled).length + 1,
    ),
  };
}
