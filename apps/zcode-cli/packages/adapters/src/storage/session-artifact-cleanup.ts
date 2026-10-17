// 会话产物安全清理：只操作当前 CLI 配置存储根下精确 session 白名单路径。
// 白名单：exec/<id> 下普通文件、artifacts/<id> 下非 prompt-attachment- 普通文件、
// 模型轨迹 model-io-<id>.jsonl（debug/rollout）。任何 symlink 跳过不删。
// 边界模式仅删 mtime < before 的普通文件；归档模式删白名单全部（附件仍保护）。
// 模型轨迹边界裁剪：JSONL 逐行解析，sessionId 匹配且 completedAt 有效，早于边界的删；
// 剩余记录必须独立可 expand（首条 delta collections 能安全转为 full），否则整份跳过。
// temp+rename 原子重写，lstat 确认 regular file。preserveModelTrajectory=true 时轨迹完全不动。
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type SessionArtifactCleanupMode = "before" | "archived";

export type SessionArtifactCleanupSkippedReason =
  | "invalid_session_id"
  | "busy_or_unknown"
  | "attachment_protected"
  | "symlink_skipped"
  | "boundary_unknown"
  | "trajectory_unrewritable"
  | "full_retention"
  | "io_error";

export interface SessionArtifactCleanupInput {
  storageRoot: string;
  sessionId: string;
  mode: SessionArtifactCleanupMode;
  /** ISO timestamp；before 模式必填，archived 模式忽略。 */
  before?: string;
  preserveModelTrajectory: boolean;
  /** 轨迹默认根之外的显式 modelIoDir（create-app 传的就是它）；缺省则只看默认根。 */
  modelIoDirs?: string[];
}

export interface SessionArtifactCleanupResult {
  deletedCount: number;
  skippedCount: number;
  skippedReasons: SessionArtifactCleanupSkippedReason[];
}

const ATTACHMENT_PREFIX = "prompt-attachment-";

export function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    !sessionId.includes("\0")
  );
}

function cliRoot(storageRoot: string): string {
  const root = resolve(storageRoot);
  return basename(root) === "cli" ? root : join(root, "cli");
}

interface MutableResult {
  deletedCount: number;
  skippedCount: number;
  reasons: Set<SessionArtifactCleanupSkippedReason>;
}

function toResult(mutable: MutableResult): SessionArtifactCleanupResult {
  return {
    deletedCount: mutable.deletedCount,
    skippedCount: mutable.skippedCount,
    skippedReasons: [...mutable.reasons].sort(),
  };
}

function recordSkip(mutable: MutableResult, reason: SessionArtifactCleanupSkippedReason): void {
  mutable.skippedCount += 1;
  mutable.reasons.add(reason);
}

/** 边界模式：mtime < before 才删；mtime 不可用或 >= before 则保留。 */
function passesMtimeBoundary(mtimeMs: number, beforeMs: number | undefined): boolean {
  if (beforeMs === undefined) return false;
  return Number.isFinite(mtimeMs) && mtimeMs < beforeMs;
}

async function tryDeleteFile(path: string, mutable: MutableResult): Promise<void> {
  try {
    const info = await lstat(path);
    // 任何 symlink 跳过：不跟随、不删除目标本身。
    if (!info.isFile()) {
      recordSkip(mutable, info.isSymbolicLink() ? "symlink_skipped" : "boundary_unknown");
      return;
    }
    await unlink(path);
    mutable.deletedCount += 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    recordSkip(mutable, "io_error");
  }
}

async function cleanFlatDir(input: {
  dir: string;
  beforeMs: number | undefined;
  archived: boolean;
  mutable: MutableResult;
}): Promise<void> {
  let entries;
  try {
    entries = await readdir(input.dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    recordSkip(input.mutable, "io_error");
    return;
  }
  for (const entry of entries) {
    // 用户附件文件名 prompt-attachment- 开头：永不删除。
    if (entry.name.startsWith(ATTACHMENT_PREFIX)) {
      recordSkip(input.mutable, "attachment_protected");
      continue;
    }
    const entryPath = join(input.dir, entry.name);
    try {
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        recordSkip(input.mutable, "symlink_skipped");
        continue;
      }
      if (!info.isFile()) continue;
      if (input.archived || passesMtimeBoundary(info.mtimeMs, input.beforeMs)) {
        await tryDeleteFile(entryPath, input.mutable);
      }
    } catch {
      recordSkip(input.mutable, "io_error");
    }
  }
}

function collectionMeta(record: Record<string, unknown>): Array<{
  collection: unknown;
  countKey: string;
  kindKey: string;
  offsetKey: string;
  nestedBody: boolean;
}> {
  return [
    {
      collection: (record.request as Record<string, unknown> | undefined)?.messages,
      countKey: "messageCount",
      kindKey: "messagesKind",
      offsetKey: "messageOffset",
      nestedBody: false,
    },
    {
      collection: (record.request as Record<string, unknown> | undefined)?.sdkMessages,
      countKey: "sdkMessageCount",
      kindKey: "sdkMessagesKind",
      offsetKey: "sdkMessageOffset",
      nestedBody: false,
    },
    {
      collection: (
        (record.request as Record<string, unknown> | undefined)?.body as
          | Record<string, unknown>
          | undefined
      )?.messages,
      countKey: "bodyMessageCount",
      kindKey: "bodyMessagesKind",
      offsetKey: "bodyMessageOffset",
      nestedBody: true,
    },
  ];
}

/** 剩余首条记录的 delta collections 能否安全转为 full（offset=0、count 正确）。 */
function normalizeFirstKeptRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  const request = record.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
  const next: Record<string, unknown> = { ...record, request: { ...(request as object) } };
  const nextRequest = next.request as Record<string, unknown>;
  const nextBodyRaw = nextRequest.body;
  const nextBody =
    typeof nextBodyRaw === "object" && nextBodyRaw !== null && !Array.isArray(nextBodyRaw)
      ? { ...(nextBodyRaw as Record<string, unknown>) }
      : undefined;
  if (nextBodyRaw !== undefined && nextBody === undefined) return null;
  if (nextBody !== undefined) nextRequest.body = nextBody;

  for (const meta of collectionMeta(next)) {
    if (!Array.isArray(meta.collection)) continue;
    // 缺 kind/offset/count 元数据 → 视为完整 full（老文件无压缩标记），保留原样。
    const kind = meta.nestedBody
      ? (nextRequest as Record<string, unknown>)[meta.kindKey]
      : nextRequest[meta.kindKey];
    if (kind === undefined) continue;
    if (kind !== "delta" && kind !== "tail") continue;
    const offset = meta.nestedBody
      ? (nextRequest as Record<string, unknown>)[meta.offsetKey]
      : nextRequest[meta.offsetKey];
    const count = meta.nestedBody
      ? (nextRequest as Record<string, unknown>)[meta.countKey]
      : nextRequest[meta.countKey];
    // tail 本身不完整，无法补齐 → fail closed。
    if (kind === "tail") return null;
    // delta 转 full 要求 offset/count 都是有效数字且片段长度 = count - offset。
    if (typeof offset !== "number" || typeof count !== "number") return null;
    if (!Number.isInteger(offset) || !Number.isInteger(count)) return null;
    if (offset < 0 || count < offset) return null;
    if ((meta.collection as unknown[]).length !== count - offset) return null;
    // 安全改写首条 delta 为 full：offset=0、count 为片段长度。
    if (meta.nestedBody) {
      (nextBody as Record<string, unknown>)[meta.kindKey] = "full";
      (nextBody as Record<string, unknown>)[meta.offsetKey] = 0;
      (nextBody as Record<string, unknown>)[meta.countKey] = (meta.collection as unknown[]).length;
    } else {
      nextRequest[meta.kindKey] = "full";
      nextRequest[meta.offsetKey] = 0;
      nextRequest[meta.countKey] = (meta.collection as unknown[]).length;
    }
  }
  return next;
}

async function trimTrajectoryFile(input: {
  filePath: string;
  sessionId: string;
  beforeMs: number | undefined;
  archived: boolean;
  mutable: MutableResult;
}): Promise<void> {
  let info;
  try {
    info = await lstat(input.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    recordSkip(input.mutable, "io_error");
    return;
  }
  if (info.isSymbolicLink()) {
    recordSkip(input.mutable, "symlink_skipped");
    return;
  }
  if (!info.isFile()) return;

  if (input.archived) {
    await tryDeleteFile(input.filePath, input.mutable);
    return;
  }
  if (input.beforeMs === undefined) {
    recordSkip(input.mutable, "boundary_unknown");
    return;
  }
  // 先保存已校验边界，避免回调闭包中丢失 undefined 的类型收窄。
  const beforeMs = input.beforeMs;

  let raw: string;
  try {
    raw = await readFile(input.filePath, "utf8");
  } catch {
    recordSkip(input.mutable, "io_error");
    return;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  // 必须 JSONL 每行解析成功、含 sessionId 匹配和有效 completedAt；任一步不确定则原样保留。
  const parsed: Array<{ record: Record<string, unknown>; completedMs: number }> = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      recordSkip(input.mutable, "trajectory_unrewritable");
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      recordSkip(input.mutable, "trajectory_unrewritable");
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.sessionId !== input.sessionId) {
      recordSkip(input.mutable, "trajectory_unrewritable");
      return;
    }
    const completedMs =
      typeof record.completedAt === "string" ? Date.parse(record.completedAt) : NaN;
    if (!Number.isFinite(completedMs)) {
      recordSkip(input.mutable, "trajectory_unrewritable");
      return;
    }
    parsed.push({ record, completedMs });
  }

  const kept = parsed.filter((entry) => entry.completedMs >= beforeMs);
  if (kept.length === parsed.length) return;
  if (kept.length === 0) {
    await tryDeleteFile(input.filePath, input.mutable);
    return;
  }
  // 剩余记录要独立可 expand：首条 delta 必须能安全转为 full，否则跳过整份轨迹。
  const normalizedFirst = normalizeFirstKeptRecord(kept[0].record);
  if (!normalizedFirst) {
    recordSkip(input.mutable, "trajectory_unrewritable");
    return;
  }
  const output =
    [JSON.stringify(normalizedFirst), ...kept.slice(1).map((entry) => JSON.stringify(entry.record))].join(
      "\n",
    ) + "\n";
  try {
    const dir = dirname(input.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${input.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, output, "utf8");
    // 原子重写前复核仍是 regular file。
    const recheck = await lstat(input.filePath);
    if (!recheck.isFile() || recheck.isSymbolicLink()) {
      await unlink(tempPath).catch(() => undefined);
      recordSkip(input.mutable, "symlink_skipped");
      return;
    }
    await rename(tempPath, input.filePath);
    input.mutable.deletedCount += parsed.length - kept.length;
  } catch {
    recordSkip(input.mutable, "io_error");
  }
}

/**
 * 只对 CLI 当前配置 storage root 执行；调用方保证单根（不扫多个共享 root）。
 * modelIoDirs 为显式传入的 writer 目录（create-app 的 modelIoDir），缺省只看默认根。
 */
export async function cleanupSessionArtifacts(
  input: SessionArtifactCleanupInput,
): Promise<SessionArtifactCleanupResult> {
  const mutable: MutableResult = { deletedCount: 0, skippedCount: 0, reasons: new Set() };
  if (!isSafeSessionId(input.sessionId)) {
    recordSkip(mutable, "invalid_session_id");
    return toResult(mutable);
  }
  const root = cliRoot(input.storageRoot);
  const archived = input.mode === "archived";
  let beforeMs: number | undefined;
  if (!archived) {
    if (!input.before) {
      recordSkip(mutable, "boundary_unknown");
      return toResult(mutable);
    }
    beforeMs = Date.parse(input.before);
    if (!Number.isFinite(beforeMs)) {
      recordSkip(mutable, "boundary_unknown");
      return toResult(mutable);
    }
  }

  await cleanFlatDir({
    dir: join(root, "exec", input.sessionId),
    beforeMs,
    archived,
    mutable,
  });
  await cleanFlatDir({
    dir: join(root, "artifacts", input.sessionId),
    beforeMs,
    archived,
    mutable,
  });

  if (!input.preserveModelTrajectory) {
    const trajectoryDirs = new Set<string>([
      join(root, "debug"),
      join(root, "rollout"),
      ...(input.modelIoDirs ?? []),
    ]);
    const fileName = `model-io-${input.sessionId}.jsonl`;
    for (const dir of trajectoryDirs) {
      // 精确文件名匹配，不做前缀扫描。
      await trimTrajectoryFile({
        filePath: join(resolve(dir), fileName),
        sessionId: input.sessionId,
        beforeMs,
        archived,
        mutable,
      });
    }
  } else {
    recordSkip(mutable, "full_retention");
  }

  return toResult(mutable);
}
