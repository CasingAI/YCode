import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";

export interface SearchCenterPathQuery {
  /** 输入是否被判定为「一条路径」（绝对路径或 `~` 开头）。 */
  looksLikePath: boolean;
  /** 归一化后的绝对路径；判定不出绝对路径时为 null（例如还没有 home 目录时的 `~`）。 */
  absolutePath: string | null;
}

const NO_PATH_QUERY: SearchCenterPathQuery = { looksLikePath: false, absolutePath: null };

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

/** 拼接 home 目录与 `~` 之后的相对部分，分隔符跟随 home 目录的写法。 */
function joinHomePath(homePath: string, rest: string): string {
  if (!rest) {
    return homePath;
  }
  const separator = homePath.includes("\\") && !homePath.includes("/") ? "\\" : "/";
  return `${homePath.replace(/[\\/]+$/, "")}${separator}${rest}`;
}

/**
 * 判断搜索框里的输入是不是一条路径，并给出可交给文件服务的绝对路径。
 *
 * 工作区索引只覆盖工作区内部，粘贴进来的路径经常指向工作区之外
 * （例如 `~/.zcode/AGENTS.md`）。这类输入必须被当作「打开这个路径」，
 * 而不是丢进模糊搜索里当成关键词。
 *
 * `~` 的展开依赖当前 Host 的 home 目录：远程工作区要展开远端机器的 home，
 * 拿不到 home 时只能判定「像路径」，交由调用方等待 home 到位。
 */
export function resolveSearchCenterPathQuery(
  rawQuery: string,
  homePath?: string | null,
): SearchCenterPathQuery {
  const trimmed = stripMatchingQuotes(rawQuery.trim());
  if (!trimmed) {
    return NO_PATH_QUERY;
  }
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const home = homePath?.trim();
    if (!home) {
      // 还没拿到 home：这是路径，但暂时展开不了。
      return { looksLikePath: true, absolutePath: null };
    }
    return {
      looksLikePath: true,
      absolutePath: joinHomePath(home, trimmed.slice(1).replace(/^[\\/]+/, "")),
    };
  }
  if (isAbsoluteFilePath(trimmed)) {
    return { looksLikePath: true, absolutePath: trimmed };
  }
  // 相对路径（含目录分隔符）仍走工作区索引的模糊与精确匹配。
  return NO_PATH_QUERY;
}

/** 路径等价比较：分隔符等价、忽略大小写、忽略结尾分隔符。 */
export function areSearchCenterPathsEqual(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

/** 直接打开候选的展示信息：文件名 + 所在目录（绝对路径本身就是目录线索）。 */
export function buildSearchCenterPathCandidateRow(absolutePath: string) {
  return {
    path: absolutePath,
    name: getPathLeaf(absolutePath),
    relativePath: absolutePath,
  };
}
