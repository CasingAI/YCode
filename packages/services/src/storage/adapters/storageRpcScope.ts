import type { IStorageService } from "../contract.js";

/** 每条 attachment 仅记取消凭据，不复制 owner 的扫描状态；不暴露生命周期方法。 */
export function createStorageRpcScope(owner: IStorageService) {
  let disposed = false;
  let jobId: string | null = null;
  let revision = 0;
  const service = {
    async startScan() {
      if (disposed) throw new Error("storage attachment closed");
      const current = ++revision;
      const result = await owner.startScan();
      if (disposed || current !== revision) {
        await owner.cancelScan(result.jobId);
      } else {
        jobId = result.jobId;
      }
      return result;
    },
    async cancelScan(id: string) {
      if (disposed || id !== jobId) return;
      jobId = null;
      await owner.cancelScan(id);
    },
    getSnapshot: () => {
      if (disposed)
        return Promise.reject(new Error("storage attachment closed"));
      return owner.getSnapshot();
    },
    clean: (request: Parameters<IStorageService["clean"]>[0]) => {
      if (disposed)
        return Promise.reject(new Error("storage attachment closed"));
      return owner.clean(request);
    },
    onScanProgress: owner.onScanProgress,
  };
  return {
    service,
    dispose() {
      if (disposed) return;
      disposed = true;
      revision += 1;
      if (jobId) void owner.cancelScan(jobId).catch(() => undefined);
      jobId = null;
    },
  };
}
