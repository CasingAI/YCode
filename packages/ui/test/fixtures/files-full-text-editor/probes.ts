import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import {
  FILES_TEXT_DRAFT_DB_NAME,
  FILES_TEXT_DRAFT_DB_VERSION,
  FILES_TEXT_DRAFT_STORE_NAME,
} from "@/files-workbench/filesTextDraftStorage.js";

/**
 * 隔离夹具对页面暴露的只读探针类型与读取器。
 *
 * 这里不拥有业务状态：Store、Monaco 模型与 IndexedDB 都来自生产链路，
 * 读取器只把已存在的会话 / 草稿记录转成可序列化结果。
 */

export type MountMode = "fresh" | "restore";

export const SESSION_STORAGE_KEY = "zcode-files-editor-session-v1";

export type SaveEvent = Record<string, unknown> & { type: string };

export type TokenProbe = {
  token: string;
  index: number;
  count: number;
};

export type MonacoTokenMatch = {
  token: string;
  count: number;
  positions: Array<{ line: number; column: number; offset: number }>;
};

export type MonacoInfo = {
  valueLength: number;
  lineCount: number;
  firstLine: string;
  lastLine: string;
  tail: string;
  tokens: MonacoTokenMatch[];
  lineTexts: Array<{ line: number; text: string }>;
};

export type StoreSnapshot = {
  activeId?: string;
  buffers: Array<{
    id: string;
    kind: FilesBuffer["kind"];
    path?: string;
    title: string;
    dirty: boolean;
    loadState?: string;
    loadError?: string;
    textLength?: number;
    savedTextLength?: number;
    diskVersion?: string;
    head?: string;
    tail?: string;
  }>;
  saveEvents: SaveEvent[];
  logs: unknown[];
  toasts: string[];
};

export type EditorSnapshot = {
  lineNumber: number;
  column: number;
  lineCount: number;
  languageId: string;
  eol: string;
};

export type DraftRecordProbe = { id: string; textLength?: number; tail?: string };

export type FullTextProbe = {
  mount: (options?: { mode?: MountMode }) => void;
  clearStorage: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  snapshot: () => StoreSnapshot;
  editorSnapshot: () => EditorSnapshot | undefined;
  goToLine: (line: number, column?: number) => void;
  monacoInfo: (tokens: string[], lines?: number[]) => Promise<MonacoInfo | undefined>;
  focusEditor: () => Promise<boolean>;
  bufferTokens: (tokens: string[]) => TokenProbe[] | undefined;
  saveActive: () => Promise<{ ok: boolean; events: SaveEvent[] }>;
  persistNow: () => void;
  sessionInfo: () => unknown;
  draftRecords: () => Promise<DraftRecordProbe[]>;
};

declare global {
  interface Window {
    __fullTextE2E?: Partial<FullTextProbe> & {
      saveEvents?: SaveEvent[];
      logs?: unknown[];
      toasts?: string[];
    };
  }
}

export function tokenProbe(text: string, token: string): TokenProbe {
  return { token, index: text.indexOf(token), count: text.split(token).length - 1 };
}

export function readSessionInfo(): unknown {
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      openFileIds?: string[];
      drafts?: Array<{ id?: string; text?: string; savedText?: string }>;
    };
    return {
      rawLength: raw.length,
      openFileIds: parsed.openFileIds ?? [],
      drafts: (parsed.drafts ?? []).map((draft) => ({
        id: draft.id,
        textLength: draft.text?.length ?? 0,
        savedTextLength: draft.savedText?.length ?? 0,
      })),
    };
  } catch {
    return { rawLength: raw.length, invalid: true };
  }
}

/**
 * 读取生产适配器写入的 v2 记录。
 *
 * v2 主键是 storageKey；bufferId 只用于关联标签。这里用生产导出的 DB / store /
 * version 常量打开同一数据库，避免夹具硬编码持久化契约。
 */
export function readDraftRecords(): Promise<DraftRecordProbe[]> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve([]);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(FILES_TEXT_DRAFT_DB_NAME, FILES_TEXT_DRAFT_DB_VERSION);
    } catch {
      resolve([]);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILES_TEXT_DRAFT_STORE_NAME)) {
        database.createObjectStore(FILES_TEXT_DRAFT_STORE_NAME, { keyPath: "storageKey" });
      }
    };
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILES_TEXT_DRAFT_STORE_NAME)) {
        database.close();
        resolve([]);
        return;
      }
      const transaction = database.transaction(FILES_TEXT_DRAFT_STORE_NAME, "readonly");
      const getAll = transaction.objectStore(FILES_TEXT_DRAFT_STORE_NAME).getAll();
      getAll.onsuccess = () => {
        database.close();
        resolve(
          (
            getAll.result as Array<{ bufferId?: unknown; storageKey?: unknown; text?: unknown }>
          ).map((record) => ({
            id: String(record.bufferId ?? record.storageKey),
            textLength: typeof record.text === "string" ? record.text.length : undefined,
            tail: typeof record.text === "string" ? record.text.slice(-160) : undefined,
          })),
        );
      };
      getAll.onerror = () => {
        database.close();
        resolve([]);
      };
    };
  });
}
