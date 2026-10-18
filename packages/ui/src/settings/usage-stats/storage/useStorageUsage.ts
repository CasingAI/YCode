/**
 * 设置页使用当前连接宿主的 StorageManagementBridge。进度只接受本面板 job，
 * Web 重连或面板关闭使旧 generation 失效；不重发已提交的 clean。
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
  const revisionRef = useRef(0);

  const start = useCallback(async () => {
    if (!bridge) return;
    const revision = ++revisionRef.current;
    // 新扫描开始时旧 job 的事件不再属于本面板；仅最新返回的 job 可更新 UI。
    jobIdRef.current = null;
    setScanning(true);
    try {
      const { jobId } = await bridge.startScan();
      if (revision !== revisionRef.current) {
        // 请求未返回时页面可能已经切走；迟到的 job 不能重新激活页面。
        await bridge.cancelScan(jobId);
        return;
      }
      jobIdRef.current = jobId;
      // 终态可能在 startScan 回复前广播；补读 owner 快照修复丢失的终态。
      const current = await bridge.getSnapshot();
      if (revision !== revisionRef.current) return;
      if (current?.jobId === jobId) {
        setSnapshot(current);
        if (current.status !== "scanning") {
          jobIdRef.current = null;
          setScanning(false);
        }
      }
    } catch (error) {
      if (revision === revisionRef.current) {
        logger.warn("[storage] startScan failed", { error });
        jobIdRef.current = null;
        setScanning(false);
      }
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    ++revisionRef.current;
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
    const subscription = bridge.subscribeScanProgress((next) => {
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
      .catch((error) => {
        logger.warn("[storage] getSnapshot failed", { error });
      });
    void start();
    return () => {
      disposed = true;
      subscription();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      if (!bridge) throw new Error("storage bridge unavailable");
      await cancel();
      const result = await bridge.clean(request);
      // 成功清理后显式扫描；未知结果的调用不会自动重发。
      await start();
      return result;
    },
    [bridge, cancel, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
