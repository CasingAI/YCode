import type {
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

function parseOpenTab(value: unknown): FilesPersistedOpenTab | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const tab = value as Partial<FilesPersistedOpenTab>;
  if (typeof tab.id !== "string" || (tab.kind !== "text" && tab.kind !== "preview")) {
    return undefined;
  }
  if (!isWorkspaceRef(tab.workspace)) {
    return undefined;
  }
  return {
    id: tab.id,
    kind: tab.kind,
    path: typeof tab.path === "string" ? tab.path : undefined,
    workspace: tab.workspace,
    untitled: tab.untitled === true,
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
    const drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.flatMap((draft) => {
          const next = parseDraft(draft);
          return next ? [next] : [];
        })
      : [];
    const openTabs = Array.isArray(parsed.openTabs)
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
        }));
    return {
      version: 1,
      explorerWorkspaceKey:
        typeof parsed.explorerWorkspaceKey === "string" ? parsed.explorerWorkspaceKey : undefined,
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : undefined,
      openFileIds: Array.isArray(parsed.openFileIds)
        ? parsed.openFileIds.filter((id): id is string => typeof id === "string")
        : openTabs.map((tab) => tab.id),
      openTabs,
      drafts,
    };
  } catch {
    return undefined;
  }
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
