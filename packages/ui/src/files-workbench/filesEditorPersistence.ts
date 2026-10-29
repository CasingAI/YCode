import { persistableDrafts, persistableOpenTabs } from "@/files-workbench/filesEditorModel.js";
import type {
  FilesEditorState,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
  FilesPersistedSession,
} from "@/files-workbench/filesEditorTypes.js";

const STORAGE_KEY = "zcode-files-editor-session-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isWorkspaceRef(value: unknown): value is FilesPersistedDraft["workspace"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const workspace = value as { workspacePath?: unknown };
  return typeof workspace.workspacePath === "string" && workspace.workspacePath.length > 0;
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  // Keep the most recent payload for an ID while preserving the ID's first position.
  const unique = new Map<string, T>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()];
}

function parseOpenTab(value: unknown): FilesPersistedOpenTab | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const tab = value as Partial<FilesPersistedOpenTab>;
  if (
    typeof tab.id !== "string" ||
    (tab.kind !== "text" && tab.kind !== "preview" && tab.kind !== "large-text")
  ) {
    return undefined;
  }
  if (!isWorkspaceRef(tab.workspace)) {
    return undefined;
  }
  // 大文本只持久化路径与 kind；没有路径的条目无法恢复。
  if (tab.kind === "large-text" && (typeof tab.path !== "string" || !tab.path)) {
    return undefined;
  }
  return {
    id: tab.id,
    kind: tab.kind,
    path: typeof tab.path === "string" ? tab.path : undefined,
    workspace: tab.workspace,
    untitled: tab.untitled === true,
    preview: tab.preview === true ? true : undefined,
  };
}

function parseDraft(value: unknown): FilesPersistedDraft | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const draft = value as Partial<FilesPersistedDraft>;
  if (typeof draft.id !== "string" || typeof draft.title !== "string") {
    return undefined;
  }
  if (typeof draft.text !== "string" || typeof draft.savedText !== "string") {
    return undefined;
  }
  if (!isWorkspaceRef(draft.workspace)) {
    return undefined;
  }
  return {
    id: draft.id,
    path: typeof draft.path === "string" ? draft.path : undefined,
    title: draft.title,
    text: draft.text,
    savedText: draft.savedText,
    workspace: draft.workspace,
    untitled: draft.untitled === true,
    // 未知旧草稿不丢正文；只额外保留旧版截断标记，避免恢复后被误判为完整可保存。
    truncated: draft.truncated === true ? true : undefined,
  };
}

export function readFilesEditorSession(
  storage: StorageLike | undefined = getBrowserStorage(),
): FilesPersistedSession | undefined {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FilesPersistedSession>;
    if (parsed.version !== 1) {
      return undefined;
    }
    const drafts = uniqueById(
      Array.isArray(parsed.drafts)
        ? parsed.drafts.flatMap((draft) => {
            const next = parseDraft(draft);
            return next ? [next] : [];
          })
        : [],
    );
    const openTabs = uniqueById(
      Array.isArray(parsed.openTabs)
        ? parsed.openTabs.flatMap((tab) => {
            const next = parseOpenTab(tab);
            return next ? [next] : [];
          })
        : drafts.map((draft) => ({
            id: draft.id,
            kind: "text" as const,
            path: draft.path,
            workspace: draft.workspace,
            untitled: draft.untitled,
          })),
    );
    const validIds = new Set([
      ...openTabs.map((tab) => tab.id),
      ...drafts.map((draft) => draft.id),
    ]);
    const savedIds = Array.isArray(parsed.openFileIds)
      ? parsed.openFileIds.filter((id): id is string => typeof id === "string")
      : [];
    // Older/corrupt sessions may contain repeated IDs or references without a buffer record.
    // Recover every valid tab and dirty draft once instead of creating duplicate editor views.
    const openFileIds = [
      ...new Set([
        ...savedIds,
        ...openTabs.map((tab) => tab.id),
        ...drafts.map((draft) => draft.id),
      ]),
    ].filter((id) => validIds.has(id));
    const activeId =
      typeof parsed.activeId === "string" && openFileIds.includes(parsed.activeId)
        ? parsed.activeId
        : openFileIds.at(-1);
    return {
      version: 1,
      explorerWorkspaceKey:
        typeof parsed.explorerWorkspaceKey === "string" ? parsed.explorerWorkspaceKey : undefined,
      activeId,
      openFileIds,
      openTabs,
      drafts,
    };
  } catch {
    return undefined;
  }
}

/**
 * 只持久化标签与完整文本草稿；大文件块补丁由 IndexedDB 单独备份，
 * 不进入 localStorage session。
 */
export function snapshotFilesEditorSession(state: FilesEditorState): FilesPersistedSession {
  const openTabs = persistableOpenTabs(state);
  return {
    version: 1,
    explorerWorkspaceKey: state.explorerWorkspaceKey,
    activeId: state.activeId,
    openFileIds: openTabs.map((tab) => tab.id),
    openTabs,
    drafts: persistableDrafts(state),
  };
}

export function writeFilesEditorSession(
  session: FilesPersistedSession,
  storage: StorageLike | undefined = getBrowserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式或配额满时忽略，不阻断编辑。
  }
}
