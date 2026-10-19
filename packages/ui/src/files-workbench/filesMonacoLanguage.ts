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
  jsonl: "jsonl",
  ndjson: "jsonl",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xhtml: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  pyw: "python",
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
  rb: "ruby",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  properties: "ini",
  vue: "html",
  svelte: "html",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  txt: "plaintext",
  log: "plaintext",
};

const SHELL_FILENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zlogin",
  ".envrc",
]);

const INI_FILENAMES = new Set([".editorconfig", ".gitconfig", ".npmrc", ".yarnrc"]);

const PLAINTEXT_FILENAMES = new Set([
  ".dockerignore",
  ".eslintignore",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".npmignore",
  ".prettierignore",
  ".vscodeignore",
  ".ignore",
  "license",
  "license.md",
]);

const MARKDOWN_FILENAMES = new Set([
  "readme",
  "readme.md",
  "changelog",
  "changelog.md",
  "contributing",
  "contributing.md",
]);

/**
 * 根据文件名推断 Monaco language id。特殊文件名先于扩展名处理，
 * 避免 `.env`、Dockerfile 和 Makefile 被错误地当作无扩展名文本。
 */
export function filesMonacoLanguageFromPath(path: string | undefined): string {
  if (!path) return "plaintext";
  const fileName = (path.split(/[\\/]/).pop() ?? path).trim();
  const lowerName = fileName.toLowerCase();

  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (
    lowerName === "makefile" ||
    lowerName === "gnumakefile" ||
    lowerName.startsWith("makefile.")
  ) {
    return "makefile";
  }
  if (lowerName === ".env" || lowerName.startsWith(".env.")) return "ini";
  if (SHELL_FILENAMES.has(lowerName)) return "shell";
  if (INI_FILENAMES.has(lowerName)) return "ini";
  if (PLAINTEXT_FILENAMES.has(lowerName)) return "plaintext";
  if (MARKDOWN_FILENAMES.has(lowerName)) return "markdown";

  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "plaintext";
  const extension = lowerName.slice(dotIndex + 1);
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
