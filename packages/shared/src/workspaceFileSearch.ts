import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  compileWorkspaceFileSearchGlob,
  normalizeWorkspaceFileSearchGlobPath,
  type WorkspaceFileSearchGlobMatcher,
} from "./workspaceFileSearchGlob.js";

export {
  compileWorkspaceFileSearchGlob,
  isWorkspaceFileSearchGlobPattern,
  normalizeWorkspaceFileSearchGlobPath,
  workspaceFileSearchGlobMatches,
  type CompileWorkspaceFileSearchGlobOptions,
  type WorkspaceFileSearchGlobMatcher,
} from "./workspaceFileSearchGlob.js";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
export const WORKSPACE_FILE_SEARCH_DISPLAY_CAP = 1000;

export interface WorkspaceFileSearchCandidate {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  type: WorkspaceFileEntry["type"];
  /**
   * 预计算的小写形式：打分热路径不再对每条候选反复 toLowerCase。
   * 放开 node_modules 后候选基数可达数十万，
   * 每键 3-4 次全串 toLowerCase 是卡顿主因之一；索引构建时一次性归一化。
   */
  lowercaseName: string;
  lowercaseRelativePath: string;
  lowercasePath: string;
}

export interface FilterWorkspaceFileSearchCandidatesOptions {
  limit?: number;
  requireQuery?: boolean;
  /**
   * 逗号分隔的包含模式原始输入（不是数组）。留空表示不额外限制。
   * 多项取并集；`*` / `**` / `?` 语义见 workspaceFileSearchGlob.ts。
   */
  include?: string;
  /** 逗号分隔的排除模式原始输入；任一命中即移除，优先级高于包含。 */
  exclude?: string;
  /**
   * 仅内部精确路径门禁（如「仅看改动」）：候选**绝对路径**的精确集合。
   *
   * 传入空数组表示允许列表为空、结果必须为空；传 undefined 表示不限制。
   * 修复：treeData.gitStatusByPath 的 key 是绝对路径，之前只与 relativePath 比较
   * 会导致「仅看改动」组合搜索全空，因此这里明确用 candidate.path 对绝对路径匹配。
   * 大小写与路径规则遵从现有 getWorkspaceFileGitStatus 的精确 key 语义：
   * 反斜杠归一为正斜杠、去掉尾部斜杠、大小写敏感，不做跨平台大小写推断。
   * 门禁必须在任何 query/路径范围/default 分支的 limit 截断之前应用。
   */
  allowedPaths?: string[];
}

/** 解析逗号分隔的原始模式输入：去各项首尾空白并丢弃空项。 */
export function parseWorkspaceFileSearchPatterns(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** 是否有任意有效的包含/排除模式（用于决定无关键词时是否进入结果态）。 */
export function hasWorkspaceFileSearchPatterns(include?: string, exclude?: string): boolean {
  return (
    parseWorkspaceFileSearchPatterns(include ?? "").length > 0 ||
    parseWorkspaceFileSearchPatterns(exclude ?? "").length > 0
  );
}

export function hasWorkspaceFileSearchQuery(query: string): boolean {
  return query.trim().length > 0;
}

/** 去掉首尾成对的引号（终端 / 脚本复制出来的路径常带引号）。 */
function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * 归一化工作区文件搜索查询：去首尾空白、去掉首尾成对引号、反斜杠统一成正斜杠。
 *
 * 归一化必须发生在打分与过滤**之前**。否则带引号或 Windows 分隔符的粘贴路径
 * 会在模糊匹配阶段被判为「无命中」，精确路径命中也就永远排不上第一——
 * 这类路径只有辅助函数自己测得通，真实查询链路并不成立。
 */
export function normalizeWorkspaceFileSearchQuery(rawQuery: string): string {
  const unquoted = stripMatchingQuotes(rawQuery.trim());
  // 没有反斜杠时不做替换，避免每次打分都分配一个新字符串。
  return unquoted.includes("\\") ? unquoted.replace(/\\/g, "/") : unquoted;
}

function isPathSeparator(char: string): boolean {
  return char === "/" || char === "\\";
}

/**
 * 路径等价比较：分隔符 '/' 与 '\' 视为同一个分隔符。
 *
 * 索引里的相对路径统一用正斜杠，绝对路径沿用平台分隔符（Windows 是反斜杠），
 * 因此粘贴进来的 Windows 绝对路径要按语义比较，不能按字符串比较。
 */
function workspaceFilePathsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftChar = left[index] as string;
    const rightChar = right[index] as string;
    if (leftChar === rightChar) {
      continue;
    }
    if (isPathSeparator(leftChar) && isPathSeparator(rightChar)) {
      continue;
    }
    return false;
  }
  return true;
}

export function mapWorkspaceFileEntriesToSearchCandidates(
  entries: WorkspaceFileEntry[],
): WorkspaceFileSearchCandidate[] {
  return entries.map((entry) => {
    // trim 与原打分函数的归一化保持一致（防御首尾空格文件名），严格行为等价。
    const lowercaseRelativePath = entry.relativePath.trim().toLowerCase();
    return {
      id: entry.relativePath,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      type: entry.type,
      lowercaseName: entry.name.trim().toLowerCase(),
      lowercaseRelativePath,
      lowercasePath: entry.path.trim().toLowerCase(),
    };
  });
}

export function scoreWorkspaceFileFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

/** scoreWorkspaceFileFuzzyMatch 的热路径版本：text/query 均为已归一化（trim+lower）输入。 */
function scoreNormalizedFuzzyMatch(normalizedText: string, normalizedQuery: string): number | null {
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

export function getWorkspaceFileSearchCandidateScore(
  candidate: WorkspaceFileSearchCandidate,
  query: string,
): number | null {
  const normalizedQuery = normalizeWorkspaceFileSearchQuery(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  // 精确路径命中（query 与绝对路径或相对路径完全相等）是最强的信号：
  // 粘贴进来的路径就该稳定排第一，不与模糊结果混在一起。
  // 分数越小越靠前，给一个负值让它压过所有前缀/子串/子序列档位。
  if (
    normalizedQuery === candidate.lowercasePath ||
    normalizedQuery === candidate.lowercaseRelativePath
  ) {
    return -1;
  }
  // Windows 上索引里的绝对路径用反斜杠，而归一化后的查询用正斜杠：
  // 语义相等但字符串不等时按路径等价比较，否则这类粘贴永远命不中。
  if (
    normalizedQuery.includes("/") &&
    workspaceFilePathsEqual(normalizedQuery, candidate.lowercasePath)
  ) {
    return -1;
  }
  const nameScore = scoreNormalizedFuzzyMatch(candidate.lowercaseName, normalizedQuery);
  const relativePathScore = scoreNormalizedFuzzyMatch(
    candidate.lowercaseRelativePath,
    normalizedQuery,
  );
  const pathScore = scoreNormalizedFuzzyMatch(candidate.lowercasePath, normalizedQuery);
  // relativePath 打分只计 +25 档；更高的 +100 档恒被同一打分的 +25 项压制，属于死代码；
  // keywords 项（+300）保留，覆盖"query 跨目录段子序列命中"的场景。
  const keywordScore = Math.min(
    relativePathScore !== null ? relativePathScore + 300 : Number.POSITIVE_INFINITY,
    pathScore !== null ? pathScore + 300 : Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    nameScore ?? Number.POSITIVE_INFINITY,
    relativePathScore !== null ? relativePathScore + 25 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

function applyWorkspaceFileSearchLimit<T>(items: T[], limit?: number): T[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultWorkspaceFileSearchPriority(candidate: WorkspaceFileSearchCandidate): number {
  return candidate.type === "directory" ? 1 : 0;
}

function sortDefaultWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
): WorkspaceFileSearchCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority: getDefaultWorkspaceFileSearchPriority(candidate),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ candidate }) => candidate);
}

interface ScoredWorkspaceFileSearchCandidate {
  candidate: WorkspaceFileSearchCandidate;
  index: number;
  score: number;
}

function compareScoredWorkspaceFileSearchCandidates(
  left: ScoredWorkspaceFileSearchCandidate,
  right: ScoredWorkspaceFileSearchCandidate,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.candidate.name.localeCompare(right.candidate.name);
}

/**
 * 大 workspace（数万候选）下 top-K 插入点曾用 findIndex 线性扫，最坏
 * O(候选数 × limit)（65k 候选 × 1000 ≈ 6500 万次比较，实测单键 155ms 同步阻塞
 * 主线程，@ 面板键入时整窗冻结）。compareScoredWorkspaceFileSearchCandidates 按
 * (score, index) 严格全序（index 单次遍历内唯一），二分查找插入点安全，
 * 单次过滤降到 O(n log K)。
 */
function findInsertionIndexByBinarySearch(
  bestMatches: ScoredWorkspaceFileSearchCandidate[],
  scored: ScoredWorkspaceFileSearchCandidate,
): number {
  let low = 0;
  let high = bestMatches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midItem = bestMatches[mid];
    if (midItem !== undefined && compareScoredWorkspaceFileSearchCandidates(scored, midItem) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low === bestMatches.length ? -1 : low;
}

interface CompiledWorkspaceFileSearchScope {
  include: WorkspaceFileSearchGlobMatcher[];
  exclude: WorkspaceFileSearchGlobMatcher[];
}

/**
 * 每次查询只解析/编译一次包含与排除模式，不能逐候选重复 split 与 new RegExp。
 */
function compileWorkspaceFileSearchScope(
  include: string | undefined,
  exclude: string | undefined,
): CompiledWorkspaceFileSearchScope | null {
  const compile = (raw: string | undefined): WorkspaceFileSearchGlobMatcher[] =>
    parseWorkspaceFileSearchPatterns(raw ?? "")
      .map((pattern) => compileWorkspaceFileSearchGlob(pattern))
      .filter((matcher): matcher is WorkspaceFileSearchGlobMatcher => matcher !== null);

  const includeMatchers = compile(include);
  const excludeMatchers = compile(exclude);
  if (includeMatchers.length === 0 && excludeMatchers.length === 0) {
    return null;
  }
  return { include: includeMatchers, exclude: excludeMatchers };
}

function matchesWorkspaceFileSearchScope(
  candidate: WorkspaceFileSearchCandidate,
  scope: CompiledWorkspaceFileSearchScope,
): boolean {
  const isDirectory = candidate.type === "directory";
  // 同一候选在多条 include/exclude 间复用一次归一化结果，避免重复 replace/toLowerCase。
  const normalizedPath = normalizeWorkspaceFileSearchGlobPath(candidate.relativePath);
  // 排除优先：即使同时被包含命中，任一排除项命中就移除。
  for (const matcher of scope.exclude) {
    if (matcher.matchesNormalizedPath(normalizedPath, isDirectory)) {
      return false;
    }
  }
  if (scope.include.length === 0) {
    return true;
  }
  // 多条包含取并集。
  for (const matcher of scope.include) {
    if (matcher.matchesNormalizedPath(normalizedPath, isDirectory)) {
      return true;
    }
  }
  return false;
}

/**
 * 与 getWorkspaceFileGitStatus 的精确 key 语义保持一致：反斜杠归一为正斜杠、
 * 去掉尾部斜杠，大小写保持敏感。allowedPaths 只做内部精确门禁，不在这里猜测
 * 跨平台大小写等价，避免把 Git 状态 key 匹配扩成另一套路径规则。
 */
function normalizeWorkspaceFileSearchAllowedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function createWorkspaceFileSearchAllowedPathSet(
  allowedPaths: string[] | undefined,
): Set<string> | null {
  // Set 每次 filter 只创建一次；undefined 表示不限制，空数组表示允许列表为空。
  if (allowedPaths === undefined) {
    return null;
  }
  return new Set(allowedPaths.map((path) => normalizeWorkspaceFileSearchAllowedPath(path)));
}

function isWorkspaceFileSearchCandidateAllowed(
  candidate: WorkspaceFileSearchCandidate,
  allowedPathSet: ReadonlySet<string> | null,
): boolean {
  if (allowedPathSet === null) {
    return true;
  }
  // allowedPaths 是候选绝对 path 的精确集合（与 Git 状态 key 一致），不能用 relativePath。
  return allowedPathSet.has(normalizeWorkspaceFileSearchAllowedPath(candidate.path));
}

export function filterWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions = {},
): WorkspaceFileSearchCandidate[] {
  const effectiveLimit = options.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 归一化在过滤之前：只有引号或 Windows 分隔符的查询也按真实查询处理。
  const normalizedQuery = normalizeWorkspaceFileSearchQuery(query);
  // 模式只在这里编译一次，后续每个候选只做正则匹配。
  const scope = compileWorkspaceFileSearchScope(options.include, options.exclude);
  // 精确路径门禁同样只在这里建一次 Set；必须在任何分支的 limit 截断之前生效。
  const allowedPathSet = createWorkspaceFileSearchAllowedPathSet(options.allowedPaths);

  if (!normalizedQuery) {
    // 无关键词但有路径范围时仍要列结果；范围必须在 top-K 截断之前生效。
    if (scope) {
      return applyWorkspaceFileSearchLimit(
        sortDefaultWorkspaceFileSearchCandidates(
          candidates.filter(
            (candidate) =>
              isWorkspaceFileSearchCandidateAllowed(candidate, allowedPathSet) &&
              matchesWorkspaceFileSearchScope(candidate, scope),
          ),
        ),
        effectiveLimit,
      );
    }
    return options.requireQuery
      ? []
      : applyWorkspaceFileSearchLimit(
          sortDefaultWorkspaceFileSearchCandidates(
            candidates.filter((candidate) =>
              isWorkspaceFileSearchCandidateAllowed(candidate, allowedPathSet),
            ),
          ),
          effectiveLimit,
        );
  }

  const bestMatches: ScoredWorkspaceFileSearchCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    // 「仅看改动」等精确门禁先于打分与 top-K 截断，避免前 1000 条非变更候选挤掉后面的变更文件。
    if (!isWorkspaceFileSearchCandidateAllowed(candidate, allowedPathSet)) {
      continue;
    }
    if (scope && !matchesWorkspaceFileSearchScope(candidate, scope)) {
      continue;
    }
    const score = getWorkspaceFileSearchCandidateScore(candidate, normalizedQuery);
    if (score === null) {
      continue;
    }

    const scored = { candidate, index, score };
    // 快速路径：数组按序维护，末尾即当前最差；已满且 scored 不优于末尾时必然落选，
    // 跳过查找与 splice（宽匹配 query 下大多数候选走这条分支）。
    const worst = bestMatches[bestMatches.length - 1];
    if (
      worst !== undefined &&
      bestMatches.length >= effectiveLimit &&
      compareScoredWorkspaceFileSearchCandidates(scored, worst) >= 0
    ) {
      continue;
    }

    const insertionIndex = findInsertionIndexByBinarySearch(bestMatches, scored);
    if (insertionIndex === -1) {
      if (bestMatches.length < effectiveLimit) {
        bestMatches.push(scored);
      }
      continue;
    }

    bestMatches.splice(insertionIndex, 0, scored);
    if (bestMatches.length > effectiveLimit) {
      bestMatches.pop();
    }
  }

  return bestMatches.map(({ candidate }) => candidate);
}
