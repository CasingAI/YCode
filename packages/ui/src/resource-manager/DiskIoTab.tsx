import { useEffect, useState } from "react";
import type { DiskIoSnapshot } from "@zcode/shared";
import { DiskIoTabContent } from "./DiskIoTabContent.js";
import type { DiskIoModuleFilter, DiskIoProcessFilter } from "./diskIoView.js";

const DISK_IO_REFRESH_INTERVAL_MS = 2_000;

export interface DiskIoTabProps {
  getDiskIoSnapshot?: () => Promise<DiskIoSnapshot>;
  refreshIntervalMs?: number;
}

/** 磁盘页唯一的快照、筛选与采样 owner；响应式视图只消费这些状态。 */
export function DiskIoTab({
  getDiskIoSnapshot,
  refreshIntervalMs = DISK_IO_REFRESH_INTERVAL_MS,
}: DiskIoTabProps) {
  const [snapshot, setSnapshot] = useState<DiskIoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processFilter, setProcessFilter] = useState<DiskIoProcessFilter>("all");
  const [moduleFilter, setModuleFilter] = useState<DiskIoModuleFilter>("all");

  useEffect(() => {
    if (!getDiskIoSnapshot) return;
    let disposed = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getDiskIoSnapshot!();
        if (!disposed) {
          setSnapshot(next);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [getDiskIoSnapshot, refreshIntervalMs]);

  return (
    <DiskIoTabContent
      snapshot={snapshot}
      error={error}
      available={getDiskIoSnapshot !== undefined}
      refreshIntervalMs={refreshIntervalMs}
      processFilter={processFilter}
      moduleFilter={moduleFilter}
      setProcessFilter={setProcessFilter}
      setModuleFilter={setModuleFilter}
    />
  );
}
