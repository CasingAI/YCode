import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import type { IStorageService } from "@zcode/services";
import type {
  StorageHostRequest,
  StorageHostResult,
  StorageUsageSnapshot,
} from "@zcode/shared";

/** Window Host 只持有关联请求与订阅，扫描/清理仍属于 Main 唯一实例。 */
export function createStorageMainBridge(
  post: (message: StorageHostRequest) => void,
) {
  const progress = new Emitter<StorageUsageSnapshot>();
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let disposed = false;
  const call = <T>(command: StorageHostRequest["command"]): Promise<T> => {
    if (disposed) return Promise.reject(new Error("storage host closed"));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        post({ type: "storage-request", requestId, command });
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  };
  const service: IStorageService = {
    startScan: () => call<{ jobId: string }>({ method: "startScan" }),
    cancelScan: (id) => call<void>({ method: "cancelScan", jobId: id }),
    getSnapshot: () => call({ method: "getSnapshot" }),
    clean: (request) => call({ method: "clean", request }),
    onScanProgress: progress.event,
    dispose() {
      if (disposed) return;
      // 真正的取消凭据属于各 RPC attachment；Host 退出时 Main relay 负责收口。
      disposed = true;
      for (const entry of pending.values())
        entry.reject(new Error("storage host closed"));
      pending.clear();
      progress.dispose();
    },
  };
  return {
    service,
    handleResult(message: StorageHostResult) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.outcome.ok) entry.resolve(message.outcome.result);
      else entry.reject(new Error(message.outcome.error));
    },
    handleProgress(snapshot: StorageUsageSnapshot) {
      if (!disposed) progress.fire(snapshot);
    },
  };
}
