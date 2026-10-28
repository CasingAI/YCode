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

/**
 * 系统另存为对话框的默认路径：当前目录 + 当前文件名。
 *
 * 文件名不可作为目标（为空或含路径分隔符）时只使用当前目录；目录也无效时不传默认路径，
 * 让系统组件使用自己的默认位置。
 */
export function filesSaveAsDefaultPath(directory: string, fileName: string): string | undefined {
  const targetPath = filesSaveAsTargetPath(directory, fileName);
  if (targetPath) {
    // 没有当前目录时不要把文件名拼成根目录文件，只把文件名交给系统组件作建议名。
    return directory.trim() ? targetPath : fileName.trim();
  }
  const trimmedDirectory = directory.trim();
  return trimmedDirectory || undefined;
}
