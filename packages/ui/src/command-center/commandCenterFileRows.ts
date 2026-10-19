/**
 * 命令中心「文件」分区的匹配内核。
 *
 * 匹配复用共享模糊打分（`@zcode/shared/workspaceFileSearch`）——与 `@` 文件候选、
 * 文件树搜索同一套打分与排序语义，命令中心不维护第二份子串匹配实现。
 * 前缀命中优于子串命中，子串命中优于子序列命中，排序即打分顺序。
 */
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 文件分区结果条数上限。 */
export const COMMAND_CENTER_FILE_RESULT_LIMIT = 80;

export type CommandCenterFileCandidate = WorkspaceFileSearchCandidate;

/**
 * 工作区文件条目 → 搜索候选。归一化（小写化）在这一步做一次，
 * 键入时只做打分过滤，不为每条候选重复 toLowerCase。
 *
 * 目录不进「快速打开」：命令中心只列文件，目录导航由文件树承担。
 */
export function buildCommandCenterFileCandidates(
  entries: readonly WorkspaceFileEntry[],
): CommandCenterFileCandidate[] {
  return mapWorkspaceFileEntriesToSearchCandidates(
    entries.filter((entry) => entry.type === "file"),
  );
}

/** 按查询过滤候选并还原成文件条目。空查询返回空列表（无查询不列文件）。 */
export function filterCommandCenterFileRows(
  candidates: readonly CommandCenterFileCandidate[],
  query: string,
): WorkspaceFileEntry[] {
  return filterWorkspaceFileSearchCandidates([...candidates], query, {
    limit: COMMAND_CENTER_FILE_RESULT_LIMIT,
    requireQuery: true,
  }).map((candidate) => ({
    name: candidate.name,
    path: candidate.path,
    relativePath: candidate.relativePath,
    type: candidate.type,
  }));
}
