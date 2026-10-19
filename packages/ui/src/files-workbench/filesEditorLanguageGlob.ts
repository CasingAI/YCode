/**
 * 文件工作台通配匹配：给「内置文件名模式」和「用户文件关联」共用。
 *
 * 语义对齐 VS Code 的 `files.associations`：
 * - 模式里不含路径分隔符时只匹配文件名（`*.foo` 命中任意目录下的 `app.foo`）；
 * - 模式里含路径分隔符时匹配整条路径（`src/**\/*.json`）。
 * - `*` 不跨分隔符，`**` 跨分隔符，`?` 匹配单个非分隔符字符。
 *
 * 刻意不支持 `{a,b}` 展开与 `!` 取反：这两类在文件关联里几乎不用，
 * 少一套语法就少一份歧义。
 */

const PATH_SEPARATOR = /[\\/]/;
const WILDCARD = /[*?]/;

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

const compiledPatterns = new Map<string, RegExp>();

function compileGlob(pattern: string): RegExp {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;
  // 模式里的反斜杠也当分隔符：`src\*.foo` 与 `src/*.foo` 等价。
  const compiled = new RegExp(`^${globToRegExpSource(pattern.replace(/\\/g, "/"))}$`, "i");
  compiledPatterns.set(pattern, compiled);
  return compiled;
}

/** 归一化路径：统一分隔符并转小写，让匹配不受平台与大小写影响。 */
export function normalizeFilesEditorPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 模式不含分隔符时只比文件名，含分隔符时比整条路径。 */
function filesEditorGlobTarget(pattern: string, candidatePath: string): string {
  if (PATH_SEPARATOR.test(pattern)) return candidatePath;
  const parts = candidatePath.split(PATH_SEPARATOR);
  return parts[parts.length - 1] ?? candidatePath;
}

export function filesEditorGlobMatches(pattern: string, candidatePath: string): boolean {
  if (!pattern || !candidatePath) return false;
  return compileGlob(pattern).test(filesEditorGlobTarget(pattern, candidatePath));
}

/** 键里带通配符才算模式，否则按精确路径处理。 */
export function isFilesEditorGlobPattern(key: string): boolean {
  return WILDCARD.test(key);
}
