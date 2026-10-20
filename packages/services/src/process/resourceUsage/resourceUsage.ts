import type { ResourceUsageSnapshot } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../../descriptors.js";

/**
 * 宿主进程资源采样服务。
 *
 * 资源管理器的数据源：宿主自己采整机指标与自身进程树，客户端只发请求。
 * Desktop 的 Chromium 进程指标留在 Main 侧，不在这条链路上。
 */
export interface IResourceUsageService {
  /** 采样一次宿主进程树与整机指标，返回完整快照。 */
  getSnapshot(): Promise<ResourceUsageSnapshot>;
}

export const IResourceUsageService = createServiceDescriptor<IResourceUsageService>(
  ServiceChannels.ResourceUsage,
);
