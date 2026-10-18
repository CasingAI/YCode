/**
 * storage 模块公开契约：资源管理器「存储」tab 使用的服务接口与类型再导出。
 * 只允许从这里 import；实现细节（Worker、fs、catalog 规则）都在模块内部。
 */
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "../descriptors.js";
import type { StorageManagementApi, StorageUsageSnapshot } from "@zcode/shared";

// 数据类型的唯一事实源在 @zcode/shared（renderer 桥与 main 共用）；这里再导出方便 services 内部引用。
export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanRequest,
  StorageCleanResult,
  StorageCleanability,
  StorageEntryUsage,
  StorageManagementApi,
  StoragePathError,
  StorageRootId,
  StorageRootSpec,
  StorageRootUsage,
  StorageScanStatus,
  StorageUsageSnapshot,
  StorageVolume,
  StorageVolumeGroup,
} from "@zcode/shared";

/** 宿主存储管理；Desktop Main 或独立 Server 持有唯一实例，RPC 不暴露 dispose。 */
export const IStorageService =
  createServiceDescriptor<IStorageService>("zcode:storage");

export interface IStorageService extends StorageManagementApi {
  onScanProgress: Event<StorageUsageSnapshot>;
  /** 取消进行中的扫描并释放事件源。 */
  dispose(): void;
}
