/**
 * 文件工作台通配匹配：给「内置文件名模式」和「用户文件关联」共用。
 *
 * 引擎已迁到 shared（`@zcode/shared/workspaceFileSearchGlob`），此处只保留旧入口，
 * 让文件关联与通用搜索复用同一套实现，避免两份 glob 语义漂移。
 *
 * 关联语义保持原样：尾部 `/` 不启用目录后缀规则（`allowDirectorySuffix: false`），
 * 搜索用途的「目录及其内容」规则不能误扩到语言关联匹配。
 */

import {
  compileWorkspaceFileSearchGlob,
  isWorkspaceFileSearchGlobPattern,
  normalizeWorkspaceFileSearchGlobPath,
  type WorkspaceFileSearchGlobMatcher,
} from "@zcode/shared/workspaceFileSearch";

const compiledAssociationPatterns = new Map<string, WorkspaceFileSearchGlobMatcher>();

function compileAssociationGlob(pattern: string): WorkspaceFileSearchGlobMatcher | null {
  // 纯函数引擎内部也有缓存；这里额外缓存 matcher 对象，保持旧实现的热路径形态。
  const cached = compiledAssociationPatterns.get(pattern);
  if (cached) {
    return cached;
  }
  const compiled = compileWorkspaceFileSearchGlob(pattern, { allowDirectorySuffix: false });
  if (compiled) {
    compiledAssociationPatterns.set(pattern, compiled);
  }
  return compiled;
}

/** 归一化路径：统一分隔符并转小写，让匹配不受平台与大小写影响。 */
export function normalizeFilesEditorPath(path: string): string {
  return normalizeWorkspaceFileSearchGlobPath(path);
}

export function filesEditorGlobMatches(pattern: string, candidatePath: string): boolean {
  if (!pattern || !candidatePath) {
    return false;
  }
  return compileAssociationGlob(pattern)?.matches(candidatePath) ?? false;
}

/** 键里带通配符才算模式，否则按精确路径处理。 */
export function isFilesEditorGlobPattern(key: string): boolean {
  return isWorkspaceFileSearchGlobPattern(key);
}
