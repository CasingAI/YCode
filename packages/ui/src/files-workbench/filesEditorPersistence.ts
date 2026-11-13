import { logger } from "@/logger.js";
import { persistableDrafts, persistableOpenTabs } from "@/files-workbench/filesEditorModel.js";
import type {
  FilesEditorState,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
  FilesPersistedSession,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 文件工作台会话持久化。
 *
 * localStorage 保存标签与小体积完整文本草稿；超过本地预算的完整文本草稿
 * 异步写入 IndexedDB，避免 10 MiB 级草稿在配额失败时被静默丢弃。
 * 这里只做备份，运行时草稿 owner 仍是 Files Editor Store。
 */

const STORAGE_KEY = "zcode-files-editor-session-v1";

/** 单个草稿进入 localStorage 的字符预算；超过即转 IndexedDB。 */
export const FILES_TEXT_DRAFT_LOCAL_STORAGE_MAX_CHARS = 1024 * 1024;
/** 整个会话的 localStorage 草稿总字符预算。 */
export const FILES_LOCAL_STORAGE_SESSION_MAX_CHARS = 4 * 1024 * 1024;

export interface FilesEditorSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getFilesEditorSessionBrowserStorage(): FilesEditorSessionStorage | undefined {
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
    // 合并 epoch 只接受有限数字；旧会话缺省时按本地优先处理。
    ...(typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt)
      ? { updatedAt: draft.updatedAt }
      : undefined),
    // 未知旧草稿不丢正文；只额外保留旧版截断标记，避免恢复后被误判为完整可保存。
    truncated: draft.truncated === true ? true : undefined,
  };
}

export function readFilesEditorSession(
  storage: FilesEditorSessionStorage | undefined = getFilesEditorSessionBrowserStorage(),
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

export interface FilesEditorSessionSplitOptions {
  /** 单个草稿进入 localStorage 的最大字符数（text + savedText）。 */
  singleDraftMaxChars?: number;
  /** 整个会话草稿进入 localStorage 的最大总字符数。 */
  totalDraftMaxChars?: number;
}

export interface FilesEditorSessionSplit {
  /** 仍需写入 localStorage 的标签与草稿。 */
  session: FilesPersistedSession;
  /** 超过本地预算、需要 IndexedDB 备份的完整文本草稿。 */
  overflowDrafts: FilesPersistedDraft[];
}

function draftCharCount(draft: FilesPersistedDraft): number {
  return draft.text.length + draft.savedText.length;
}

function sumDraftChars(drafts: readonly FilesPersistedDraft[]): number {
  return drafts.reduce((total, draft) => total + draftCharCount(draft), 0);
}

/**
 * 按本地预算拆分会话：先移出单个超大草稿，再从最大的开始移出，
 * 直到剩余草稿总量不超过会话预算。
 */
export function splitFilesEditorSessionForStorage(
  session: FilesPersistedSession,
  options: FilesEditorSessionSplitOptions = {},
): FilesEditorSessionSplit {
  const singleMax = options.singleDraftMaxChars ?? FILES_TEXT_DRAFT_LOCAL_STORAGE_MAX_CHARS;
  const totalMax = options.totalDraftMaxChars ?? FILES_LOCAL_STORAGE_SESSION_MAX_CHARS;
  const overflowIds = new Set(
    session.drafts.filter((draft) => draftCharCount(draft) > singleMax).map((draft) => draft.id),
  );
  const remaining = session.drafts.filter((draft) => !overflowIds.has(draft.id));
  let remainingChars = sumDraftChars(remaining);
  if (remainingChars > totalMax) {
    const largestFirst = [...remaining].sort((left, right) => {
      return draftCharCount(right) - draftCharCount(left);
    });
    for (const draft of largestFirst) {
      if (remainingChars <= totalMax) break;
      overflowIds.add(draft.id);
      remainingChars -= draftCharCount(draft);
    }
  }
  return {
    session: {
      ...session,
      drafts: session.drafts.filter((draft) => !overflowIds.has(draft.id)),
    },
    overflowDrafts: session.drafts.filter((draft) => overflowIds.has(draft.id)),
  };
}

function removeLargestDraft(
  session: FilesPersistedSession,
): { session: FilesPersistedSession; draft: FilesPersistedDraft } | undefined {
  let largest: FilesPersistedDraft | undefined;
  for (const draft of session.drafts) {
    if (!largest || draftCharCount(draft) > draftCharCount(largest)) {
      largest = draft;
    }
  }
  if (!largest) return undefined;
  return {
    session: { ...session, drafts: session.drafts.filter((draft) => draft.id !== largest.id) },
    draft: largest,
  };
}

export type FilesEditorSessionWriteStatus = "written" | "quota" | "unavailable";

export interface FilesEditorSessionWriteResult {
  status: FilesEditorSessionWriteStatus;
  /** 未写入 localStorage 的完整文本草稿；调用方必须交给 IndexedDB 备份。 */
  overflowDrafts: FilesPersistedDraft[];
}

/**
 * 写入 localStorage 会话。配额失败不是静默忽略：把最大的剩余草稿移出后重试，
 * 并把所有未写入的草稿作为 `overflowDrafts` 返回给 IndexedDB 备份。
 */
export function writeFilesEditorSession(
  session: FilesPersistedSession,
  storage: FilesEditorSessionStorage | undefined = getFilesEditorSessionBrowserStorage(),
  options: FilesEditorSessionSplitOptions = {},
): FilesEditorSessionWriteResult {
  const initial = splitFilesEditorSessionForStorage(session, options);
  const overflowDrafts = [...initial.overflowDrafts];
  if (!storage) {
    // 没有 localStorage 时所有完整文本草稿都必须交给 IndexedDB，不能只备份超预算部分。
    return { status: "unavailable", overflowDrafts: session.drafts };
  }
  let candidate = initial.session;
  for (;;) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      return { status: "written", overflowDrafts };
    } catch (error) {
      const next = removeLargestDraft(candidate);
      if (!next) {
        logger.warn("[files-workbench] 文件会话写入 localStorage 失败", { error });
        return { status: "quota", overflowDrafts };
      }
      // 配额不足时把最大草稿转给 IndexedDB，并重试剩余标签与小草稿。
      overflowDrafts.push(next.draft);
      candidate = next.session;
    }
  }
}
