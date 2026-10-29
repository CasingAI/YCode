import type { FilesLargeTextWindowEntry } from "@/files-workbench/filesLargeTextWindowEntry.js";
import type {
  FilesLargeTextWindowOwner,
  FilesLargeTextWindowSnapshot,
} from "@/files-workbench/filesLargeTextWindowTypes.js";

/** 每个 buffer 唯一窗口 entry；store、seed 与失败通知共享同一份状态。 */
export const filesLargeTextWindowEntries = new Map<string, FilesLargeTextWindowEntry>();

let generationSerial = 0;

export function nextFilesLargeTextWindowGeneration(): number {
  generationSerial += 1;
  return generationSerial;
}

export function sameFilesLargeTextWindowOwner(
  left: FilesLargeTextWindowOwner,
  right: FilesLargeTextWindowOwner,
): boolean {
  return (
    left.bufferId === right.bufferId &&
    left.workspaceKey === right.workspaceKey &&
    left.remoteSessionId === right.remoteSessionId &&
    left.path === right.path
  );
}

export function notifyFilesLargeTextWindow(entry: FilesLargeTextWindowEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

/** 写入唯一 snapshot 并通知所有分屏订阅者。 */
export function publishFilesLargeTextWindowSnapshot(
  entry: FilesLargeTextWindowEntry,
  snapshot: FilesLargeTextWindowSnapshot,
): void {
  entry.snapshot = snapshot;
  notifyFilesLargeTextWindow(entry);
}
