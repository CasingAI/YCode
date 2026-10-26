import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSamplingStatus,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Host 直管的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * 资源管理器 Host 侧响应器。
 * 只在 main 发来请求时采样一次：读整机进程表 → 向每个本地 Agent 要 MCP 子进程映射 → 按 Host 子树归属 → 回帖。
 * 成功和失败都必须显式回帖；最多执行一轮，不保存采样队列；关窗取消后不发布迟到结果。
 */
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  const postResult = (
    requestId: string,
    processes: HostResourceUsageSnapshotResultResponse["processes"],
    samplingStatus: HostResourceUsageSamplingStatus,
  ): void => {
    try {
      options.postMessage({
        type: HostResponseTypes.ResourceUsageSnapshotResult,
        requestId,
        sampledAt: now(),
        processes,
        samplingStatus,
      });
    } catch {
      // 回帖失败只丢弃本轮，不能以未处理异常影响 Host 生命周期。
    }
  };

  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    let failed = false;
    const agentService = options.getAgentService();
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => {
        failed = true;
        return undefined;
      }),
      agentService
        ? // 来源元数据只用于分组和会话标注，失败不影响 PPID 后代采样，不能据此判整轮失败。
          agentService.collectLocalRuntimeChildProcesses(signal).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    // 采样失败、或进程表里根本没有 Host 自身时，不能把空表当成成功的完整结果。
    const complete = !failed && samples !== undefined && samples.has(hostPid);
    postResult(message.requestId, processes, complete ? "complete" : "failed");
  }

  return {
    async handleRequest(message) {
      let current: typeof active;
      try {
        // Main 展示超时不代表底层结束，不能把每秒查询变成无界 FIFO。
        if (active) {
          // 已有采样在途时明确回失败，不能返回看似成功的空进程表。
          postResult(message.requestId, [], "failed");
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // 意外异常也显式失败，避免 Main 按 complete 的空表处理。
        if (current && !current.controller.signal.aborted) {
          postResult(current.requestId, [], "failed");
        }
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
