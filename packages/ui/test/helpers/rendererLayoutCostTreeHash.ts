/**
 * 源码树哈希：给两个变体锁定「同一份共享 src 树」提供可复算证据。
 *
 * 只做文件读取与哈希，不写任何文件。键统一为相对 `packages/ui/src` 的 posix 路径，
 * 这样 prechange 白名单替换只改变 4 个键的值，其余键必须逐字节相同。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

export type FileHashes = Map<string, string>;

function posix(value: string): string {
  return value.split("\\").join("/");
}

/** 递归收集目录下所有文件的 sha256（键为 posix 相对路径）。 */
export async function collectFileHashes(rootDir: string): Promise<FileHashes> {
  const hashes: FileHashes = new Map();
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = posix(relative(rootDir, absolute));
      hashes.set(
        key,
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      );
    }
  }
  return hashes;
}

/** 对「键 → 内容哈希」排序后整体求哈希；同一输入必然得到同一结果。 */
export function hashEntries(entries: Iterable<[string, string]>): string {
  const sorted = [...entries].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  const digest = createHash("sha256");
  for (const [key, hash] of sorted) {
    digest.update(key);
    digest.update("\0");
    digest.update(hash);
    digest.update("\n");
  }
  return digest.digest("hex");
}

/** 共享树哈希：排除白名单键后的全树哈希（两个变体必须逐字节一致）。 */
export function sharedTreeSha256(files: FileHashes, excludedKeys: readonly string[]): string {
  const excluded = new Set(excludedKeys);
  return hashEntries([...files].filter(([key]) => !excluded.has(key)));
}

/** 在共享树之上覆盖指定键的哈希，得到某个变体的「整体源码树」指纹。 */
export function applyKeyOverrides(
  files: FileHashes,
  overrides: Record<string, string>,
  relativeRoot: string,
): FileHashes {
  const next = new Map(files);
  for (const [key, hash] of Object.entries(overrides)) {
    const relativeKey = posix(relative(relativeRoot, key));
    next.set(relativeKey, hash);
  }
  return next;
}

export function toPosixRelative(rootDir: string, absolute: string): string {
  return posix(relative(rootDir, absolute));
}
