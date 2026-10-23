import { getContainingDirectoryPath } from "@/lib/path.js";
import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";
import type {
  WorkspaceFileMutation,
  WorkspaceFileMutationResult,
} from "@/workspace-file-tree/workspaceFileActionRunner.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * 从同一份展开快照计划路径迁移和重读目标，避免 setState 后的旧刷新闭包仍读取旧目录。
 * 只返回新目录读取计划；调用方同步发起读取，让既有树 owner 捕获原工作区 generation。
 */
export function planWorkspaceFileTreeMutation({
  workspacePath,
  expandedPaths,
  result,
  mutation,
}: {
  workspacePath: string;
  expandedPaths: ReadonlySet<string>;
  result: WorkspaceFileMutationResult;
  mutation: WorkspaceFileMutation;
}): { expandedPaths: Set<string>; reloadPaths: string[] } {
  if (!result.changed) return { expandedPaths: new Set(expandedPaths), reloadPaths: [] };
  const relocates = mutation.kind === "rename" || mutation.kind === "move";
  const sourcePath =
    relocates || mutation.kind === "delete" ? (result.previousPath ?? mutation.path) : undefined;
  const nextExpandedPaths = new Set<string>();
  const movedExpandedPaths: string[] = [];
  for (const path of expandedPaths) {
    if (!sourcePath || !isWorkspaceFilePathInside(sourcePath, path)) {
      nextExpandedPaths.add(path);
      continue;
    }
    if (relocates) {
      const suffix = normalizePath(path).slice(normalizePath(sourcePath).length);
      const target = result.path.replace(/[\\/]+$/, "");
      const migrated = `${target}${target.includes("\\") ? suffix.replaceAll("/", "\\") : suffix}`;
      nextExpandedPaths.add(migrated);
      movedExpandedPaths.push(migrated);
    }
  }

  const reloadPaths: string[] = [];
  const seen = new Set<string>();
  const addReloadPath = (path: string | null) => {
    if (!path || !isWorkspaceFilePathInside(workspacePath, path)) return;
    const key = normalizePath(path);
    if (seen.has(key)) return;
    seen.add(key);
    reloadPaths.push(path);
  };
  const parent = getContainingDirectoryPath(result.path) ?? workspacePath;
  if (sourcePath) addReloadPath(getContainingDirectoryPath(sourcePath));
  addReloadPath(parent);
  if (mutation.kind !== "delete" && isWorkspaceFilePathInside(workspacePath, parent)) {
    nextExpandedPaths.add(parent);
  }
  // 隐藏的展开后代也要预读：它们不会因为父目录一次 readdir 自动拥有新路径的 children 缓存。
  for (const path of movedExpandedPaths) addReloadPath(path);
  return { expandedPaths: nextExpandedPaths, reloadPaths };
}
