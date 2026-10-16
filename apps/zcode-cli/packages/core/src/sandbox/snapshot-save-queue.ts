import type { FileSystemPort, SandboxLocalStorageSnapshot, SessionId } from "@zcode/contracts";
import { saveSandboxLocalStorageSnapshot } from "./local-storage-store.js";

interface SnapshotSaveDeps {
  sandboxStorageRoot: string | undefined;
  fileSystemPort: FileSystemPort | undefined;
}

export class SandboxSnapshotSaveQueue {
  private readonly pending = new Map<SessionId, Promise<void>>();

  constructor(private readonly getDeps: () => SnapshotSaveDeps) {}

  /** 保存失败保持非致命；重置仍须继续创建新实例，后续写入可再次尝试。 */
  async save(
    sessionId: SessionId,
    snapshot: SandboxLocalStorageSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const save = previous
      .catch(() => undefined)
      .then(() =>
        saveSandboxLocalStorageSnapshot({
          ...this.getDeps(),
          sessionId,
          snapshot,
          signal,
        }),
      )
      .catch(() => undefined);
    this.pending.set(sessionId, save);
    try {
      await save;
    } finally {
      if (this.pending.get(sessionId) === save) this.pending.delete(sessionId);
    }
  }

  waitFor(sessionId: SessionId): Promise<void> | undefined {
    return this.pending.get(sessionId);
  }
}
