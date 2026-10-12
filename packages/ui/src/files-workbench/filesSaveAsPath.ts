import { joinFilePath } from "@/lib/path.js";

export function filesParentDirectory(path: string): string | undefined {
  const normalized = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (separatorIndex <= 0) {
    return undefined;
  }
  if (/^[A-Za-z]:\\/.test(normalized) && separatorIndex === 2) {
    return undefined;
  }
  const parent = normalized.slice(0, separatorIndex);
  return parent.length > 0 ? parent : undefined;
}

export function filesSaveAsTargetPath(directory: string, fileName: string): string | undefined {
  const name = fileName.trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return undefined;
  }
  return joinFilePath(directory, name);
}
