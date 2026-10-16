/**
 * 清理计划：给定类别与候选文件列表，决定哪些能删。纯函数，删除动作由 adapters 执行。
 */
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId, StorageCleanAgeRange } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** 子代理产物：会话目录 24 小时内有更新就整个跳过，避免删掉进行中 subagent 的 transcript。 */
const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 按会话目录判活性的类别：命令完整输出复用子代理这套规则。 */
const SESSION_DIR_ACTIVE_CATEGORIES: ReadonlySet<StorageCategoryId> = new Set([
  "subagentTranscripts",
  "commandOutputs",
]);

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
  /** all 跳过时间及近期活动保护；缺省保持旧调用的保护规则。 */
  ageRange?: StorageCleanAgeRange;
  /** 旧调用兼容：只删 now - mtime >= olderThanMs。 */
  olderThanMs?: number;
  /** 只删命中任一 entryKey 前缀的候选（沙盒按会话清用）；缺省不过滤。 */
  entryKeys?: string[];
}): StorageCleanPlan {
  const { categoryId, candidates, context, now, ageRange, olderThanMs, entryKeys } = params;
  const threshold =
    ageRange === "all"
      ? null
      : ageRange === "24hours"
        ? 24 * 60 * 60 * 1000
        : ageRange === "7days"
          ? 7 * 24 * 60 * 60 * 1000
          : ageRange === "30days"
            ? 30 * 24 * 60 * 60 * 1000
            : olderThanMs ?? 0;
  const protectRecentActivity = ageRange === undefined || ageRange !== "all";
  const protectTodayLogs = ageRange !== "all";
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // 候选来自按前缀枚举，可能混入其他类别（如 cli/plugins 下的 cache）；只保留分类一致且未受保护的。
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath) &&
      (entryKeys === undefined ||
        entryKeys.length === 0 ||
        entryKeys.some((key) => isUnderEntryKey(candidate.relativePath, key))),
  );
  let targets = owned;
  if (ageRange !== "all") {
    if (categoryId === "logs" && protectTodayLogs) {
      targets = targets.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
    }
    if (SESSION_DIR_ACTIVE_CATEGORIES.has(categoryId) && protectRecentActivity) {
      // 活动判定用完整候选列表，避免同目录其他类别的近期文件被漏掉。
      targets = filterInactiveSessionDirs(targets, candidates, now);
    }
  }
  if (threshold !== null && threshold > 0) {
    targets = targets.filter((candidate) => now - candidate.mtimeMs >= threshold);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

/** entryKey 前缀匹配：相等或 `key/` 开头（与 catalog 的 isUnderPrefix 同口径）。 */
function isUnderEntryKey(path: string, key: string): boolean {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 会话目录 = 前三段（cli/agents/sess_x）；任一文件在活动窗口内则整组跳过。 */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}
