/**
 * 概览底栏的纯计算：采样样本、趋势曲线路径与纵轴上限。
 * 只做数值换算，不持有任何指标状态。
 */

/** 趋势曲线的主色/次色；与 CPU 底栏保持一致的第二编码。 */
export type OverviewSeriesTone = "primary" | "warning";

/** 概览底栏中的一条趋势曲线。 */
export interface OverviewSeries {
  label: string;
  values: readonly number[];
  tone: OverviewSeriesTone;
}

/** CPU / 内存页从资源快照派生的一个采样点。 */
export interface ResourceManagerSample {
  systemCpuPercent: number;
  appCpuPercent: number;
  /** 整机已用内存占物理内存的比例 */
  systemMemoryPercent: number;
  /** YCode 内存占物理内存的比例 */
  appMemoryPercent: number;
}

const OVERVIEW_TREND_WIDTH = 420;
const OVERVIEW_TREND_HEIGHT = 76;
const OVERVIEW_TREND_INSET = 4;

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 纵轴上限：固定上限（百分比曲线）优先，否则按当前序列峰值自适应。
 * 自适应下限为 1，避免全零数据把纵轴压成 0。
 */
export function resolveOverviewMaxValue(
  series: readonly OverviewSeries[],
  fixedMax?: number,
): number {
  if (fixedMax !== undefined && fixedMax > 0) return fixedMax;
  let peak = 0;
  for (const item of series) {
    for (const value of item.values) {
      peak = Math.max(peak, toFiniteNumber(value));
    }
  }
  return Math.max(1, peak);
}

/** 把序列采样换算成 SVG 路径；空序列返回空串。 */
export function buildOverviewTrendPath(values: readonly number[], maxValue: number): string {
  if (values.length === 0) return "";
  const width = OVERVIEW_TREND_WIDTH;
  const height = OVERVIEW_TREND_HEIGHT;
  const inset = OVERVIEW_TREND_INSET;
  const scale = maxValue > 0 ? maxValue : 1;
  return values
    .map((value, index) => {
      const x =
        values.length === 1
          ? width / 2
          : inset + (index / (values.length - 1)) * (width - inset * 2);
      const ratio = Math.max(0, Math.min(1, toFiniteNumber(value) / scale));
      const y = height - inset - ratio * (height - inset * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** 内存百分比：物理内存总量未知时按 0 处理，避免出现 NaN。 */
export function toMemoryPercent(usedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return (toFiniteNumber(usedBytes) / totalBytes) * 100;
}
