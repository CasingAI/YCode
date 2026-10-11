/**
 * 存储管理（设置页「数据与统计 › 存储」分区）的共享类型。
 * 数据由 main 进程持有的 StorageService 产生，经 preload 暴露的 `window.zcode.storage` 送到 renderer；
 * services 层的 storage 模块与 UI 都只引用这里的类型。
 */
/** 两个数据根：用户家目录下的 .zcode，以及「数据存储路径」下的 .zcode。 */
export type StorageRootId = "home" | "dataBaseDir";

export const STORAGE_CATEGORY_IDS = [
  "sessionStore",
  "subagentTranscripts",
  "toolOutputs",
  "commandOutputs",
  "temporaryCaches",
  "modelTrajectory",
  "devTraces",
  "logs",
  "backups",
  "exports",
  "runtimes",
  "config",
  // 沙盒 LocalStorage（每会话 5MB 落盘，见 sandbox-system-tool.md「存储管理」）。
  "sandbox",
  "other",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

/** entries 超出上限后折叠项的占位路径；UI 显示为「其余 N 项」。 */
export const STORAGE_MORE_ENTRIES_PATH = "…";

/** none：不提供清理；safe：直接清理；confirm：需要二次确认。 */
export type StorageCleanability = "none" | "safe" | "confirm";

/** 扫描输入：由 RootsResolverPort 解析出的根目录。 */
export interface StorageRootSpec {
  id: StorageRootId;
  path: string;
  /** 是否启用了自定义数据存储路径；启用后 home 根下的 v2 视为旧副本，归入「其他」。 */
  hasCustomDataBaseDir: boolean;
}

export interface StorageVolume {
  /** 同一物理卷的稳定 key（stat().dev）；同 key 的根合并进同一张磁盘卡片。 */
  deviceId: string;
  /** mac/Linux 为挂载点路径，Windows 为盘符根。 */
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  /** 相对根目录的路径。 */
  relativePath: string;
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  /** 下钻明细：聚合到规则命中路径的下一级，按 bytes 降序，有数量上限。 */
  entries: StorageEntryUsage[];
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  /** statfs 失败时为 null：只展示占用，不展示磁盘容量。 */
  volume: StorageVolume | null;
  bytes: number;
  fileCount: number;
  categories: StorageCategoryUsage[];
}

export type StorageScanStatus = "scanning" | "complete" | "cancelled" | "failed";

export interface StoragePathError {
  path: string;
  code: string;
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: StorageScanStatus;
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  /** EACCES / ENOENT 等局部错误，不中断扫描。 */
  errors: StoragePathError[];
}

export interface StorageCleanRequest {
  rootId: StorageRootId;
  /** 旧单类别入口仍兼容：服务侧归一成单元素数组。 */
  categoryId?: StorageCategoryId;
  /** 新对话框入口：一次带多个类别。 */
  categoryIds?: StorageCategoryId[];
  /** 按文件 mtime 过滤：只删 now - mtime >= olderThanMs；缺省为 0（全部）。 */
  olderThanMs?: number;
  /** 按下钻明细 entryKey 前缀过滤（沙盒按会话清用）：只删命中任一前缀的候选；
   * 缺省为不过滤（整类）。前缀按「相等或 `prefix/` 开头」匹配。 */
  entryKeys?: string[];
}

/** 清理时间范围：对话框草稿态使用，确认后换算成 olderThanMs 发给服务。 */
export type StorageCleanAgeRange = "7days" | "30days" | "all";

/** 年龄范围换算成毫秒阈值：all 对应 0（全部，不过滤）。 */
export function storageCleanAgeRangeToMs(range: StorageCleanAgeRange): number {
  if (range === "7days") return 7 * 24 * 60 * 60 * 1000;
  if (range === "30days") return 30 * 24 * 60 * 60 * 1000;
  return 0;
}

/** 对话框可勾选的清理类别：会话库/配置/运行时/其他不出现。 */
export const STORAGE_CLEAN_DIALOG_CATEGORY_IDS = [
  "commandOutputs",
  "temporaryCaches",
  "subagentTranscripts",
  "modelTrajectory",
  "devTraces",
  "logs",
  "backups",
  "exports",
  "toolOutputs",
  // 沙盒 LocalStorage：对话框内可选清理（默认不勾，见 DEFAULT_CHECKED）。
  "sandbox",
] as const;

export type StorageCleanDialogCategoryId = (typeof STORAGE_CLEAN_DIALOG_CATEGORY_IDS)[number];

/** 对话框默认勾选：命令完整输出 + 临时缓存。 */
export const STORAGE_CLEAN_DIALOG_DEFAULT_CHECKED: readonly StorageCleanDialogCategoryId[] = [
  "commandOutputs",
  "temporaryCaches",
];

/** 默认时间范围：30 天前。 */
export const STORAGE_CLEAN_DIALOG_DEFAULT_RANGE: StorageCleanAgeRange = "30days";

export interface StorageCleanResult {
  freedBytes: number;
  deletedCount: number;
  /** 被保护规则跳过的文件数（例如当天日志、24h 内的会话目录）。 */
  skippedCount: number;
  failures: StoragePathError[];
}

/** 卷视图：同一物理卷上的根聚合在一起，供磁盘卡片使用。 */
export interface StorageVolumeGroup {
  /** volume.deviceId，探测失败的根各自成组，key 为根路径。 */
  key: string;
  volume: StorageVolume | null;
  roots: StorageRootUsage[];
  bytes: number;
}

/**
 * 按物理卷把根目录分组：同 deviceId 的根进同一组；探测失败的根各自成组。
 * 纯函数，组内根顺序与输入一致，组按 bytes 降序。
 */
export function groupStorageRootsByVolume(roots: StorageRootUsage[]): StorageVolumeGroup[] {
  const groups = new Map<string, StorageVolumeGroup>();
  for (const root of roots) {
    const key = root.volume ? `dev:${root.volume.deviceId}` : `path:${root.path}`;
    const group = groups.get(key);
    if (group) {
      group.roots.push(root);
      group.bytes += root.bytes;
      continue;
    }
    groups.set(key, { key, volume: root.volume, roots: [root], bytes: root.bytes });
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/** 主进程侧存储服务与 renderer 桥共有的命令面。 */
export interface StorageManagementApi {
  /** 开始一次扫描；若已有进行中的 job 会先取消它。 */
  startScan(): Promise<{ jobId: string }>;
  /** 取消指定 job；非当前 job 为 no-op。 */
  cancelScan(jobId: string): Promise<void>;
  /** 最近一次快照（进行中或已完成），从未扫描过时为 null。 */
  getSnapshot(): Promise<StorageUsageSnapshot | null>;
  /** 按类别清理；调用方负责二次确认。扫描中调用会先取消当前扫描。 */
  clean(request: StorageCleanRequest): Promise<StorageCleanResult>;
}

/** preload 暴露给 renderer 的存储管理桥：`window.zcode.storage`，经 `IPlatformService.storage` 下发。 */
export interface StorageManagementBridge extends StorageManagementApi {
  /** 进度事件：≥300ms 节流一次，payload 为完整快照；终态也通过它发出。返回取消订阅函数。 */
  subscribeScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  /** 在系统文件管理器中定位路径（必须位于某个数据根内，main 侧校验）。 */
  revealPath(absolutePath: string): Promise<void>;
}
