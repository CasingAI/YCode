import { access, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { StorageCategoryId } from "@zcode/shared";

export interface SessionStorageCategoryUsage {
  categoryId: StorageCategoryId;
  bytes: number;
  fileCount: number;
}

export interface SessionStorageUsageScan {
  totalBytes: number;
  categories: SessionStorageCategoryUsage[];
  complete: boolean;
  errorCount: number;
}

interface MutableCategoryUsage {
  bytes: number;
  fileCount: number;
}

interface ScanState {
  categories: Map<StorageCategoryId, MutableCategoryUsage>;
  complete: boolean;
  errorCount: number;
}

function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\")
  );
}

function getCategory(state: ScanState, categoryId: StorageCategoryId): MutableCategoryUsage {
  let usage = state.categories.get(categoryId);
  if (!usage) {
    usage = { bytes: 0, fileCount: 0 };
    state.categories.set(categoryId, usage);
  }
  return usage;
}

function recordFile(state: ScanState, categoryId: StorageCategoryId, size: number): void {
  const usage = getCategory(state, categoryId);
  usage.bytes += size;
  usage.fileCount += 1;
}

function recordFailure(state: ScanState, error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return;
  state.complete = false;
  state.errorCount += 1;
}

async function scanTree(
  path: string,
  categoryId: StorageCategoryId,
  state: ScanState,
  classifyAgentFile = false,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    recordFailure(state, error);
    return;
  }

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    try {
      const info = await lstat(entryPath);
      if (info.isDirectory()) {
        await scanTree(entryPath, categoryId, state, classifyAgentFile);
      } else if (info.isFile()) {
        const fileCategory =
          classifyAgentFile && entry.name === "transcript.jsonl"
            ? "subagentTranscripts"
            : categoryId;
        recordFile(state, fileCategory, info.size);
      }
      // symlink 不跟随，避免把工作区或共享目录误计入会话。
    } catch (error) {
      recordFailure(state, error);
    }
  }
}

async function scanTrajectoryFiles(
  directory: string,
  sessionIds: readonly string[],
  state: ScanState,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    recordFailure(state, error);
    return;
  }
  const fileNames = new Set(sessionIds.map((sessionId) => `model-io-${sessionId}.jsonl`));
  for (const entry of entries) {
    if (!entry.isFile() || !fileNames.has(entry.name)) continue;
    try {
      const info = await lstat(join(directory, entry.name));
      if (info.isFile()) recordFile(state, "modelTrajectory", info.size);
    } catch (error) {
      recordFailure(state, error);
    }
  }
}

function cliRoot(storageRoot: string): string {
  const root = resolve(storageRoot);
  return basename(root) === "cli" ? root : join(root, "cli");
}

/**
 * 只统计可由 session ID 精确归属的 YCode 管理路径；不扫描共享目录或 workspace。
 * stat.size 与全局 StorageService 一致，symlink 不跟随。
 */
export async function scanSessionStorageUsage(input: {
  storageRoots: readonly string[];
  sessionIds: readonly string[];
}): Promise<SessionStorageUsageScan> {
  const sessionIds = [...new Set(input.sessionIds.filter(isSafeSessionId))];
  const state: ScanState = { categories: new Map(), complete: true, errorCount: 0 };
  const roots = [...new Set(input.storageRoots.map(cliRoot))];

  for (const root of roots) {
    for (const sessionId of sessionIds) {
      await scanTree(join(root, "exec", sessionId), "commandOutputs", state);
      await scanTree(join(root, "artifacts", sessionId), "toolOutputs", state);
      await scanTree(join(root, "agents", sessionId), "toolOutputs", state, true);
      await scanTree(join(root, "sessions", sessionId), "toolOutputs", state);
      await scanTree(join(root, "sandbox", sessionId), "sandbox", state);
      for (const cacheName of ["image-cache", "pdf-cache", "video-cache"] as const) {
        // 派生媒体缓存目录按 artifact URI scheme + session ID 命名；同时兼容旧目录。
        for (const cacheSessionId of [
          sessionId,
          `zcode-artifact-${sessionId}`,
          `ycode-artifact-${sessionId}`,
        ]) {
          await scanTree(join(root, cacheName, cacheSessionId), "temporaryCaches", state);
        }
      }
    }
    await scanTrajectoryFiles(join(root, "debug"), sessionIds, state);
    await scanTrajectoryFiles(join(root, "rollout"), sessionIds, state);
  }

  const categories = [...state.categories.entries()]
    .map(([categoryId, usage]) => ({ categoryId, ...usage }))
    .filter((usage) => usage.bytes > 0 || usage.fileCount > 0)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes: categories.reduce((total, category) => total + category.bytes, 0),
    categories,
    complete: state.complete,
    errorCount: state.errorCount,
  };
}

/** 会话级 flag 位于 YCode 状态目录，不进入会话产物统计范围。 */
export async function isSessionStorageWarningDismissed(
  stateRoot: string,
  sessionId: string,
): Promise<boolean> {
  if (!isSafeSessionId(sessionId)) return false;
  const marker = join(
    cliRoot(stateRoot),
    "state",
    "storage-warning-dismissed",
    `${Buffer.from(sessionId).toString("base64url")}.marker`,
  );
  try {
    await access(marker);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function dismissSessionStorageWarning(
  stateRoot: string,
  sessionId: string,
): Promise<void> {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session ID");
  const marker = join(
    cliRoot(stateRoot),
    "state",
    "storage-warning-dismissed",
    `${Buffer.from(sessionId).toString("base64url")}.marker`,
  );
  await mkdir(dirname(marker), { recursive: true });
  try {
    await writeFile(marker, "dismissed\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
