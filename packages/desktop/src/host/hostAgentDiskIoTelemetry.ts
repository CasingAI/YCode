import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostAgentDiskIoTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicDiskIoBatch">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}

/** 只透传本机 Agent 的聚合批次；远端 workspace 的磁盘活动不进入本机资源管理器。 */
export function registerHostAgentDiskIoTelemetry(
  options: RegisterHostAgentDiskIoTelemetryOptions,
): IDisposable {
  if (options.runtimeSurface !== "local") return { dispose() {} };
  return options.agentService.onDynamicDiskIoBatch()((batch) => {
    try {
      const { lane: _lane, ...metricsBatch } = batch;
      options.postMessage({ type: HostResponseTypes.AgentDiskIoBatch, batch: metricsBatch });
    } catch {
      // main 已退出或 IPC 不可用时只丢当前批次，不影响 Agent 通知分发。
    }
  });
}
