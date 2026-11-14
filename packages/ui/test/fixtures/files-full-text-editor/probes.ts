import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import {
  FILES_TEXT_DRAFT_BASELINE_STORE_NAME,
  FILES_TEXT_DRAFT_BODY_STORE_NAME,
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

/** 测试内公开 API / 存储写入口的调用计数；只在显式测量区间内累加。 */
export type ProbeCounters = {
  /** 完整 getValue（复制整份正文）。 */
  getValue: number;
  /** O(1) 长度读取。 */
  getValueLength: number;
  /** 有界区间读取（首行等）。 */
  getValueInRange: number;
  /** 替代版本号读取。 */
  getAlternativeVersionId: number;
  /** localStorage.setItem 调用次数。 */
  localStorageWrites: number;
  /** IndexedDB 写入（put）调用次数。 */
  indexedDbPuts: number;
};

/** 不复制正文的运行时状态，用于逐键后立即检查脏态与长度。 */
export type QuickTextState = {
  dirty: boolean;
  textLength?: number;
  savedTextLength?: number;
  diskVersion?: string;
  documentRevision?: number;
  savedDocumentVersionId?: number | null;
  textChangeEpoch?: number;
  modelVersionId?: number;
};

export type TypingMeasure = QuickTextState & {
  counters: ProbeCounters;
  /** 测量结束时刻的 localStorage 会话原始长度（只读检查，不计入写入）。 */
  localSessionRawLength: number;
};

export type KeypressMetricSummary = {
  keydowns: number;
  modelChanges: number;
  storeChanges: number;
  paired: number;
  modelMs: { p50: number; p95: number; max: number };
  storeMs: { p50: number; p95: number; max: number };
};

export type FirstLineProbe = {
  textLength: number;
  ms: number;
  lineCount: number;
  lineMaxColumn: number;
  languageId: string;
};

export type MemoryProbe = {
  available: boolean;
  source: string;
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

export type SnapshotTiming = { textLength: number; ms: number };

/** 分屏 / 同模型重建的可序列化观测：真实 editor 与 model 身份都来自 Monaco。 */
export type SplitLayoutInfo = {
  activeId?: string;
  editorCount: number;
  /** 每个真实 editor 当前挂载的 model id；共享模型时全部相同。 */
  editorModelIds: Array<string | undefined>;
  modelUris: string[];
  modelVersionIds: number[];
  groups: Array<{
    groupId: string;
    focused: boolean;
    views: Array<{ id: string; bufferId: string }>;
  }>;
  buffer?: {
    id: string;
    dirty: boolean;
    textLength: number;
    documentAttachments?: number;
    documentRevision?: number;
    savedDocumentVersionId?: number | null;
    modelVersionId?: number;
  };
};

/** v3 三 store 的只读结构；用于证明正文与基线确实分流。 */
export type DraftPartsProbe = {
  drafts: Array<{
    bufferId: string;
    storageKey: string;
    updatedAt: number;
    bodyRevision: number;
    savedRevision: number;
    hasText: boolean;
    hasSavedText: boolean;
  }>;
  bodies: Array<{ storageKey: string; revision: number; textLength: number }>;
  baselines: Array<{ storageKey: string; revision: number; textLength: number }>;
};

export type FullTextProbe = {
  mount: (options?: { mode?: MountMode }) => void;
  clearStorage: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  snapshot: () => StoreSnapshot;
  editorSnapshot: () => EditorSnapshot | undefined;
  goToLine: (line: number, column?: number) => void;
  monacoInfo: (tokens: string[], lines?: number[]) => Promise<MonacoInfo | undefined>;
  /** O(1) 模型摘要；不复制行内容，10 MiB 单行也安全。 */
  modelSummary: () => Promise<
    { valueLength: number; lineCount: number; languageId: string } | undefined
  >;
  focusEditor: () => Promise<boolean>;
  bufferTokens: (tokens: string[]) => TokenProbe[] | undefined;
  saveActive: () => Promise<{ ok: boolean; events: SaveEvent[] }>;
  persistNow: () => void;
  sessionInfo: () => unknown;
  draftRecords: () => Promise<DraftRecordProbe[]>;
  draftParts: () => Promise<DraftPartsProbe>;
  /** 给真实 Monaco 模型 / 存储入口安装公开 API 计数包装（幂等）。 */
  installModelCounters: () => Promise<boolean>;
  beginMeasure: () => void;
  /** 停止计数并返回本区间结果；不读取正文。 */
  endMeasure: () => TypingMeasure | undefined;
  /** 保持计数运行，只读取当前计数与 O(1) 状态。 */
  readMeasure: () => TypingMeasure | undefined;
  beginKeypressMetrics: () => Promise<boolean>;
  endKeypressMetrics: () => KeypressMetricSummary | undefined;
  quickState: () => QuickTextState | undefined;
  timeSnapshot: () => SnapshotTiming | undefined;
  firstLineProbe: () => Promise<FirstLineProbe | undefined>;
  memoryProbe: () => MemoryProbe;
  /** 真实 editor / model / 分屏布局与缓冲引用计数。 */
  layoutInfo: () => Promise<SplitLayoutInfo>;
  /** 走生产 splitViewToEdge，把当前 buffer 的 view 复制 / 移动到另一组。 */
  splitActiveView: (edge?: "left" | "right" | "top" | "bottom", mode?: "copy" | "move") => void;
  /** 走生产 closeGroup，卸载整组编辑器但保留缓冲。 */
  closeGroup: (groupId: string) => void;
  /** 重挂载 GroupPane 子树；Monaco model 仍由生产注册表持有。 */
  remountEditors: () => void;
  /** 场景之间释放本夹具创建的 Monaco 模型，避免旧大模型影响下一次选择。 */
  resetModels: () => Promise<void>;
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

/**
 * v3 三 store 结构探针。
 *
 * 生产适配器把元数据 / 正文 / 基线拆在 drafts、bodies、baselines 三个 store；
 * 这里用生产导出的常量打开同一数据库，只返回长度与 revision，不把 10 MiB
 * 正文复制回 Node 侧。
 */
export function readDraftParts(): Promise<DraftPartsProbe> {
  const empty: DraftPartsProbe = { drafts: [], bodies: [], baselines: [] };
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve(empty);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(FILES_TEXT_DRAFT_DB_NAME, FILES_TEXT_DRAFT_DB_VERSION);
    } catch {
      resolve(empty);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [
        FILES_TEXT_DRAFT_STORE_NAME,
        FILES_TEXT_DRAFT_BODY_STORE_NAME,
        FILES_TEXT_DRAFT_BASELINE_STORE_NAME,
      ]) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath: "storageKey" });
        }
      }
    };
    request.onerror = () => resolve(empty);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILES_TEXT_DRAFT_STORE_NAME)) {
        database.close();
        resolve(empty);
        return;
      }
      const stores = [FILES_TEXT_DRAFT_STORE_NAME];
      for (const name of [FILES_TEXT_DRAFT_BODY_STORE_NAME, FILES_TEXT_DRAFT_BASELINE_STORE_NAME]) {
        if (database.objectStoreNames.contains(name)) stores.push(name);
      }
      const transaction = database.transaction(stores, "readonly");
      const readAll = (name: string) =>
        database.objectStoreNames.contains(name)
          ? transaction.objectStore(name).getAll()
          : undefined;
      const draftsRequest = readAll(FILES_TEXT_DRAFT_STORE_NAME);
      const bodiesRequest = readAll(FILES_TEXT_DRAFT_BODY_STORE_NAME);
      const baselinesRequest = readAll(FILES_TEXT_DRAFT_BASELINE_STORE_NAME);
      let pending = 1 + (bodiesRequest ? 1 : 0) + (baselinesRequest ? 1 : 0);
      const result: DraftPartsProbe = { drafts: [], bodies: [], baselines: [] };
      const finish = () => {
        pending -= 1;
        if (pending > 0) return;
        database.close();
        resolve(result);
      };
      draftsRequest!.onsuccess = () => {
        result.drafts = (draftsRequest!.result as Array<Record<string, unknown>>).map((record) => ({
          bufferId: String(record.bufferId ?? ""),
          storageKey: String(record.storageKey ?? ""),
          updatedAt: Number(record.updatedAt ?? 0),
          bodyRevision: Number(record.bodyRevision ?? 0),
          savedRevision: Number(record.savedRevision ?? 0),
          hasText: typeof record.text === "string",
          hasSavedText: typeof record.savedText === "string",
        }));
        finish();
      };
      if (bodiesRequest) {
        bodiesRequest.onsuccess = () => {
          result.bodies = (bodiesRequest.result as Array<Record<string, unknown>>).map(
            (record) => ({
              storageKey: String(record.storageKey ?? ""),
              revision: Number(record.revision ?? 0),
              textLength: typeof record.text === "string" ? record.text.length : 0,
            }),
          );
          finish();
        };
      }
      if (baselinesRequest) {
        baselinesRequest.onsuccess = () => {
          result.baselines = (baselinesRequest.result as Array<Record<string, unknown>>).map(
            (record) => ({
              storageKey: String(record.storageKey ?? ""),
              revision: Number(record.revision ?? 0),
              textLength: typeof record.text === "string" ? record.text.length : 0,
            }),
          );
          finish();
        };
      }
      const fail = () => {
        database.close();
        resolve(empty);
      };
      draftsRequest!.onerror = fail;
      if (bodiesRequest) bodiesRequest.onerror = fail;
      if (baselinesRequest) baselinesRequest.onerror = fail;
    };
  });
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
 * 读取生产适配器写入的 v3 记录。
 *
 * v3 主键是 storageKey；bufferId 只用于关联标签，正文在 bodies store。
 * 这里用生产导出的 DB / store / version 常量打开同一数据库，避免夹具硬编码持久化契约。
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
      if (!database.objectStoreNames.contains(FILES_TEXT_DRAFT_BODY_STORE_NAME)) {
        database.createObjectStore(FILES_TEXT_DRAFT_BODY_STORE_NAME, { keyPath: "storageKey" });
      }
      // 探针可能先于生产适配器创建数据库；必须补齐 v3 的全部 store，
      // 否则生产 save 找不到 baselines store 会失败。
      if (!database.objectStoreNames.contains(FILES_TEXT_DRAFT_BASELINE_STORE_NAME)) {
        database.createObjectStore(FILES_TEXT_DRAFT_BASELINE_STORE_NAME, {
          keyPath: "storageKey",
        });
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
      const stores = [FILES_TEXT_DRAFT_STORE_NAME];
      if (database.objectStoreNames.contains(FILES_TEXT_DRAFT_BODY_STORE_NAME)) {
        stores.push(FILES_TEXT_DRAFT_BODY_STORE_NAME);
      }
      const transaction = database.transaction(stores, "readonly");
      const getAll = transaction.objectStore(FILES_TEXT_DRAFT_STORE_NAME).getAll();
      const getAllBodies = database.objectStoreNames.contains(FILES_TEXT_DRAFT_BODY_STORE_NAME)
        ? transaction.objectStore(FILES_TEXT_DRAFT_BODY_STORE_NAME).getAll()
        : undefined;
      getAll.onsuccess = () => {
        const finish = (bodies: Array<{ storageKey?: unknown; text?: unknown }>) => {
          const textByKey = new Map(
            bodies.flatMap((body) =>
              typeof body.storageKey === "string" && typeof body.text === "string"
                ? [[body.storageKey, body.text] as const]
                : [],
            ),
          );
          database.close();
          resolve(
            (
              getAll.result as Array<{
                bufferId?: unknown;
                storageKey?: unknown;
                text?: unknown;
              }>
            ).map((record) => {
              const text =
                typeof record.storageKey === "string"
                  ? (textByKey.get(record.storageKey) ?? record.text)
                  : record.text;
              return {
                id: String(record.bufferId ?? record.storageKey),
                textLength: typeof text === "string" ? text.length : undefined,
                tail: typeof text === "string" ? text.slice(-160) : undefined,
              };
            }),
          );
        };
        if (!getAllBodies) {
          finish([]);
          return;
        }
        getAllBodies.onsuccess = () =>
          finish(getAllBodies.result as Array<Record<string, unknown>>);
        getAllBodies.onerror = () => finish([]);
      };
      getAll.onerror = () => {
        database.close();
        resolve([]);
      };
    };
  });
}
