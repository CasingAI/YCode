/**
 * 文件搜索的「路径识别」：把粘贴进来的路径和普通关键词区分开。
 *
 * 场景：用户从终端、编辑器状态栏或文件管理器复制一个路径，粘到文件搜索框里，
 * 期望系统认出「这就是那个文件的路径」并直接定位到它，而不是把它当关键词
 * 丢进模糊搜索里。
 *
 * 归一化只有一份实现（共享的 workspaceFileSearch）：去首尾空白、去掉首尾成对引号
 * （终端复制常带引号）、把反斜杠统一成正斜杠。归一化必须发生在打分与过滤之前，
 * 否则带引号或 Windows 分隔符的路径会在模糊匹配阶段就被判为「无命中」。
 */
import type { WorkspaceFileEntry } from "@zcode/shared";
import { normalizeWorkspaceFileSearchQuery } from "@zcode/shared/workspaceFileSearch";

/** 路径归一化：去空白、去引号、统一分隔符。 */
export function normalizeWorkspaceFilePathQuery(rawQuery: string): string {
  return normalizeWorkspaceFileSearchQuery(rawQuery);
}

/**
 * 在候选里找「精确路径」命中的条目。
 *
 * 命中顺序：绝对路径（entry.path）→ 相对路径（entry.relativePath）。
 * 相对路径比较忽略大小写（macOS/Windows 文件系统默认大小写不敏感）。
 * 传入的候选是已经过模糊过滤的结果（条数受限），扫描成本可以忽略。
 */
export function findExactWorkspaceFileEntry(
  entries: readonly WorkspaceFileEntry[],
  rawQuery: string,
): WorkspaceFileEntry | undefined {
  const query = normalizeWorkspaceFilePathQuery(rawQuery);
  if (!query) {
    return undefined;
  }

  const lowerQuery = query.toLowerCase();
  for (const entry of entries) {
    if (entry.path === query || normalizeWorkspaceFilePathQuery(entry.path) === query) {
      return entry;
    }
  }
  for (const entry of entries) {
    if (entry.relativePath.toLowerCase() === lowerQuery) {
      return entry;
    }
  }
  for (const entry of entries) {
    if (normalizeWorkspaceFilePathQuery(entry.relativePath).toLowerCase() === lowerQuery) {
      return entry;
    }
  }
  return undefined;
}
