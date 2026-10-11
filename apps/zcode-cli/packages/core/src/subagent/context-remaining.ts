/** 子会话窗口剩余百分比在模型可见尾部的字段名；三处投影必须同名。 */
export const CONTEXT_REMAINING_PERCENT_FIELD = "context_remaining_percent";

export function isContextRemainingPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatContextRemainingPercentLine(
  remainingPercent: number | undefined,
): string | undefined {
  if (!isContextRemainingPercent(remainingPercent)) return undefined;
  return `${CONTEXT_REMAINING_PERCENT_FIELD}: ${remainingPercent}`;
}

export function formatContextRemainingPercentXml(
  remainingPercent: number | undefined,
): string | undefined {
  if (!isContextRemainingPercent(remainingPercent)) return undefined;
  return `<${CONTEXT_REMAINING_PERCENT_FIELD}>${remainingPercent}</${CONTEXT_REMAINING_PERCENT_FIELD}>`;
}
