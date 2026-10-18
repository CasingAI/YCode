import type {
  StorageManagementApi,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";

type StorageRpcService = StorageManagementApi & {
  onScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): {
    dispose(): void;
  };
};

/** Web/手机只通过授权的宿主 RPC 管理存储；不暴露本地路径定位能力。 */
export function createWebStorageBridge(
  service: StorageRpcService,
): StorageManagementBridge {
  return {
    startScan: () => service.startScan(),
    cancelScan: (jobId) => service.cancelScan(jobId),
    getSnapshot: () => service.getSnapshot(),
    clean: (request) => service.clean(request),
    subscribeScanProgress(listener) {
      const subscription = service.onScanProgress(listener);
      return () => subscription.dispose();
    },
  };
}
