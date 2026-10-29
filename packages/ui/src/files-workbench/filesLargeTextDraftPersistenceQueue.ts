import {
  createFilesLargeTextDraftRecord,
  type FilesLargeTextDraftOperation,
  type FilesLargeTextDraftQueue,
  type FilesLargeTextDraftStorage,
} from "@/files-workbench/filesLargeTextDraftStorage.js";
import type { FilesLargeTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/** 按 buffer 串行写入的 IO 队列；快照、blocked 与 owner 仍由主 controller 所有。 */
export class FilesLargeTextDraftPersistenceQueue {
  private readonly queues = new Map<string, FilesLargeTextDraftQueue>();

  constructor(
    private readonly storage: FilesLargeTextDraftStorage,
    private readonly onPendingChange: (bufferId: string, pending: boolean) => void,
    private readonly onOperationError: (
      bufferId: string,
      operation: "save" | "delete",
      error: unknown,
    ) => void,
    private readonly onOperationSuccess: (bufferId: string) => void,
  ) {}

  clearPending(bufferId: string): void {
    const queue = this.queues.get(bufferId);
    if (queue) queue.pending = undefined;
  }

  enqueue(bufferId: string, operation: FilesLargeTextDraftOperation): void {
    let queue = this.queues.get(bufferId);
    if (!queue) {
      queue = { running: false, tail: Promise.resolve() };
      this.queues.set(bufferId, queue);
    }
    // 只保留最新待执行操作：旧 write 不会覆盖后到的 delete。
    queue.pending = operation;
    if (!queue.running) {
      queue.running = true;
      queue.tail = this.drain(bufferId, queue);
    }
    this.onPendingChange(bufferId, true);
  }

  enqueueWrite(buffer: FilesLargeTextBuffer, updatedAt: number): void {
    if (!buffer.edit) return;
    const record = createFilesLargeTextDraftRecord(buffer, buffer.edit, updatedAt);
    if (record) this.enqueue(buffer.id, { kind: "write", record, edit: buffer.edit });
  }

  enqueueDelete(bufferId: string, storageKey: string): void {
    this.enqueue(bufferId, { kind: "delete", storageKey });
  }

  private async drain(bufferId: string, queue: FilesLargeTextDraftQueue): Promise<void> {
    while (queue.pending) {
      const operation = queue.pending;
      queue.pending = undefined;
      try {
        if (operation.kind === "write") await this.storage.save(operation.record);
        else await this.storage.delete(operation.storageKey);
        this.onOperationSuccess(bufferId);
      } catch (error) {
        this.onOperationError(bufferId, operation.kind === "write" ? "save" : "delete", error);
      }
    }
    queue.running = false;
    this.onPendingChange(bufferId, false);
  }

  hasPending(): boolean {
    return [...this.queues.values()].some((queue) => queue.running || queue.pending);
  }

  async flush(): Promise<void> {
    while (this.hasPending()) {
      await Promise.all([...this.queues.values()].map((queue) => queue.tail));
    }
  }
}
