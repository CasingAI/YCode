import os from "node:os";
import {
  formatZCodeHostProcessName,
  type ResourceUsageProcess,
  type ResourceUsageSamplingStatus,
  type ResourceUsageSnapshot,
} from "@zcode/shared";
import {
  attributeHostProcessTree,
  type HostResourceUsageAgent,
} from "../hostProcessAttribution.js";
import {
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "../processResourceSampler.js";
import type { IResourceUsageService } from "./resourceUsage.js";

/**
 * 提供本宿主内 Agent 后代信息的最小端口。
 *
 * 由 Agent 服务实现（`collectLocalRuntimeChildProcesses`），这里只声明用到的形状，
 * 避免资源采样模块反向依赖整个 Agent 服务。
 */
export interface ResourceUsageAgentSource {
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<readonly HostResourceUsageAgent[]>;
}

export interface CreateResourceUsageServiceOptions {
  /** 进程树根，默认当前进程。Web 端即 Server 进程。 */
  hostPid?: number;
  /** 惰性获取 Agent 服务：装配期存在循环依赖，不能提前持有实例。 */
  getAgentService?: () => ResourceUsageAgentSource | undefined;
  sampler?: ProcessResourceSampler;
  now?: () => number;
}

/** 系统整机 CPU：两次 os.cpus() 之间 busy / total 的差分 */
interface SystemCpuMeter {
  read(): number;
}

function createSystemCpuMeter(): SystemCpuMeter {
  let previous: { busy: number; total: number } | null = null;

  return {
    read() {
      const cpus = os.cpus();
      let busy = 0;
      let total = 0;
      for (const cpu of cpus) {
        for (const [key, value] of Object.entries(cpu.times)) {
          total += value;
          if (key !== "idle") busy += value;
        }
      }
      const current = { busy, total };
      const baseline = previous;
      previous = current;
      // 首个快照没有基线，差分无从谈起，记 0 而不是伪造一个峰值。
      if (!baseline || current.total <= baseline.total) return 0;
      const percent = ((current.busy - baseline.busy) / (current.total - baseline.total)) * 100;
      return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    },
  };
}

function toHostProcessRow(
  pid: number,
  sample: { cpuPercent: number; rssKb: number } | undefined,
): ResourceUsageProcess {
  return {
    pid,
    name: formatZCodeHostProcessName(),
    category: "base",
    groupKey: "host",
    groupLabel: "host",
    cpuPercent: sample?.cpuPercent ?? 0,
    memoryBytes: (sample?.rssKb ?? 0) * 1024,
    sampled: Boolean(sample),
  };
}

/**
 * 宿主侧资源采样服务。
 *
 * 采样链路与服务端运行时一致：读整机进程表 → 按宿主子树归属 → 组装快照。
 * 桌面端的 Chromium 进程指标在 Main 侧，不在这条链路上。
 */
export function createResourceUsageService(
  options: CreateResourceUsageServiceOptions = {},
): IResourceUsageService {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  const cpuMeter = createSystemCpuMeter();

  return {
    async getSnapshot(): Promise<ResourceUsageSnapshot> {
      const source = options.getAgentService?.();
      // 进程表与 Agent 来源互相独立：并行读取，来源失败只降级会话标注，
      // 不阻塞本机 PPID 归属，也不能把来源失败扩散成整轮采样失败。
      const [samples, agents] = await Promise.all([
        sampler.sample().catch(() => undefined),
        source ? source.collectLocalRuntimeChildProcesses().catch(() => []) : Promise.resolve([]),
      ]);
      // Host 自身样本是整机指标闭合的必要条件；缺失时不能报 complete，
      // 否则前端会把“未采到”当成真实 0 用量。
      const samplingStatus: ResourceUsageSamplingStatus =
        samples && samples.has(hostPid) ? "complete" : "failed";

      const processes: ResourceUsageProcess[] = [];
      if (samples) {
        // 宿主自身不在归属结果里（桌面上由 Main 的 Electron 指标提供），这里单独补一行。
        processes.push(toHostProcessRow(hostPid, samples.get(hostPid)));
        processes.push(
          ...attributeHostProcessTree({
            samples,
            hostPid,
            agents,
          }).map((row) => ({ ...row, sampled: true })),
        );
      }

      const memoryTotalBytes = os.totalmem();
      const memoryUsedBytes = Math.max(0, memoryTotalBytes - os.freemem());

      // shared 的可选 samplingStatus 是快照完整度的唯一标记；
      // failed 时前端必须显示占位，不能把缺失行当作真实 0。
      return {
        sampledAt: now(),
        logicalCpuCount: Math.max(1, os.cpus().length),
        system: {
          cpuPercent: cpuMeter.read(),
          memoryTotalBytes,
          memoryUsedBytes,
        },
        app: {
          cpuPercent: roundPercent(processes.reduce((sum, process) => sum + process.cpuPercent, 0)),
          memoryBytes: processes.reduce((sum, process) => sum + process.memoryBytes, 0),
        },
        processes,
        samplingStatus,
      };
    },
  };
}

function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}
