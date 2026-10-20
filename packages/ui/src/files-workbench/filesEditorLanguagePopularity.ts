/**
 * 编辑器语言选择器的流行度排名。
 *
 * 为什么不用首字母序：Monaco 注册了 80 多种语言，按 id 升序会把 Abap、
 * Cameligo、Msdax 这类几乎没人手写的语言排在前面，把 TypeScript、JSON、
 * Markdown 这些天天要用的语言埋在中段。改成按流行度降序后，常用语言一眼可见，
 * 长尾方言仍然留在列表末尾（按 id 升序），搜索能力不受影响。
 *
 * 排名依据（2026 年的公开数据）：
 *
 * - 编程语言：Stack Overflow Developer Survey 2026「All Respondents」
 *   过去一年使用过该语言的开发者占比（n = 14,099），见
 *   https://survey.stackoverflow.co/2026/technology/data/languages
 *   表里每条后面的百分数就是这一份额。
 * - 数据与标记类文件（JSON、Markdown、YAML、XML、INI、Dockerfile、GraphQL 等）
 *   不在该调查口径内，按 GitHub 仓库里这类文件的出现频率排在对应位置
 *   （与 Octoverse 2025「新仓库语言分布」同量级：它们几乎每个仓库都有）。
 * - 数据库方言用同一份调查的 Databases 章节占比（PostgreSQL 57.9%、
 *   MySQL 35.1%、Redis 28.3%）。
 * - 没有公开份额数据的语言不进表，排在表后并按 id 升序。
 */

/**
 * 语言流行度顺序表：越靠前越常用。
 *
 * 这是一份有序列表，不是分数表——排名本身就是调研结论。
 * 调整顺序时先改这份列表，再跑 `filesEditorStatusModel` 的单测。
 */
export const FILES_EDITOR_LANGUAGE_POPULARITY_ORDER: readonly string[] = [
  // 主流编程语言：调查实测份额
  "javascript", // 62.0%
  "sql", // 58.4%
  "html", // 58.2%（HTML/CSS）
  "css", // 58.2%（HTML/CSS）
  "python", // 58.0%
  "shell", // 51.3%
  "typescript", // 43.8%
  // 高频数据文件：几乎每个仓库都有
  "json",
  "markdown",
  "yaml",
  // 主流编程语言（续）
  "java", // 27.6%
  "csharp", // 27.1%
  "powershell", // 24.6%
  "cpp", // 24.3%
  "c", // 21.8%
  "rust", // 18.0%
  "php", // 17.7%
  "go", // 16.5%
  "kotlin", // 10.8%
  "lua", // 9.4%
  // 次主流编程语言
  "swift", // 5.9%
  "ruby", // 5.8%
  "dart", // 4.9%
  "r", // 4.5%
  "vb", // 4.0%（Visual Basic .NET）
  "perl", // 3.8%
  "elixir", // 2.6%
  "scheme", // 2.6%（Lisp）
  "objective-c", // 2.5%
  "scala", // 2.2%
  "pascal", // 1.9%（Delphi）
  "ecl", // 1.5%（Erlang）
  "julia", // 1.5%
  "clojure", // 1.3%
  "fsharp", // 1.2%
  // 常见配置、标记与模板文件
  "xml",
  "scss",
  "less",
  "ini",
  "dockerfile",
  "graphql",
  "protobuf",
  "hcl",
  "razor",
  "mdx",
  "handlebars",
  "liquid",
  "pug",
  "twig",
  "bat",
  "coffee",
  // 数据库方言
  "pgsql", // PostgreSQL 57.9%
  "mysql", // MySQL 35.1%
  "redis", // Redis 28.3%
  "redshift",
  "sparql",
  // 场景窄但仍有明确份额
  "solidity", // 0.8%
  // 纯文本：未知文件的兜底语言
  "plaintext",
];

const RANK_BY_LANGUAGE_ID: ReadonlyMap<string, number> = new Map(
  FILES_EDITOR_LANGUAGE_POPULARITY_ORDER.map((languageId, index) => [languageId, index]),
);

/**
 * 语言流行度排名（0 起，越小越靠前）。
 *
 * 没进排名表的语言返回 undefined：调用方要把它们排在表后（按 id 升序），
 * 而不是当成 rank 0 排到最前面。
 */
export function filesEditorLanguagePopularityRank(languageId: string): number | undefined {
  return RANK_BY_LANGUAGE_ID.get(languageId);
}

/** 按流行度比较两个语言 id：排名靠前的在前，同档按 id 升序。 */
export function compareFilesEditorLanguageIdsByPopularity(leftId: string, rightId: string): number {
  const leftRank = filesEditorLanguagePopularityRank(leftId) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = filesEditorLanguagePopularityRank(rightId) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return leftId.localeCompare(rightId);
}
