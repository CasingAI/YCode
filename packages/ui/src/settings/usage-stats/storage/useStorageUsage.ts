/**
 * useStorageUsage —— 设置页「数据与统计 › 存储」分区的数据源，输入是 IPlatformService.storage 桥。
 * 生命周期与面板可见性绑定：enabled 时开始扫描并订阅进度，卸载 / 面板切走时取消。
 * 只消费当前 jobId 的快照，旧 job 的尾包直接丢弃；进入时先展示上次完成的快照（stale-while-revalidate）。
 *
 * 取消时机只看「用户是否还在看这个面板」，不看窗口焦点：本面板挂在主窗口里，用户切去访达复制路径
 * 是常态，早期版本挂在资源管理器窗口上时的「失焦 60s 取消」在这里只会让扫描被反复打断重跑。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";

interface StorageUsageState {
  snapshot: StorageUsageSnapshot | null;
  scanning: boolean;
  rescan: () => Promise<void>;
  clean: (request: StorageCleanRequest) => Promise<StorageCleanResult>;
}

export function useStorageUsage({
  bridge,
  enabled,
}: {
  bridge: StorageManagementBridge | undefined;
  enabled: boolean;
}): StorageUsageState {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    if (!bridge) return;
    try {
      const { jobId } = await bridge.startScan();
      jobIdRef.current = jobId;
      setScanning(true);
    } catch (error) {
      logger.warn("[storage] startScan failed", { error });
      setScanning(false);
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    setScanning(false);
    if (!jobId || !bridge) return;
    try {
      await bridge.cancelScan(jobId);
    } catch (error) {
      logger.warn("[storage] cancelScan failed", { error, jobId });
    }
  }, [bridge]);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.subscribeScanProgress((next) => {
      if (disposed || next.jobId !== jobIdRef.current) return;
      setSnapshot(next);
      if (next.status !== "scanning") {
        jobIdRef.current = null;
        setScanning(false);
      }
    });
    void bridge
      .getSnapshot()
      .then((previous) => {
        if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);
      })
      .catch(() => {});
    void start();
    return () => {
      disposed = true;
      unsubscribe();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      if (!bridge) throw new Error("storage bridge unavailable");
      jobIdRef.current = null;
      setScanning(false);
      const result = await bridge.clean(request);
      await start();
      return result;
    },
    [bridge, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
