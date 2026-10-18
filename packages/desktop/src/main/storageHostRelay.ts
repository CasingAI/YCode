import { createStorageRpcScope } from "@zcode/services/node";
import type { IStorageService } from "@zcode/services";
import type {
  StorageHostRequest,
  StorageHostResult,
  StorageHostProgress,
} from "@zcode/shared";

export function createStorageHostRelay(
  owner: IStorageService,
  post: (message: StorageHostResult | StorageHostProgress) => void,
) {
  const scope = createStorageRpcScope(owner);
  let disposed = false;
  const subscription = owner.onScanProgress((snapshot) => {
    if (disposed) return;
    try {
      post({ type: "storage-progress", snapshot });
    } catch {
      // Host 已退出；它的消息转发失败不得打断 Main 存储 owner 的扫描广播。
    }
  });
  return {
    async handle(message: StorageHostRequest) {
      const { command, requestId } = message;
      try {
        const result =
          command.method === "startScan"
            ? await scope.service.startScan()
            : command.method === "getSnapshot"
              ? await scope.service.getSnapshot()
              : command.method === "clean"
                ? await scope.service.clean(command.request)
                : await scope.service.cancelScan(command.jobId);
        if (!disposed)
          post({
            type: "storage-result",
            requestId,
            outcome: { ok: true, result: result ?? null },
          });
      } catch (error) {
        if (!disposed)
          post({
            type: "storage-result",
            requestId,
            outcome: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
      }
    },
    dispose() {
      disposed = true;
      subscription.dispose();
      scope.dispose();
    },
  };
}
