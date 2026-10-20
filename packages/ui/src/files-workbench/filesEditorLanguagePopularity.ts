/**
 * 编辑器语言选择器的流行度排名。
 *
 * 为什么不用首字母序：Monaco 注册了 80 多种语言，按 id 升序会把 Abap、
 * Cameligo、Msdax 这类几乎没人手写的语言排在前面，把 TypeScript、JSON、
 * Markdown 这些天天要用的语言埋在中段。改成按流行度降序后，常用语言一眼可见，
 * 长尾方言仍然留在列表末尾（按 id 升序），搜索能力不受影响。
 *
 * 排名依据：GitHub 仓库里「含有该类文件的仓库占比」（仓库覆盖率）。
 *
 * - 数据来源：抽样 4,973 个 GitHub 公开仓库（排除 fork 与已归档），对每个仓库
 *   调用 Git Trees API 拉全量文件树，统计每个扩展名/文件名出现在多少个仓库里，
 *   再按语言归并。同一语言的多扩展名取并集（仓库只要含其中之一就算命中）。
 *   抽样分高星层（991 个，stars >= 100）与低星层（3,982 个，2019–2026 年创建、
 *   stars 1–99），两层各自算一遍排名做稳健性对照，Spearman 秩相关 0.974。
 * - 交叉验证：论文《What's Inside a GitHub Repository? (2026)》
 *   （arXiv:2605.16701v2，Table II）用同样口径给出 Markdown 98.6%、
 *   .yml 84.1%、.json 69.2%、.txt 56.9%、.sh 46.8%、.yaml 42.1%、
 *   .js 40.5%、.py 39.4%；本次抽样得到 .md 96.1%、.yml 79.6%、.json 69.7%、
 *   .txt 54.5%、.sh 42.5%、.yaml 40.5%、.js 42.1%、.py 40.9%，量级与趋势一致。
 *   论文数据集在 Zenodo（doi:10.5281/zenodo.20185536），未直接取用，
 *   只作为交叉验证。
 * - 数据库方言（mysql、pgsql、redis、redshift）没有独立扩展名，
 *   份额取 DB-Engines 排名分；sparql 按 .rq 文件覆盖率计。
 *
 * 口径、抽样方法与验收口径见 `docs/specs/files-editor-status-bar.md`
 * 的「流行度数据来源」。
 */

/**
 * 语言 id → 仓库覆盖率（百分比）。
 *
 * 键用 Monaco 真正注册的语言 id（见 monaco-editor 的
 * `esm/vs/languages/definitions` 下各语言的 `register.js`），因为状态栏语言浮层直接来自
 * `monaco.languages.getLanguages()`；`jsonl` 与 `makefile` 是产品自注册的两个语言。
 *
 * 产品内置规则里另有几个 id 是 Monaco 的别名而非注册 id
 * （coffee → coffeescript、protobuf → proto、solidity → sol），
 * 这几个通过下方别名表共享同一份覆盖率。
 */
const FILES_EDITOR_LANGUAGE_REPO_COVERAGE: Readonly<Record<string, number>> = {
  // 文档、配置与标记
  markdown: 96.3,
  plaintext: 87.69,
  yaml: 84.78,
  json: 71.16,
  ini: 56.16,
  xml: 55.98,
  // 主流编程语言
  javascript: 45.67,
  shell: 43.21,
  html: 43.03,
  python: 40.9,
  css: 37.99,
  typescript: 24.53,
  dockerfile: 23.99,
  makefile: 18.04,
  bat: 12.47,
  c: 11.64,
  sql: 10.34,
  go: 9.13,
  scss: 8.35,
  cpp: 8.28,
  java: 8.28,
  powershell: 7.38,
  rust: 6.58,
  ruby: 6.37,
  php: 6.11,
  csharp: 4.67,
  restructuredtext: 4.65,
  kotlin: 4.56,
  swift: 4.2,
  mdx: 3.92,
  lua: 3.72,
  hcl: 3.5,
  jsonl: 3.46,
  proto: 3.32,
  "objective-c": 3.12,
  perl: 2.53,
  r: 2.15,
  mips: 1.99,
  less: 1.31,
  graphql: 1.27,
  handlebars: 1.01,
  dart: 0.97,
  scheme: 0.78,
  scala: 0.76,
  twig: 0.76,
  julia: 0.72,
  pascal: 0.72,
  wgsl: 0.56,
  elixir: 0.54,
  sol: 0.5,
  fsharp: 0.48,
  razor: 0.42,
  apex: 0.38,
  tcl: 0.34,
  coffeescript: 0.3,
  freemarker2: 0.3,
  clojure: 0.28,
  liquid: 0.24,
  vb: 0.22,
  ecl: 0.2,
  flow9: 0.2,
  verilog: 0.2,
  systemverilog: 0.16,
  bicep: 0.12,
  pug: 0.12,
  sb: 0.1,
  sparql: 0.1,
  st: 0.1,
  cypher: 0.08,
  m3: 0.04,
  msdax: 0.04,
  qsharp: 0.04,
  typespec: 0.04,
  abap: 0.02,
  csp: 0.02,
  lexon: 0.02,
  powerquery: 0.02,
  // 样本里一次都没出现的语言，覆盖率记 0，仍按 id 升序排在末尾
  aes: 0,
  azcli: 0,
  cameligo: 0,
  pascaligo: 0,
  pla: 0,
  postiats: 0,
};

/**
 * 数据库方言的份额（百分比）。
 *
 * 方言没有独立扩展名可统计（`.sql` 归到 sql 语言），改用 DB-Engines 的
 * 数据库市场份额近似：MySQL 13.76%、PostgreSQL 11.31%、Redis 2.56%、
 * Amazon Redshift 0.28%。量纲同样是百分比，与仓库覆盖率放在一起排序。
 */
const FILES_EDITOR_LANGUAGE_DIALECT_SHARE: Readonly<Record<string, number>> = {
  mysql: 13.76,
  pgsql: 11.31,
  redis: 2.56,
  redshift: 0.28,
};

/** 排序用的份额：方言用数据库市场份额，其余用仓库覆盖率。 */
const FILES_EDITOR_LANGUAGE_SHARE: Readonly<Record<string, number>> = {
  ...FILES_EDITOR_LANGUAGE_REPO_COVERAGE,
  ...FILES_EDITOR_LANGUAGE_DIALECT_SHARE,
};

/**
 * 别名 id → 基准语言 id。
 *
 * 两类别名都指向同一个基准 id，共享同一份份额：
 *
 * - 产品内置规则里用的是 Monaco 的别名而不是注册 id：`filesMonacoLanguage.ts`
 *   的扩展名映射表返回 coffee / protobuf / solidity，Monaco 注册的却是
 *   coffeescript / proto / sol。
 * - Monaco 为 FreeMarker2 的不同括号插值语法各注册了一个 id，本体是同一个语言。
 */
const FILES_EDITOR_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  coffee: "coffeescript",
  protobuf: "proto",
  solidity: "sol",
  "freemarker2.tag-angle.interpolation-bracket": "freemarker2",
  "freemarker2.tag-angle.interpolation-dollar": "freemarker2",
  "freemarker2.tag-auto.interpolation-bracket": "freemarker2",
  "freemarker2.tag-auto.interpolation-dollar": "freemarker2",
  "freemarker2.tag-bracket.interpolation-bracket": "freemarker2",
  "freemarker2.tag-bracket.interpolation-dollar": "freemarker2",
};

/**
 * 语言流行度顺序表：越靠前越常用。
 *
 * 顺序由份额数据派生，不是手写的有序列表：改数据即改顺序，改完必须同步更新
 * `filesEditorLanguagePopularity.test.ts` 的断言。
 */
export const FILES_EDITOR_LANGUAGE_POPULARITY_ORDER: readonly string[] = Object.freeze(
  Object.entries(FILES_EDITOR_LANGUAGE_SHARE)
    .sort(([leftId, leftShare], [rightId, rightShare]) =>
      leftShare === rightShare ? leftId.localeCompare(rightId) : rightShare - leftShare,
    )
    .map(([languageId]) => languageId),
);

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
  const registeredId = FILES_EDITOR_LANGUAGE_ALIASES[languageId] ?? languageId;
  return RANK_BY_LANGUAGE_ID.get(registeredId);
}

/** 按流行度比较两个语言 id：排名靠前的在前，同档按 id 升序。 */
export function compareFilesEditorLanguageIdsByPopularity(leftId: string, rightId: string): number {
  const leftRank = filesEditorLanguagePopularityRank(leftId) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = filesEditorLanguagePopularityRank(rightId) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return leftId.localeCompare(rightId);
}
