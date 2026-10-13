import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

export interface BotDroppedFile {
  name: string;
  mime: string;
  bytes: number;
  path?: string;
}

export type BotDropIntake =
  | { kind: "empty" }
  | { kind: "folders"; paths: string[] }
  | { kind: "files"; files: BotDroppedFile[] };

function looksLikeFolder(file: File): boolean {
  return !file.type && file.size === 0;
}

export function pathFromFileUri(raw: string): string | undefined {
  const line = raw.trim().split(/\r?\n/u)[0]?.trim();
  if (!line) {
    return undefined;
  }
  if (line.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(line)) {
    return line;
  }
  if (!line.startsWith("file:")) {
    return undefined;
  }
  try {
    const url = new URL(line);
    if (url.protocol !== "file:") {
      return undefined;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/u.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || undefined;
  } catch {
    return undefined;
  }
}

export function classifyBotDrop(input: {
  files: readonly File[];
  uriList?: string;
  getPathForFile?: (file: File) => string | undefined;
}): BotDropIntake {
  const folderPaths: string[] = [];
  const droppedFiles: BotDroppedFile[] = [];
  for (const file of input.files) {
    const path = input.getPathForFile?.(file)?.trim() || undefined;
    if (looksLikeFolder(file)) {
      if (path) {
        folderPaths.push(path);
      }
      continue;
    }
    droppedFiles.push({
      name: file.name,
      mime: file.type || "application/octet-stream",
      bytes: file.size,
      ...(path ? { path } : {}),
    });
  }
  if (folderPaths.length > 0) {
    return { kind: "folders", paths: folderPaths };
  }
  if (droppedFiles.length > 0) {
    return { kind: "files", files: droppedFiles };
  }
  const fromUri = input.uriList ? pathFromFileUri(input.uriList) : undefined;
  if (fromUri) {
    return { kind: "folders", paths: [fromUri] };
  }
  return { kind: "empty" };
}

export function droppedFilesToAttachments(files: readonly BotDroppedFile[]): AttachmentRef[] {
  return files.flatMap((file) => {
    if (!file.path) {
      return [];
    }
    return [
      {
        ref: file.path,
        fileName: file.name,
        mime: file.mime,
        bytes: file.bytes,
      },
    ];
  });
}
