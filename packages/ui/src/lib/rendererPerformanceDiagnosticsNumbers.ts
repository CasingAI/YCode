/** 诊断数值只接受有限非负数；缺失、NaN、Infinity、负数一律视为无效。 */
export function sanitizeRendererPerformanceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
