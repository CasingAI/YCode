/**
 * 内容级语言检测的置信度处理。
 *
 * 模型给的是「短标签 + 置信度」（如 `ts` / `js` / `yaml`），这一层负责：
 * 1. 把短标签映射到 Monaco 语言 id（映射不上的直接丢弃）；
 * 2. 按 VS Code 的经验做置信度修正（`adjustLanguageConfidence`）；
 * 3. 按 VS Code 的阈值与候选间距规则选出唯一结果；
 * 4. 额外的 JSON 防护：内容以 `{` / `[` 开头时不让 YAML 抢走 JSON。
 *
 * 规则来源与理由见 docs/specs/files-editor-language-detection.md。
 */

/** 模型给出的候选结果。 */
export interface FilesLanguageDetectionCandidate {
  /** 模型短标签，如 `ts`、`js`、`yaml`。 */
  languageId: string;
  /** 置信度，0-1。 */
  confidence: number;
}

/** 采纳结果的最低置信度，与 VS Code 的 `expectedRelativeConfidence` 一致。 */
export const FILES_LANGUAGE_DETECTION_THRESHOLD = 0.2;

/**
 * 模型短标签 → Monaco 语言 id。
 *
 * 只收录 Monaco 0.57 确实注册过的语言（`monaco-editor/esm/vs/languages/definitions`）。
 * Monaco 没有 `jsonc`（JSON 只有一个 `json` 语言）；`makefile` 与 `jsonl`
 * 由我们自行注册，这里也一并映射。
 */
const MONACO_LANGUAGE_BY_MODEL_LABEL: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  sh: "shell",
  ps1: "powershell",
  rb: "ruby",
  rs: "rust",
  cs: "csharp",
  cpp: "cpp",
  c: "c",
  java: "java",
  go: "go",
  swift: "swift",
  lua: "lua",
  r: "r",
  dart: "dart",
  php: "php",
  html: "html",
  css: "css",
  xml: "xml",
  sql: "sql",
  json: "json",
  ini: "ini",
  toml: "ini",
  makefile: "makefile",
  dockerfile: "dockerfile",
  bat: "bat",
  scala: "scala",
  clojure: "clojure",
  coffee: "coffee",
  perl: "perl",
  julia: "julia",
  liquid: "liquid",
  hcl: "hcl",
  graphql: "graphql",
  pug: "pug",
  razor: "razor",
  handlebars: "handlebars",
  protobuf: "protobuf",
  solidity: "solidity",
  systemverilog: "systemverilog",
  tcl: "tcl",
  twig: "twig",
  vb: "vb",
  wgsl: "wgsl",
  "objective-c": "objective-c",
  pascal: "pascal",
  fsharp: "fsharp",
  elixir: "elixir",
  ecl: "ecl",
  restructuredtext: "restructuredtext",
  mysql: "mysql",
  pgsql: "pgsql",
  redis: "redis",
  redshift: "redshift",
  sparql: "sparql",
  powerquery: "powerquery",
  qsharp: "qsharp",
  typespec: "typespec",
  m3: "m3",
  st: "st",
  sb: "sb",
};

/**
 * 置信度加成：VS Code 常用且模型支持得好的语言。
 * 依据 VS Code `languageDetectionWebWorker.ts` 的 `adjustLanguageConfidence`。
 */
const CONFIDENCE_BOOSTS: Record<string, number> = {
  js: 0.05,
  html: 0.05,
  json: 0.05,
  ts: 0.05,
  css: 0.05,
  py: 0.05,
  xml: 0.05,
  php: 0.05,
  cpp: 0.025,
  sh: 0.025,
  java: 0.025,
  cs: 0.025,
  c: 0.025,
};

/**
 * 置信度惩罚：已知容易误判的语言。VS Code 的原值是 0.5。
 * `yaml` 刻意不在任何一侧：VS Code 的注释写明「YAML 语法太简单，容易造成错误检测」，
 * 所以不给加成；但也不做惩罚，避免把真实 YAML 一并压掉。
 */
const CONFIDENCE_PENALTIES: Record<string, number> = {
  bat: 0.5,
  ini: 0.5,
  makefile: 0.5,
  sql: 0.5,
  csv: 0.5,
  toml: 0.5,
};

export function filesLanguageDetectionMonacoId(modelLabel: string): string | undefined {
  return MONACO_LANGUAGE_BY_MODEL_LABEL[modelLabel];
}

/** 置信度修正：加成与惩罚都作用在模型标签上。 */
export function filesLanguageDetectionAdjustedConfidence(
  modelLabel: string,
  confidence: number,
): number {
  const boost = CONFIDENCE_BOOSTS[modelLabel] ?? 0;
  const penalty = CONFIDENCE_PENALTIES[modelLabel] ?? 0;
  return confidence + boost - penalty;
}

/** 内容是否像 JSON：以 `{` 或 `[` 开头（跳过空白）。 */
export function filesLanguageDetectionLooksLikeJson(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * 从候选里选出唯一语言。
 *
 * 规则：
 * - 修正置信度后，最高候选仍低于阈值 → 没有结论；
 * - 修正后取最高者。VS Code 取的是「原始第一名」，加成只影响候选集合；
 *   这里改为按修正后置信度取最高，好让 JSON 的加成真正能压过 YAML。
 *
 * 与 VS Code 的一处刻意差异：VS Code 会先用**原始**置信度做一次阈值判断，
 * 原始值略低就直接放弃（加成白加）。这里只用修正后的值判断，
 * 否则常见语言在边界值上会被误杀。
 *
 * 额外一条 JSON 防护：内容以 `{` / `[` 开头且模型把 YAML 排在前面时，
 * 改选 JSON。VS Code 用的 guesslang 模型有「JSON 被判成 YAML」的已知报告
 * （microsoft/vscode-languagedetection#3），这条规则专门压住该误判。
 */
export function selectFilesDetectedLanguage(
  candidates: readonly FilesLanguageDetectionCandidate[],
  content = "",
): string | undefined {
  if (candidates.length === 0) return undefined;

  // 映射不出 Monaco 语言 id 的候选直接出局。
  const mapped = candidates
    .map((candidate) => {
      const monacoId = filesLanguageDetectionMonacoId(candidate.languageId);
      if (!monacoId) return undefined;
      return {
        label: candidate.languageId,
        monacoId,
        confidence: filesLanguageDetectionAdjustedConfidence(
          candidate.languageId,
          candidate.confidence,
        ),
      };
    })
    .filter(
      (candidate): candidate is { label: string; monacoId: string; confidence: number } =>
        candidate !== undefined,
    )
    .sort((left, right) => right.confidence - left.confidence);

  const best = mapped[0];
  if (!best || best.confidence < FILES_LANGUAGE_DETECTION_THRESHOLD) return undefined;

  // JSON 防护：内容是 JSON 结构时不让 YAML 抢走。
  if (best.label === "yaml" && filesLanguageDetectionLooksLikeJson(content)) {
    const json = mapped.find((candidate) => candidate.label === "json");
    if (json) return json.monacoId;
  }

  return best.monacoId;
}
