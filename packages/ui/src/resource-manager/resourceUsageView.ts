import type {
  ResourceUsageCategory,
  ResourceUsageProcess,
  ResourceUsageSnapshot,
} from "@zcode/shared";

/**
 * 判断快照能否作为完整总量展示。
 * 旧宿主缺少 samplingStatus 时回退到行级 sampled；任一行为 false 仍不可视为完整。
 */
export function isResourceUsageSnapshotComplete(snapshot: ResourceUsageSnapshot | null): boolean {
  if (!snapshot) return false;
  // 未知状态同样不能当作完整，避免新宿主字段校验差异被静默忽略。
  if (snapshot.samplingStatus !== undefined && snapshot.samplingStatus !== "complete") {
    return false;
  }
  return snapshot.processes.every((process) => process.sampled);
}

/** 三组固定顺序：基础服务 / 内置插件 / 社区插件 */
const RESOURCE_USAGE_CATEGORY_ORDER: readonly ResourceUsageCategory[] = [
  "base",
  "builtin-plugin",
  "community-plugin",
];

export interface ResourceUsageGroupView {
  category: ResourceUsageCategory;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
  /** 组内是否有指标尚未采到的进程 */
  hasUnsampled: boolean;
  /** 按 CPU 降序、内存降序、pid 升序 */
  processes: ResourceUsageProcess[];
}

export function groupResourceUsage(
  processes: readonly ResourceUsageProcess[],
): ResourceUsageGroupView[] {
  return RESOURCE_USAGE_CATEGORY_ORDER.map((category) => {
    const members = processes
      .filter((process) => process.category === category)
      .sort(
        (left, right) =>
          right.cpuPercent - left.cpuPercent ||
          right.memoryBytes - left.memoryBytes ||
          left.pid - right.pid,
      );
    return {
      category,
      processCount: members.length,
      cpuPercent: roundPercent(members.reduce((sum, process) => sum + process.cpuPercent, 0)),
      memoryBytes: members.reduce((sum, process) => sum + process.memoryBytes, 0),
      hasUnsampled: members.some((process) => !process.sampled),
      processes: members,
    };
  });
}

export function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function formatPercent(value: number): string {
  return `${roundPercent(value).toFixed(1)}%`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}
