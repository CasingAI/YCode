/**
 * 工作区文件搜索的纯 glob 引擎。
 *
 * 语义与文件关联共享：
 * - 模式里不含路径分隔符时只匹配文件名（`*.foo` 命中任意目录下的 `app.foo`）；
 * - 模式里含路径分隔符时从工作区根匹配整条相对路径（`src/**\/*.json`）。
 * - `*` 不跨分隔符，`**` 跨分隔符，`?` 匹配单个非分隔符字符。
 *
 * 搜索额外支持目录后缀：模式以 `/` 结尾时表示该目录本身及其全部内容
 * （`src/generated/` 命中目录 `src/generated` 与其中任意深度的文件）。
 * 文件关联通过 `allowDirectorySuffix: false` 继续保留原有语义，不能被搜索规则误扩。
 *
 * 刻意不支持 `{a,b}` 展开、正则、`!` 取反与逗号转义：少一套语法就少一份歧义。
 */

const PATH_SEPARATOR = /[\\/]/;
const WILDCARD = /[*?]/;
const COMPILED_CACHE_LIMIT = 512;

export interface CompileWorkspaceFileSearchGlobOptions {
  /**
   * 是否启用目录后缀语义，默认启用（浏览器搜索用途）。
   * 文件关联等旧调用传 false，让尾部 `/` 仍按字面字符处理。
   */
  allowDirectorySuffix?: boolean;
}

export interface WorkspaceFileSearchGlobMatcher {
  /** 原始模式（已归一化为正斜杠）。 */
  readonly pattern: string;
  /** 候选路径为工作区相对路径；目录条目需把 isDirectory 传 true。 */
  matches(relativePath: string, isDirectory?: boolean): boolean;
  /**
   * 批量匹配热路径：调用方先用 normalizeWorkspaceFileSearchGlobPath 归一化一次，
   * 避免同一候选在多条模式间重复 replace/toLowerCase。
   */
  matchesNormalizedPath(normalizedPath: string, isDirectory?: boolean): boolean;
}

interface CompiledWorkspaceFileSearchGlob {
  regex: RegExp;
  descendantRegex: RegExp | null;
  directoryPattern: boolean;
  /** 含分隔符的模式按整条相对路径匹配，否则只匹配文件名。 */
  matchFullPath: boolean;
}

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        if (pattern[index] === "/") {
          // `**/` 允许零层目录：`src/**/a.json` 同时命中 `src/a.json`。
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
        continue;
      }
      source += "[^/\\\\]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/\\\\]";
      index += 1;
      continue;
    }
    source += escapeRegExp(char ?? "");
    index += 1;
  }
  return source;
}

/** 归一化路径：统一分隔符并转小写，让匹配不受平台与大小写影响。 */
export function normalizeWorkspaceFileSearchGlobPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** 键里带通配符才算模式，否则按精确路径处理。 */
export function isWorkspaceFileSearchGlobPattern(value: string): boolean {
  return WILDCARD.test(value);
}

const compiledCache = new Map<string, CompiledWorkspaceFileSearchGlob>();

function compileGlobPattern(
  normalizedPattern: string,
  directoryPattern: boolean,
): CompiledWorkspaceFileSearchGlob {
  const cacheKey = `${directoryPattern ? "d" : "f"}\u0000${normalizedPattern}`;
  const cached = compiledCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const basePattern = directoryPattern ? normalizedPattern.replace(/\/+$/, "") : normalizedPattern;
  const exactSource = globToRegExpSource(basePattern);
  const compiled: CompiledWorkspaceFileSearchGlob = {
    regex: new RegExp(`^${exactSource}$`, "i"),
    descendantRegex: directoryPattern ? new RegExp(`^${exactSource}/.+$`, "i") : null,
    directoryPattern,
    // 目录后缀本身也是路径分隔符，必须从根匹配；`*.foo` 这类无分隔符模式只看文件名。
    matchFullPath: directoryPattern || PATH_SEPARATOR.test(normalizedPattern),
  };

  if (compiledCache.size >= COMPILED_CACHE_LIMIT) {
    // 用户输入的模式数量有限，但查询变化会持续产生新字符串；达到上限直接清空，
    // 避免无界缓存把长期打开的窗口内存拖高。
    compiledCache.clear();
  }
  compiledCache.set(cacheKey, compiled);
  return compiled;
}

export function compileWorkspaceFileSearchGlob(
  pattern: string,
  options: CompileWorkspaceFileSearchGlobOptions = {},
): WorkspaceFileSearchGlobMatcher | null {
  if (!pattern) {
    return null;
  }
  const normalized = pattern.replace(/\\/g, "/");
  const allowDirectorySuffix = options.allowDirectorySuffix !== false;
  const directoryPattern = allowDirectorySuffix && normalized.endsWith("/");
  const basePattern = directoryPattern ? normalized.replace(/\/+$/, "") : normalized;
  if (!basePattern) {
    return null;
  }

  const compiled = compileGlobPattern(normalized, directoryPattern);
  const matchesNormalizedPath = (normalizedPath: string, isDirectory = false): boolean => {
    if (!normalizedPath) {
      return false;
    }
    if (compiled.directoryPattern) {
      // 目录本身要求候选也是目录；其内容则按前缀/深度匹配。
      if (compiled.regex.test(normalizedPath)) {
        return isDirectory;
      }
      return compiled.descendantRegex !== null && compiled.descendantRegex.test(normalizedPath);
    }
    if (compiled.matchFullPath) {
      return compiled.regex.test(normalizedPath);
    }
    const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    return compiled.regex.test(basename);
  };
  return {
    pattern: normalized,
    matches(relativePath: string, isDirectory = false): boolean {
      if (!relativePath) {
        return false;
      }
      return matchesNormalizedPath(normalizeWorkspaceFileSearchGlobPath(relativePath), isDirectory);
    },
    matchesNormalizedPath,
  };
}

/** 一次性便利函数；批量匹配请用 compileWorkspaceFileSearchGlob 复用编译结果。 */
export function workspaceFileSearchGlobMatches(
  pattern: string,
  relativePath: string,
  options: CompileWorkspaceFileSearchGlobOptions & { isDirectory?: boolean } = {},
): boolean {
  const matcher = compileWorkspaceFileSearchGlob(pattern, options);
  if (!matcher) {
    return false;
  }
  return matcher.matches(relativePath, options.isDirectory === true);
}
