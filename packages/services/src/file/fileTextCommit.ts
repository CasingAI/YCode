/* eslint-disable max-lines */
import type { BigIntStats } from "node:fs";
import { promises as fsPromises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FILE_TEXT_COMMIT_CONFLICT_CODE,
  FILE_TEXT_INVALID_PATCH_CODE,
  FILE_TEXT_NOT_FILE_CODE,
  type CommitTextFileParams,
  type CommitTextFileResult,
  type FileTextCommitErrorCode,
  type FileTextPatch,
} from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import { atomicWriteTextFile } from "./atomicWriteTextFile.js";
import { findValidUtf8CodePointStart, statVersion } from "./fileTextWindow.js";

/** 补丁复制按 256 KiB 有界推进，不把整份源文件读入内存。 */
const COPY_CHUNK_BYTES = 256 * 1024;
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
/** UTF-8 单码点最多 4 字节；边界校验只需看前后 3 / 4 字节。 */
const UTF8_MAX_BYTES = 4;

export class FileTextCommitError extends Error {
  readonly code: FileTextCommitErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: FileTextCommitErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FileTextCommitError";
    this.code = code;
    this.details = details;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isEnoent(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function conflict(path: string, reason: string): FileTextCommitError {
  return new FileTextCommitError(
    FILE_TEXT_COMMIT_CONFLICT_CODE,
    `Text commit conflict: ${path} (${reason})`,
    { reason },
  );
}

function invalidPatch(reason: string, detail?: Record<string, unknown>): FileTextCommitError {
  return new FileTextCommitError(
    FILE_TEXT_INVALID_PATCH_CODE,
    `Invalid text commit patch: ${reason}`,
    { reason, ...detail },
  );
}

function notFile(path: string, role: "source" | "target"): FileTextCommitError {
  return new FileTextCommitError(
    FILE_TEXT_NOT_FILE_CODE,
    `Text commit ${role} is not a regular file: ${path}`,
    { role },
  );
}

function assertWellFormedText(text: unknown, reason: string): asserts text is string {
  if (typeof text !== "string" || !text.isWellFormed()) {
    throw invalidPatch(reason);
  }
}

/**
 * 目标 canonical 路径：已存在文件（含符号链接）用 realpath 跟随到真实文件；
 * 新目标用 realpath(parent) + basename。父目录不存在时透传 ENOENT，按普通保存失败处理。
 */
export async function canonicalizeTextTargetPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  const parent = await realpath(dirname(absolutePath));
  return join(parent, basename(absolutePath));
}

async function renameWithRetry(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Windows 等平台不允许以目录句柄 fsync；提交已由 temp fsync + rename/link 保证。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) {
      throw new Error("Failed to write text commit temp file.");
    }
    offset += bytesWritten;
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead <= 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function assertCapturedPath(
  path: string,
  capturedCanonicalPath: string,
  allowMissingTarget: boolean,
): Promise<void> {
  let currentCanonicalPath: string;
  try {
    currentCanonicalPath = await canonicalizeTextTargetPath(path);
  } catch (error) {
    if (allowMissingTarget && isEnoent(error)) {
      const absolutePath = resolve(path);
      const currentParent = await realpath(dirname(absolutePath)).catch((parentError: unknown) => {
        if (isEnoent(parentError)) throw conflict(path, "path-changed");
        throw parentError;
      });
      currentCanonicalPath = join(currentParent, basename(absolutePath));
    } else if (isEnoent(error)) {
      throw conflict(path, "path-changed");
    } else {
      throw error;
    }
  }
  if (!sameCanonicalPath(currentCanonicalPath, capturedCanonicalPath)) {
    throw conflict(path, "path-changed");
  }
}

async function assertCapturedPaths(
  params: CommitTextFileParams,
  canonicalTarget: string,
  capturedCanonicalSource: string | undefined,
  effectiveCanonicalSource: string | undefined,
  allowMissingTarget: boolean,
): Promise<void> {
  await assertCapturedPath(params.path, canonicalTarget, allowMissingTarget);
  if (params.sourcePath !== undefined && capturedCanonicalSource !== undefined) {
    await assertCapturedPath(params.sourcePath, capturedCanonicalSource, false);
    if (effectiveCanonicalSource === undefined) {
      const currentTarget = await canonicalizeTextTargetPath(params.path);
      if (!sameCanonicalPath(currentTarget, capturedCanonicalSource)) {
        throw conflict(params.path, "path-changed");
      }
    }
  }
}

type CommitFileIdentity = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs">;

function commitIdentityMatches(expected: CommitFileIdentity, actual: BigIntStats): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function readFinalStatsForCommit(
  canonicalTarget: string,
  committedIdentity: CommitFileIdentity,
): Promise<BigIntStats> {
  let finalStats: BigIntStats;
  try {
    finalStats = await fsPromises.stat(canonicalTarget, { bigint: true });
  } catch (error) {
    if (isEnoent(error)) throw conflict(canonicalTarget, "target-changed-after-commit");
    throw error;
  }
  if (!finalStats.isFile() || !commitIdentityMatches(committedIdentity, finalStats)) {
    throw conflict(canonicalTarget, "target-changed-after-commit");
  }
  return finalStats;
}

type TargetState =
  | { kind: "missing" }
  | { kind: "existing"; stats: BigIntStats }
  | { kind: "not-file" };

async function inspectTarget(path: string): Promise<TargetState> {
  try {
    const stats = await stat(path, { bigint: true });
    return stats.isFile() ? { kind: "existing", stats } : { kind: "not-file" };
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    // stat 跟随符号链接；ENOENT 但 lstat 仍能看到条目说明是悬空链接，不能按不存在创建。
    const entry = await lstatIfExists(path);
    return entry === undefined ? { kind: "missing" } : { kind: "not-file" };
  }
}

/**
 * 补丁边界是否切入合法 UTF-8 码点。非法 continuation 串返回 false：
 * 规范允许按确定的非法字节边界替换或保留，不因未修改区域的坏字节拒绝全部补丁。
 */
async function isInsideValidUtf8CodePoint(
  handle: FileHandle,
  position: number,
  totalBytes: number,
): Promise<boolean> {
  if (position <= 0 || position >= totalBytes) {
    return false;
  }
  const start = Math.max(0, position - (UTF8_MAX_BYTES - 1));
  const end = Math.min(totalBytes, position + UTF8_MAX_BYTES);
  const buffer = await readAt(handle, start, end - start);
  return findValidUtf8CodePointStart(buffer, position - start) !== undefined;
}

function validatePatchStructure(patches: unknown, sourceTotalBytes: number): FileTextPatch[] {
  if (!Array.isArray(patches)) {
    throw invalidPatch("patches-must-be-array");
  }
  const normalized: FileTextPatch[] = [];
  for (const [index, patch] of patches.entries()) {
    if (typeof patch !== "object" || patch === null) {
      throw invalidPatch("patch-not-object", { index });
    }
    const { offset, deleteBytes, text } = patch as {
      offset?: unknown;
      deleteBytes?: unknown;
      text?: unknown;
    };
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
      throw invalidPatch("invalid-offset", { index });
    }
    if (!Number.isSafeInteger(deleteBytes) || (deleteBytes as number) < 0) {
      throw invalidPatch("invalid-delete-bytes", { index });
    }
    const safeOffset = offset as number;
    const safeDeleteBytes = deleteBytes as number;
    if (safeOffset > sourceTotalBytes || safeDeleteBytes > sourceTotalBytes - safeOffset) {
      throw invalidPatch("patch-out-of-bounds", {
        index,
        offset: safeOffset,
        deleteBytes: safeDeleteBytes,
        sourceTotalBytes,
      });
    }
    assertWellFormedText(text, "invalid-text");
    normalized.push({ offset: safeOffset, deleteBytes: safeDeleteBytes, text });
  }

  normalized.sort((left, right) => left.offset - right.offset);
  let previous: FileTextPatch | undefined;
  for (const patch of normalized) {
    if (previous !== undefined) {
      if (patch.offset === previous.offset) {
        // 同一偏移的多个零长度补丁语义不明确；非零区间也会重叠，统一拒绝。
        throw invalidPatch("duplicate-offset", { offset: patch.offset });
      }
      if (patch.offset < previous.offset + previous.deleteBytes) {
        throw invalidPatch("patch-overlap", { offset: patch.offset });
      }
    }
    previous = patch;
  }
  return normalized;
}

async function copySourceRange(
  source: FileHandle,
  target: FileHandle,
  start: number,
  end: number,
  buffer: Buffer,
): Promise<void> {
  let position = start;
  while (position < end) {
    const size = Math.min(buffer.length, end - position);
    const { bytesRead } = await source.read(buffer, 0, size, position);
    if (bytesRead <= 0) {
      throw new Error("Source file ended while copying text commit patches.");
    }
    await writeAll(target, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function writePatches(
  source: FileHandle,
  target: FileHandle,
  sourceTotalBytes: number,
  patches: readonly FileTextPatch[],
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(sourceTotalBytes, 1)));
  let cursor = 0;
  for (const patch of patches) {
    await copySourceRange(source, target, cursor, patch.offset, buffer);
    const textBytes = Buffer.from(patch.text, "utf8");
    await writeAll(target, textBytes);
    cursor = patch.offset + patch.deleteBytes;
  }
  await copySourceRange(source, target, cursor, sourceTotalBytes, buffer);
}

function validateCommitShape(params: CommitTextFileParams): void {
  if (typeof params.path !== "string" || params.path.trim().length === 0) {
    throw invalidPatch("invalid-path");
  }
  if (params.expectedVersion !== null && typeof params.expectedVersion !== "string") {
    throw invalidPatch("invalid-expected-version");
  }
  if (
    params.expectedTargetVersion !== undefined &&
    params.expectedTargetVersion !== null &&
    typeof params.expectedTargetVersion !== "string"
  ) {
    throw invalidPatch("invalid-expected-target-version");
  }
  if (params.sourcePath !== undefined) {
    if (typeof params.sourcePath !== "string" || params.sourcePath.trim().length === 0) {
      throw invalidPatch("invalid-source-path");
    }
    // 另存为必须有已存在的源版本；源不存在不能靠 expectedVersion: null 表达。
    if (params.expectedVersion === null) {
      throw invalidPatch("source-requires-version");
    }
  } else if (params.expectedTargetVersion !== undefined) {
    throw invalidPatch("unexpected-target-version");
  }

  if (typeof params.write !== "object" || params.write === null) {
    throw invalidPatch("invalid-write");
  }
  if (params.write.kind === "full") {
    assertWellFormedText(params.write.text, "invalid-text");
    return;
  }
  if (params.write.kind === "patches") {
    if (params.expectedVersion === null) {
      throw invalidPatch("patches-require-existing-source");
    }
    return;
  }
  throw invalidPatch("unknown-write-kind");
}

async function withSortedFileLocks<T>(
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const uniquePaths = [...new Set(paths)].sort();
  const acquire = (index: number): Promise<T> => {
    if (index >= uniquePaths.length) {
      return operation();
    }
    return withFileLock(uniquePaths[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

async function executeCommit(
  params: CommitTextFileParams,
  canonicalTarget: string,
  canonicalSource: string | undefined,
  capturedCanonicalSource: string | undefined,
): Promise<CommitTextFileResult> {
  const expectedSourceVersion = params.expectedVersion;
  const expectedTargetVersion =
    canonicalSource === undefined ? params.expectedVersion : (params.expectedTargetVersion ?? null);

  const targetState = await inspectTarget(canonicalTarget);
  if (targetState.kind === "not-file") {
    throw notFile(canonicalTarget, "target");
  }
  if (expectedTargetVersion === null) {
    if (targetState.kind !== "missing") {
      throw conflict(canonicalTarget, "target-exists");
    }
  } else {
    if (targetState.kind === "missing") {
      throw conflict(canonicalTarget, "target-missing");
    }
    if (statVersion(targetState.stats) !== expectedTargetVersion) {
      throw conflict(canonicalTarget, "target-version-mismatch");
    }
  }

  let sourceStats: BigIntStats | undefined;
  if (canonicalSource !== undefined) {
    sourceStats = await stat(canonicalSource, { bigint: true }).catch((error: unknown) => {
      if (isEnoent(error)) {
        throw conflict(canonicalSource, "source-missing");
      }
      throw error;
    });
    if (!sourceStats.isFile()) {
      throw notFile(canonicalSource, "source");
    }
    if (statVersion(sourceStats) !== expectedSourceVersion) {
      throw conflict(canonicalSource, "source-version-mismatch");
    }
  } else if (params.write.kind === "patches") {
    if (targetState.kind !== "existing") {
      throw conflict(canonicalTarget, "source-missing");
    }
    sourceStats = targetState.stats;
  }

  const sourceContentPath = canonicalSource ?? canonicalTarget;
  const mode = targetState.kind === "existing" ? Number(targetState.stats.mode & 0o7777n) : 0o644;
  const directory = dirname(canonicalTarget);
  const tempPath = join(
    directory,
    `.${basename(canonicalTarget)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  let sourceHandle: FileHandle | undefined;
  let tempHandle: FileHandle | undefined;
  let committed = false;
  let committedIdentity: CommitFileIdentity | undefined;
  try {
    await assertCapturedPaths(
      params,
      canonicalTarget,
      capturedCanonicalSource,
      canonicalSource,
      expectedTargetVersion === null,
    );
    tempHandle = await open(tempPath, "wx", mode);
    if (params.write.kind === "full") {
      await writeAll(tempHandle, Buffer.from(params.write.text, "utf8"));
    } else {
      if (expectedSourceVersion === null || sourceStats === undefined) {
        throw invalidPatch("patches-require-existing-source");
      }
      const sourceTotalBytes = Number(sourceStats.size);
      if (!Number.isSafeInteger(sourceTotalBytes) || sourceTotalBytes < 0) {
        throw invalidPatch("source-size-not-safe");
      }
      const patches = validatePatchStructure(params.write.patches, sourceTotalBytes);

      sourceHandle = await open(sourceContentPath, "r");
      const handleStats = await sourceHandle.stat({ bigint: true });
      if (!handleStats.isFile()) {
        throw notFile(sourceContentPath, "source");
      }
      if (statVersion(handleStats) !== expectedSourceVersion) {
        throw conflict(sourceContentPath, "source-changed");
      }
      for (const patch of patches) {
        for (const boundary of [patch.offset, patch.offset + patch.deleteBytes]) {
          if (await isInsideValidUtf8CodePoint(sourceHandle, boundary, sourceTotalBytes)) {
            throw invalidPatch("patch-boundary-inside-codepoint", {
              offset: patch.offset,
              boundary,
            });
          }
        }
      }
      await writePatches(sourceHandle, tempHandle, sourceTotalBytes, patches);
    }

    // open(mode) 会受 POSIX umask 影响；写完后 chmod 才能保留目标权限位。
    await tempHandle.chmod(mode);
    await tempHandle.sync();
    const tempStats = await tempHandle.stat({ bigint: true });
    committedIdentity = {
      dev: tempStats.dev,
      ino: tempStats.ino,
      size: tempStats.size,
      mtimeNs: tempStats.mtimeNs,
    };
    await tempHandle.close();
    tempHandle = undefined;

    // pre-commit：复核原始用户路径仍解析到锁住的对象，再复核源 / 目标版本与存在性。
    await assertCapturedPaths(
      params,
      canonicalTarget,
      capturedCanonicalSource,
      canonicalSource,
      expectedTargetVersion === null,
    );
    // pre-commit：复核源 / 目标版本与存在性，避免把旧版本内容 rename 到新目标上。
    if (canonicalSource !== undefined) {
      const sourceAfter = await stat(canonicalSource, { bigint: true }).catch((error: unknown) => {
        if (isEnoent(error)) {
          throw conflict(canonicalSource, "source-changed");
        }
        throw error;
      });
      if (!sourceAfter.isFile() || statVersion(sourceAfter) !== expectedSourceVersion) {
        throw conflict(canonicalSource, "source-changed");
      }
    }
    if (sourceHandle !== undefined) {
      const handleAfter = await sourceHandle.stat({ bigint: true }).catch(() => undefined);
      if (handleAfter === undefined || statVersion(handleAfter) !== expectedSourceVersion) {
        throw conflict(sourceContentPath, "source-changed");
      }
      await sourceHandle.close();
      sourceHandle = undefined;
    }
    if (expectedTargetVersion === null) {
      const targetEntry = await lstatIfExists(canonicalTarget);
      if (targetEntry !== undefined) {
        throw conflict(canonicalTarget, "target-exists");
      }
    } else {
      const targetAfter = await stat(canonicalTarget, { bigint: true }).catch((error: unknown) => {
        if (isEnoent(error)) {
          throw conflict(canonicalTarget, "target-changed");
        }
        throw error;
      });
      if (!targetAfter.isFile() || statVersion(targetAfter) !== expectedTargetVersion) {
        throw conflict(canonicalTarget, "target-changed");
      }
    }

    if (expectedTargetVersion === null) {
      try {
        await link(tempPath, canonicalTarget);
      } catch (error) {
        if (isEexist(error)) {
          throw conflict(canonicalTarget, "target-exists");
        }
        // 平台 / 文件系统不支持 hard link 时直接失败，不降级为 check 后 rename。
        throw error;
      }
      committed = true;
      await rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await renameWithRetry(tempPath, canonicalTarget);
      committed = true;
    }
    await fsyncDirectoryBestEffort(directory);

    if (committedIdentity === undefined) {
      throw new Error("Committed text temp identity was not captured.");
    }
    const finalStats = await readFinalStatsForCommit(canonicalTarget, committedIdentity);
    return {
      path: params.path,
      version: statVersion(finalStats),
      totalBytes: Number(finalStats.size),
    };
  } finally {
    await tempHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * 带版本保护的文本提交。
 *
 * 锁覆盖 canonical 目标（另存为时同时锁源），锁后与提交前复核用户路径身份；临时文件
 * 写入、应用 mode、fsync 并记录 identity 后，复核源 / 目标版本，再 rename（已存在目标）
 * 或 link（null 新建）。提交后校验目标仍是该临时文件且 size/mtime 未变；外部程序不参与
 * 合作锁，最终检查与提交间仍存在极窄竞态，不宣称绝对 CAS。
 */
export async function commitTextFile(params: CommitTextFileParams): Promise<CommitTextFileResult> {
  validateCommitShape(params);
  const canonicalTarget = await canonicalizeTextTargetPath(params.path);
  const capturedCanonicalSource =
    params.sourcePath === undefined
      ? undefined
      : await realpath(resolve(params.sourcePath)).catch(async (error: unknown) => {
          if (isEnoent(error)) {
            // 源路径本身是悬空链接时条目仍存在，按非普通文件处理；真正删除才是冲突。
            const entry = await lstatIfExists(resolve(params.sourcePath!));
            if (entry !== undefined) {
              throw notFile(params.sourcePath!, "source");
            }
            throw conflict(params.sourcePath!, "source-missing");
          }
          throw error;
        });
  let canonicalSource = capturedCanonicalSource;
  if (
    capturedCanonicalSource !== undefined &&
    sameCanonicalPath(capturedCanonicalSource, canonicalTarget)
  ) {
    // 同一 canonical 文件按普通保存处理；expectedVersion 已描述目标。
    canonicalSource = undefined;
  }
  const lockPaths =
    canonicalSource === undefined ? [canonicalTarget] : [canonicalTarget, canonicalSource];
  return withSortedFileLocks(lockPaths, async () => {
    await assertCapturedPaths(
      params,
      canonicalTarget,
      capturedCanonicalSource,
      canonicalSource,
      (canonicalSource === undefined
        ? params.expectedVersion
        : (params.expectedTargetVersion ?? null)) === null,
    );
    return executeCommit(params, canonicalTarget, canonicalSource, capturedCanonicalSource);
  });
}

/**
 * 旧 `writeTextFile` 的兼容实现仅供非 UI 调用方使用：共用 canonical 路径锁，
 * 但不提供版本冲突检测或保留已有文件 mode 的保障。
 */
export async function writeTextFileLocked(path: string, content: string): Promise<void> {
  const canonicalTarget = await canonicalizeTextTargetPath(path);
  await withFileLock(canonicalTarget, () => atomicWriteTextFile(canonicalTarget, content));
}
