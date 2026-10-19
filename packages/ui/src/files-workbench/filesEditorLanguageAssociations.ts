import {
  filesEditorGlobMatches,
  isFilesEditorGlobPattern,
  normalizeFilesEditorPath,
} from "@/files-workbench/filesEditorLanguageGlob.js";

/**
 * 用户文件关联的匹配。
 *
 * 关联表是 `Record<string, string>`：键是模式或路径，值是 Monaco 语言 id。
 * 键的两种形态：
 * - 含通配符（`*` / `?`）→ 模式，命中任意匹配路径；
 * - 不含通配符 → 精确路径，命中完整路径或文件名。
 *
 * 匹配顺序：精确路径优先于模式；同类之间取更长的键，长度相同时取字典序靠前者，
 * 保证同一份关联表在任何机器上解析结果一致。
 */
export interface FilesEditorAssociationMatch {
  languageId: string;
  key: string;
  kind: "file" | "pattern";
}

function pickBetter(
  current: FilesEditorAssociationMatch | undefined,
  candidate: FilesEditorAssociationMatch,
): FilesEditorAssociationMatch {
  if (!current) return candidate;
  if (candidate.key.length !== current.key.length) {
    return candidate.key.length > current.key.length ? candidate : current;
  }
  return candidate.key < current.key ? candidate : current;
}

export function matchFilesEditorAssociation(
  associations: Readonly<Record<string, string>> | undefined,
  path: string | undefined,
): FilesEditorAssociationMatch | undefined {
  if (!associations || !path) return undefined;

  const normalizedPath = normalizeFilesEditorPath(path);
  const baseName = normalizedPath.split("/").pop() ?? normalizedPath;

  let fileMatch: FilesEditorAssociationMatch | undefined;
  let patternMatch: FilesEditorAssociationMatch | undefined;

  for (const [key, languageId] of Object.entries(associations)) {
    if (!languageId) continue;
    if (isFilesEditorGlobPattern(key)) {
      if (!filesEditorGlobMatches(key, normalizedPath)) continue;
      patternMatch = pickBetter(patternMatch, { languageId, key, kind: "pattern" });
      continue;
    }
    const normalizedKey = normalizeFilesEditorPath(key);
    if (normalizedKey !== normalizedPath && normalizedKey !== baseName) continue;
    fileMatch = pickBetter(fileMatch, { languageId, key, kind: "file" });
  }

  return fileMatch ?? patternMatch;
}

/**
 * 给「按模式保存」用的键：有扩展名时用 `*.ext`（命中所有同后缀文件），
 * 没有扩展名时退回文件名本身（此时是精确键，只影响同名文件）。
 */
export function filesEditorAssociationPatternForPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fileName.length - 1) {
    return `*.${fileName.slice(dotIndex + 1).toLowerCase()}`;
  }
  return fileName;
}
