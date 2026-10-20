import {
  filesEditorGlobMatches,
  normalizeFilesEditorPath,
} from "@/files-workbench/filesEditorLanguageGlob.js";
import { compareFilesEditorLanguageIdsByPopularity } from "@/files-workbench/filesEditorLanguagePopularity.js";

/**
 * 内置语言规则：文件名 / 通配模式 / 扩展名 / 首行。
 *
 * 语言 id 必须是 Monaco 已注册的语言 id，否则模型会退化成无高亮。
 * Monaco 0.57 实际注册的语言见 `monaco-editor/esm/vs/languages/definitions`，
 * 其中没有 `jsonc`（JSON 只有一个 `json` 语言），`makefile` 与 `jsonl`
 * 由 `filesMonacoCustomLanguages.ts` 自行注册。
 */
export type FilesMonacoLanguageSource =
  | "filename"
  | "filename-pattern"
  | "extension"
  | "first-line"
  | "default";

export interface FilesMonacoLanguageMatch {
  languageId: string;
  source: FilesMonacoLanguageSource;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  ipynb: "json",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xhtml: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  pyw: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  phtml: "php",
  rb: "ruby",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  svg: "xml",
  sql: "sql",
  mysql: "mysql",
  pgsql: "pgsql",
  redis: "redis",
  redshift: "redshift",
  sparql: "sparql",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  properties: "ini",
  vue: "html",
  svelte: "html",
  astro: "html",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  hcl: "hcl",
  tf: "hcl",
  tfvars: "hcl",
  tfstate: "json",
  bicep: "bicep",
  cshtml: "razor",
  razor: "razor",
  liquid: "liquid",
  hbs: "handlebars",
  handlebars: "handlebars",
  pug: "pug",
  jade: "pug",
  coffee: "coffee",
  clj: "clojure",
  cljs: "clojure",
  edn: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "ecl",
  hrl: "ecl",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  jl: "julia",
  lisp: "scheme",
  scm: "scheme",
  pas: "pascal",
  pascal: "pascal",
  m: "objective-c",
  mm: "objective-c",
  sol: "solidity",
  sv: "systemverilog",
  vh: "systemverilog",
  rst: "restructuredtext",
  tcl: "tcl",
  twig: "twig",
  vb: "vb",
  m3: "m3",
  st: "st",
  sb: "sb",
  txt: "plaintext",
  log: "plaintext",
};

/** 精确文件名（小写）。点文件与无扩展名文件只能靠这张表。 */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_login": "shell",
  ".bash_aliases": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".zshenv": "shell",
  ".zprofile": "shell",
  ".zlogin": "shell",
  ".envrc": "shell",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".jshintrc": "json",
  ".swcrc": "json",
  ".hintrc": "json",
  ".prettierrc": "json",
  ".stylelintrc": "json",
  ".dockerignore": "plaintext",
  ".eslintignore": "plaintext",
  ".gitattributes": "plaintext",
  ".gitignore": "plaintext",
  ".gitmodules": "plaintext",
  ".npmignore": "plaintext",
  ".prettierignore": "plaintext",
  ".vscodeignore": "plaintext",
  ".ignore": "plaintext",
  license: "plaintext",
  "license.md": "plaintext",
  notice: "plaintext",
  readme: "markdown",
  "readme.md": "markdown",
  changelog: "markdown",
  "changelog.md": "markdown",
  contributing: "markdown",
  "contributing.md": "markdown",
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  "cargo.toml": "ini",
  "cargo.lock": "ini",
  "go.mod": "go",
  "go.sum": "ini",
  pipfile: "ini",
};

/**
 * 通配文件名模式。`filesEditorGlobMatches` 的语义：
 * 模式不含分隔符时只比文件名，含分隔符时比整条路径。
 */
const LANGUAGE_BY_FILENAME_PATTERN: ReadonlyArray<{ pattern: string; languageId: string }> = [
  { pattern: "tsconfig.*.json", languageId: "json" },
  { pattern: "jsconfig.*.json", languageId: "json" },
  { pattern: "*.gemspec", languageId: "ruby" },
  { pattern: "*.podspec", languageId: "ruby" },
  { pattern: "*.module.css", languageId: "css" },
  { pattern: "docker-compose*.yml", languageId: "yaml" },
  { pattern: "docker-compose*.yaml", languageId: "yaml" },
  { pattern: "*.cshtml", languageId: "razor" },
];

/** 首行 shebang 里的解释器 → 语言。取不到解释器时按未知处理。 */
const LANGUAGE_BY_INTERPRETER: Record<string, string> = {
  python: "python",
  python2: "python",
  python3: "python",
  node: "javascript",
  nodejs: "javascript",
  deno: "typescript",
  bun: "javascript",
  "ts-node": "typescript",
  tsx: "typescript",
  bash: "shell",
  zsh: "shell",
  sh: "shell",
  ksh: "shell",
  dash: "shell",
  ruby: "ruby",
  perl: "perl",
  php: "php",
  lua: "lua",
  julia: "julia",
  elixir: "elixir",
  rscript: "r",
  pwsh: "powershell",
  swift: "swift",
};

/** 非 shebang 的首行特征。 */
const FIRST_LINE_PATTERNS: ReadonlyArray<{ pattern: RegExp; languageId: string }> = [
  { pattern: /^#cloud-config/, languageId: "yaml" },
  { pattern: /^<\?xml/, languageId: "xml" },
];

/** 首行参与匹配的最大长度，超长行只取开头一段。 */
const FIRST_LINE_LIMIT = 200;

function splitPath(path: string): string[] {
  return path.split(/[\\/]/);
}

function baseName(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? path;
}

/**
 * 从 shebang 行里取解释器名。
 * `#!/usr/bin/env python3 -u` → `python3`；`#!/bin/bash` → `bash`。
 */
function interpreterFromShebang(firstLine: string): string | undefined {
  const trimmed = firstLine.trim();
  if (!trimmed.startsWith("#!")) return undefined;
  const parts = trimmed.slice(2).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = parts[0]?.replace(/^.*[\\/]/, "") ?? "";
  if (first === "env") {
    const next = parts[1]?.replace(/^.*[\\/]/, "");
    return next || undefined;
  }
  return first || undefined;
}

function matchFirstLine(firstLine: string | undefined): string | undefined {
  if (!firstLine) return undefined;
  const line = firstLine.slice(0, FIRST_LINE_LIMIT);
  for (const rule of FIRST_LINE_PATTERNS) {
    if (rule.pattern.test(line)) return rule.languageId;
  }
  const interpreter = interpreterFromShebang(line);
  if (!interpreter) return undefined;
  return LANGUAGE_BY_INTERPRETER[interpreter.toLowerCase()];
}

/**
 * 内置规则解析：按「精确文件名 → 通配模式 → 扩展名 → 首行」顺序给语言。
 * 特殊文件名先于扩展名处理，避免 `.env`、Dockerfile、Makefile 被当作无扩展名文本。
 */
export function filesMonacoLanguageMatchFromPath(
  path: string | undefined,
  firstLine?: string,
): FilesMonacoLanguageMatch {
  if (!path) {
    const fromFirstLine = matchFirstLine(firstLine);
    return fromFirstLine
      ? { languageId: fromFirstLine, source: "first-line" }
      : { languageId: "plaintext", source: "default" };
  }

  const fileName = baseName(path).trim();
  const lowerName = fileName.toLowerCase();

  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) {
    return { languageId: "dockerfile", source: "filename" };
  }
  if (
    lowerName === "makefile" ||
    lowerName === "gnumakefile" ||
    lowerName.startsWith("makefile.")
  ) {
    return { languageId: "makefile", source: "filename" };
  }
  if (lowerName === ".env" || lowerName.startsWith(".env.")) {
    return { languageId: "ini", source: "filename" };
  }

  const exact = LANGUAGE_BY_FILENAME[lowerName];
  if (exact) {
    return { languageId: exact, source: "filename" };
  }

  const normalizedPath = normalizeFilesEditorPath(path);
  for (const rule of LANGUAGE_BY_FILENAME_PATTERN) {
    if (filesEditorGlobMatches(rule.pattern, normalizedPath)) {
      return { languageId: rule.languageId, source: "filename-pattern" };
    }
  }

  const dotIndex = lowerName.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex !== lowerName.length - 1) {
    const extension = lowerName.slice(dotIndex + 1);
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) {
      return { languageId: language, source: "extension" };
    }
  }

  const fromFirstLine = matchFirstLine(firstLine);
  if (fromFirstLine) {
    return { languageId: fromFirstLine, source: "first-line" };
  }

  return { languageId: "plaintext", source: "default" };
}

/**
 * 根据文件名推断 Monaco language id。
 * 与 `filesMonacoLanguageMatchFromPath` 同源，保留旧签名供既有调用与测试使用。
 */
export function filesMonacoLanguageFromPath(path: string | undefined): string {
  return filesMonacoLanguageMatchFromPath(path).languageId;
}

/**
 * 设置页可选语言：内置规则里出现过的语言 id 汇总，避免用户手写不存在的 id。
 *
 * 顺序按流行度降序（见 `filesEditorLanguagePopularity.ts`），没进排名表的语言
 * 按 id 升序垫底。
 */
export const FILES_MONACO_LANGUAGE_OPTIONS: readonly string[] = Array.from(
  new Set([
    "plaintext",
    ...Object.values(LANGUAGE_BY_EXTENSION),
    ...Object.values(LANGUAGE_BY_FILENAME),
    ...LANGUAGE_BY_FILENAME_PATTERN.map((rule) => rule.languageId),
    ...Object.values(LANGUAGE_BY_INTERPRETER),
  ]),
).sort(compareFilesEditorLanguageIdsByPopularity);
