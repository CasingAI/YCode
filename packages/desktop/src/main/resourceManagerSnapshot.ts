import type {
  ResourceUsageProcess,
  ResourceUsageSamplingStatus,
  ResourceUsageSnapshot,
} from "@zcode/shared";
import type { HostResourceUsageRequestResult } from "./resourceManagerHostSampling.js";

interface ResourceUsageProcessSummary {
  processes: ResourceUsageProcess[];
  app: ResourceUsageSnapshot["app"];
  samplingStatus: ResourceUsageSamplingStatus;
}

/** 合并仅派生展示数据；Host 的在途请求与成功缓存仍由采样 owner 持有。 */
export function buildResourceUsageProcessSummary(
  electronProcesses: readonly ResourceUsageProcess[],
  hostResults: readonly HostResourceUsageRequestResult[],
  registeredAgents: readonly ResourceUsageProcess[],
): ResourceUsageProcessSummary {
  const processesByPid = new Map<number, ResourceUsageProcess>();
  for (const row of electronProcesses) {
    if (!processesByPid.has(row.pid)) processesByPid.set(row.pid, row);
  }
  for (const result of hostResults) {
    for (const row of result.processes) {
      if (processesByPid.has(row.pid)) continue;
      // 旧缓存只保留进程身份，不能把上次的 CPU / 内存伪装成本轮已采样值。
      processesByPid.set(row.pid, { ...row, sampled: result.samplingStatus === "complete" });
    }
  }
  for (const row of registeredAgents) {
    if (!processesByPid.has(row.pid)) processesByPid.set(row.pid, row);
  }

  const processes = [...processesByPid.values()];
  let samplingStatus: ResourceUsageSamplingStatus = "complete";
  if (hostResults.some((result) => result.samplingStatus === "failed")) samplingStatus = "failed";
  else if (hostResults.some((result) => result.samplingStatus === "stale"))
    samplingStatus = "stale";
  else if (
    hostResults.some((result) => result.samplingStatus === "pending") ||
    processes.some((row) => !row.sampled)
  ) {
    samplingStatus = "pending";
  }

  const totals = processes.reduce(
    (total, row) => {
      if (!row.sampled) return total;
      total.cpuPercent += row.cpuPercent;
      total.memoryBytes += row.memoryBytes;
      return total;
    },
    { cpuPercent: 0, memoryBytes: 0 },
  );
  return {
    processes,
    app: {
      cpuPercent: Math.round(totals.cpuPercent * 10) / 10,
      memoryBytes: totals.memoryBytes,
    },
    samplingStatus,
  };
}
