import {
  filesLargeTextWindowEntries as entries,
  nextFilesLargeTextWindowGeneration,
  publishFilesLargeTextWindowSnapshot,
  sameFilesLargeTextWindowOwner as sameOwner,
} from "@/files-workbench/filesLargeTextWindowContext.js";
import { createFilesLargeTextWindowEntry } from "@/files-workbench/filesLargeTextWindowEntry.js";
import { applyFilesLargeTextFailure } from "@/files-workbench/filesLargeTextWindowCoreRetry.js";
import { createIdleFilesLargeTextWindowSnapshot } from "@/files-workbench/filesLargeTextWindowTypes.js";
import type { FilesLargeTextWindowOwner } from "@/files-workbench/filesLargeTextWindowTypes.js";

/**
 * core 首次读取决策失败（例如恢复时离线）时通知该 owner 的唯一 entry。
 * `retry` 是统一 core loader：viewer 重试 / 刷新会重新走大小、二进制与编码决策，
 * 不直接按窗口读取。entry 尚不存在时先建立，等 viewer acquire 后展示错误。
 */
export function failFilesLargeTextWindow(
  owner: FilesLargeTextWindowOwner,
  error: unknown,
  retry: () => void | Promise<void>,
): void {
  let entry = entries.get(owner.bufferId);
  if (!entry || !sameOwner(entry.owner, owner)) {
    entry = createFilesLargeTextWindowEntry({
      owner,
      generation: nextFilesLargeTextWindowGeneration(),
      snapshot: createIdleFilesLargeTextWindowSnapshot(),
      readWindow: async () => {
        throw new Error("files-large-text-reader-not-bound");
      },
    });
    entries.set(owner.bufferId, entry);
  } else {
    // 使可能仍在途的直接窗口请求失效，避免迟到结果覆盖失败提示。
    entry.requestSeq += 1;
  }
  applyFilesLargeTextFailure({
    entry,
    error,
    retry,
    publish: (snapshot) => publishFilesLargeTextWindowSnapshot(entry, snapshot),
  });
}
