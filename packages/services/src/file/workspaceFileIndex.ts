import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { WorkspaceFileListOptions, WorkspaceFileListPurpose } from "./file.js";
import type { WorkspaceFileSearchFilter } from "./workspaceFileMentionFilter.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
} from "./workspaceFileIgnore.js";

/**
 * workspace 文件索引扫描与缓存键工具。
 *
 * 旧用途（文件引用 / 快速打开）与 file-browser 用途共用一次 DFS，但过滤语义不同：
 * - 旧用途继续叠加注入的 WorkspaceFileSearchFilter（.env、编译产物、隐藏目录条目）；
 * - file-browser 只受 .zcodeignore 约束，收录隐藏条目、二进制产物与 .zcodeignore 自身；
 * - includeIgnored（仅 file-browser）完全跳过规则加载，不创建也不改写 .zcodeignore。
 * 目录符号链接始终作为条目收进索引，但不递归，避免越界与循环。
 */

type WorkspaceFileIgnoreRules = Awaited<ReturnType<typeof loadWorkspaceFileSearchIgnoreRules>>;

const WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8;

/**
 * 缓存键必须按 身份 + 用途 + 是否跳过忽略规则 隔离。
 * 身份 key 统一为 workspaceIdentity?.trim() || workspacePath。
 */
export function createWorkspaceFileIndexCacheKey(
  rootPath: string,
  options: Pick<WorkspaceFileListOptions, "workspaceIdentity" | "purpose" | "includeIgnored">,
): string {
  const identityKey = options.workspaceIdentity?.trim() || rootPath;
  const purposeKey = options.purpose ?? "file-reference";
  const ignoreKey = options.includeIgnored === true ? "include-ignored" : "filtered";
  return `${identityKey}\u0000${purposeKey}\u0000${ignoreKey}`;
}

/**
 * .zcodeignore 的 mtime/size 指纹；includeIgnored 不使用规则，
 * 因此外部改写 .zcodeignore 不应让该模式的缓存失效重扫。
 */
export async function statWorkspaceFileIndexIgnoreFingerprint(
  rootPath: string,
  includeIgnored: boolean,
): Promise<string> {
  if (includeIgnored) {
    return "ignored";
  }
  try {
    const fileStat = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    return `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "none";
  }
}

export interface ScanWorkspaceFileIndexOptions {
  rootPath: string;
  purpose?: WorkspaceFileListPurpose;
  includeIgnored?: boolean;
  filter: WorkspaceFileSearchFilter;
  /** includeIgnored 时为 null：不加载规则，也不会触发 .zcodeignore 自动创建。 */
  ignoreRules: WorkspaceFileIgnoreRules | null;
}

function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join("/");
}

function isSkippableWorkspaceFileListError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

export async function resolveReaddirEntryType(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<WorkspaceFileEntry["type"]> {
  if (isDirectory) {
    return "directory";
  }
  if (!isSymbolicLink) {
    return "file";
  }
  try {
    const targetStat = await stat(entryPath);
    // Node 的 Dirent 对软链接目录只返回 isSymbolicLink，不会返回 isDirectory。
    // 目录选择器只展示 directory 类型，远程 SSH 选目录时因此看不到指向目录的软链接；这里跟随目标重新分类。
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

/**
 * 扫描并打包 workspace 文件索引（列式字符串）。调用方负责缓存与并发控制；
 * 本函数只描述一次完整 DFS 的结果，不读取或写入任何缓存。
 */
export async function scanWorkspaceFileIndex(
  options: ScanWorkspaceFileIndexOptions,
): Promise<string> {
  const { rootPath, purpose, filter, ignoreRules } = options;
  const includeIgnored = purpose === "file-browser" && options.includeIgnored === true;
  const entries: WorkspaceFileEntry[] = [];
  const pendingDirectories: string[] = [rootPath];
  // 单线程串行 DFS 一次只 await 一个 readdir，
  // 37 万文件的 Windows workspace 实测 21.8s；改为共享目录队列的受限并发遍历，
  // 结果仍按既有规则排序，遍历顺序不影响语义。
  const traverseWorker = async (): Promise<void> => {
    for (;;) {
      const currentPath = pendingDirectories.pop();
      if (!currentPath) {
        return;
      }
      let children: Dirent[];
      try {
        children = await readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        if (isSkippableWorkspaceFileListError(error)) {
          continue;
        }
        throw error;
      }
      for (const entry of children) {
        const entryPath = join(currentPath, entry.name);
        const relativePath = normalizeRelativePath(rootPath, entryPath);
        const isIgnoreRuleFile = relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME;
        const type = await resolveReaddirEntryType(
          entryPath,
          entry.isDirectory(),
          entry.isSymbolicLink(),
        );

        if (purpose === "file-browser") {
          // 浏览器用途不走文件引用过滤器：.env、编译产物与隐藏目录条目都应可搜索。
          // 默认仍遵循 .zcodeignore；规则文件自身始终作为条目保留（不被自身规则误伤）。
          if (
            !includeIgnored &&
            !isIgnoreRuleFile &&
            ignoreRules &&
            isWorkspaceFileSearchPathIgnored(ignoreRules, relativePath, type)
          ) {
            continue;
          }
          entries.push({ name: entry.name, path: entryPath, relativePath, type });
          // 目录符号链接只作为条目，不递归，避免越界遍历与循环。
          if (type === "directory" && !entry.isSymbolicLink()) {
            pendingDirectories.push(entryPath);
          }
          continue;
        }

        // 旧用途保持既有语义：规则文件不出现在索引，硬过滤器继续支配候选与剪枝。
        if (isIgnoreRuleFile) {
          continue;
        }
        if (ignoreRules && isWorkspaceFileSearchPathIgnored(ignoreRules, relativePath, type)) {
          continue;
        }
        const decision = filter.evaluate(
          { name: entry.name, path: entryPath, relativePath, type },
          { ignoreRulesActive: true },
        );
        if (decision.include) {
          entries.push({ name: entry.name, path: entryPath, relativePath, type });
        }
        if (type === "directory" && !entry.isSymbolicLink() && decision.traverse) {
          pendingDirectories.push(entryPath);
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: WORKSPACE_FILE_LIST_SCAN_CONCURRENCY }, () => traverseWorker()),
  );
  const sorted = entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });
  return packWorkspaceFileEntries(sorted);
}
