import {
  installNodeDiskIoInstrumentation,
  type NodeDiskIoInstrumentation,
} from "@zcode/shared/node";
import { diskIoMetricBatchSchema, type DiskIoMetricBatch } from "@zcode/shared";

const MAX_EARLY_BATCHES = 12;
const isRemoteRuntime = process.env.ZCODE_TELEMETRY_RUNTIME_SURFACE === "remote_workspace_host";
let sink: ((batch: DiskIoMetricBatch) => void | Promise<void>) | undefined;
const earlyBatches: DiskIoMetricBatch[] = [];

function enqueueOrSend(batch: DiskIoMetricBatch): void {
  if (sink) {
    void Promise.resolve(sink(batch)).catch(() => {
      // IPC/协议断开时只丢失当前内存增量，不影响 Agent 的业务任务。
    });
    return;
  }
  earlyBatches.push(batch);
  while (earlyBatches.length > MAX_EARLY_BATCHES) earlyBatches.shift();
}

// SQLite 只读工作线程把自己的逻辑操作批次发给 Agent 主线程；OS 级计数仍由进程主线程采集。
const onWorkerBatch = (untrustedBatch: unknown) => {
  if (isRemoteRuntime) return;
  const parsed = diskIoMetricBatchSchema.safeParse(untrustedBatch);
  if (parsed.success) enqueueOrSend(parsed.data);
};
process.on("zcode:disk-io-worker-batch", onWorkerBatch);

// 远端 workspace 的 I/O 不应进入本机仪表盘，也不经此链路向桌面上报。
const instrumentation: NodeDiskIoInstrumentation | undefined = isRemoteRuntime
  ? undefined
  : installNodeDiskIoInstrumentation({
      intervalMs: 5_000,
      onBatch: (batch) => enqueueOrSend(batch),
    });

export function startDiskIoProtocolReporting(
  send: (batch: DiskIoMetricBatch) => void | Promise<void>,
): void {
  if (!instrumentation) return;
  sink = send;
  while (earlyBatches.length > 0) {
    const batch = earlyBatches.shift();
    if (batch) {
      try {
        void Promise.resolve(sink(batch)).catch(() => {
          // 协议发送失败时只丢失当前内存增量。
        });
      } catch {
        // 同步发送失败时只丢失当前内存增量。
      }
    }
  }
}

export function stopDiskIoProtocolReporting(): void {
  instrumentation?.stop();
  process.off("zcode:disk-io-worker-batch", onWorkerBatch);
  sink = undefined;
  earlyBatches.length = 0;
}
