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
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  vue: "html",
  svelte: "html",
  graphql: "graphql",
  gql: "graphql",
};

export function filesMonacoLanguageFromPath(path: string | undefined): string {
  if (!path) {
    return "plaintext";
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return "plaintext";
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
