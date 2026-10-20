import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 分批解码已有 packed 索引，防止把 Renderer 的长任务简单搬到共享 Host。 */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
  types?: WorkspaceFileEntry["type"][],
): Promise<WorkspaceFileEntry[]> {
  // 类型过滤放在 top-K 之前：先过滤再排序，目录不会把文件候选挤出结果。
  const scoped =
    types && types.length > 0
      ? candidates.filter((candidate) => types.includes(candidate.type))
      : candidates;
  let best: WorkspaceFileSearchCandidate[] = [];
  // top-K 的输入按原索引顺序分批；同分时原序稳定，分批合并与整表排序一致。
  for (let offset = 0; offset < scoped.length; offset += 2048) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...scoped.slice(offset, offset + 2048)],
      query,
      { limit },
    );
    await setImmediate();
  }
  return best.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
