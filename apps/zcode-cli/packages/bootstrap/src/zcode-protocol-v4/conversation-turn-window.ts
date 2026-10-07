// 整轮取窗：rowsRange 与尾窗的切页口径（纯函数，无 I/O、无副作用）。
//
// 取窗单位是**轮**不是行：一次加载至少一整轮（turnHeader → 用户消息 → 正文 → 工具行），
// 60/200 这类行数常量不再是产品指标。切页由**单帧体积预算**裁决：按轮累计序列化字节，
// 只有当某轮自身就超出预算、且页内没有任何其它整轮可取舍时，才允许对该轮按行切分——
// 拆轮是唯一许可，不是常规路径。
//
// 为什么不是「按行取整行数」：轮内行数不可预测（一条短轮 5 行、一条长轮上千行），
// 任何行数切法都会在轮中间断开，客户端只能靠缝合与补拉兜（见
// docs/specs/conversation-timeline-turn-window-fill.md）。
//
// 前提：入参 `rows` 按 rowId 升序且同一 turnId 的行连续（投影归约保证，轮导航与目录聚合
// 都依赖这一点）。这不是校验点而是契约点——破坏了它，轮边界扩展只会静默给出错误窗口。

import { Buffer } from "node:buffer";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

/** 切窗结果：投影全量行上的半开区间 `[start, end)`。 */
export interface TurnWindowRange {
  /** 切片起点下标（含）。 */
  start: number;
  /** 切片终点下标（不含）。 */
  end: number;
  /**
   * 因单帧体积上限被按行切分的轮（turnId）。没有拆轮时为 undefined。
   * 客户端不据此拆轮——它只说明这一页没能装下整整一轮。
   */
  frameCapSplitTurnId?: string;
}

/** 单帧体积预算：整帧上限减去信封预留。 */
export function resolveRowsRangeFrameBudgetBytes(): number {
  return Math.max(
    1024,
    PROTOCOL_V4_LIMITS.maxFrameBytes - PROTOCOL_V4_LIMITS.rowsRangeFrameOverheadBytes,
  );
}

/** 单行 UTF-8 字节数。CLI 固定跑在 Node，直接算精确值，不做近似估算。 */
function rowByteLength(row: ConversationRow): number {
  const json = JSON.stringify(row);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/** 行所属轮的起点下标（`index` 所在轮的 turnHeader 行位置；无 header 时取该轮首行）。 */
export function turnStartAt(rows: readonly ConversationRow[], index: number): number {
  const turnId = rows[index]?.turnId;
  if (turnId === undefined) return index;
  let start = index;
  while (start > 0 && rows[start - 1]?.turnId === turnId) start -= 1;
  return start;
}

/** 行所属轮的终点下标（不含）。 */
export function turnEndAt(rows: readonly ConversationRow[], index: number): number {
  const turnId = rows[index]?.turnId;
  if (turnId === undefined) return index + 1;
  let end = index + 1;
  while (end < rows.length && rows[end]?.turnId === turnId) end += 1;
  return end;
}

/** 区间字节数的累计测量器：每行只测一次，后续查询都是 O(1)。 */
function createRangeByteCounter(rows: readonly ConversationRow[]): (start: number, end: number) => number {
  // 只按需测到实际走到的位置之前：整段投影可能有十万行，逐行 JSON 序列化不可接受。
  const prefix = [0];
  let measuredUpTo = 0;
  return (start, end) => {
    while (measuredUpTo < end) {
      prefix.push(prefix[prefix.length - 1]! + rowByteLength(rows[measuredUpTo]!));
      measuredUpTo += 1;
    }
    return prefix[end]! - prefix[start]!;
  };
}

/**
 * 从尾部向前取整轮，直到行数达到 `minRows` 且不超预算。
 *
 * 尾窗用：先取「覆盖 minRows 的最小整轮集合」，再从头侧按整轮丢弃以守住预算；
 * 丢弃到只剩最后一轮仍超预算时，才对该轮按行切分（唯一许可）。
 */
export function selectTailTurnWindow(
  rows: readonly ConversationRow[],
  input: { minRows: number; byteBudget: number },
): TurnWindowRange {
  const length = rows.length;
  if (length === 0) return { start: 0, end: 0 };
  const bytesOf = createRangeByteCounter(rows);
  const end = length;
  let start = turnStartAt(rows, Math.max(0, length - Math.max(1, input.minRows)));
  while (start > 0 && bytesOf(start, end) > input.byteBudget) {
    const next = turnEndAt(rows, start);
    if (next >= end) break;
    start = next;
  }
  if (bytesOf(start, end) <= input.byteBudget) return { start, end };
  // 只剩最后一轮仍超预算：拆轮，取尾部能装进预算的连续行。
  const splitStart = fitRowSuffixWithinBudget(rows, start, end, input.byteBudget, bytesOf);
  return { start: splitStart, end, frameCapSplitTurnId: rows[splitStart]?.turnId };
}

/**
 * 向上取整轮（`beforeRowId` 方向）：游标之上的最后一轮必须整轮带上，再按整轮继续向上。
 */
export function selectOlderTurnWindow(
  rows: readonly ConversationRow[],
  input: { beforeRowId: number; byteBudget: number },
): TurnWindowRange {
  const length = rows.length;
  let end = firstIndexAtOrAfter(rows, input.beforeRowId);
  if (end <= 0) return { start: 0, end: 0 };
  end -= 1; // 游标之前最后一行所在位置
  const cursorIndex = end;
  end = cursorIndex + 1;
  const bytesOf = createRangeByteCounter(rows);
  let start = turnStartAt(rows, cursorIndex);
  while (start > 0) {
    const candidate = turnStartAt(rows, start - 1);
    if (bytesOf(candidate, end) > input.byteBudget) break;
    start = candidate;
  }
  if (bytesOf(start, end) <= input.byteBudget) return { start, end };
  const splitStart = fitRowSuffixWithinBudget(rows, start, end, input.byteBudget, bytesOf);
  return { start: splitStart, end, frameCapSplitTurnId: rows[splitStart]?.turnId };
}

/**
 * 向下取整轮（`afterRowId` 方向）：游标之下的第一轮必须整轮带上，再按整轮继续向下。
 */
export function selectNewerTurnWindow(
  rows: readonly ConversationRow[],
  input: { afterRowId: number; byteBudget: number },
): TurnWindowRange {
  const length = rows.length;
  const start = firstIndexAfter(rows, input.afterRowId);
  if (start >= length) return { start: length, end: length };
  const bytesOf = createRangeByteCounter(rows);
  let end = turnEndAt(rows, start);
  while (end < length) {
    const candidate = turnEndAt(rows, end);
    if (bytesOf(start, candidate) > input.byteBudget) break;
    end = candidate;
  }
  if (bytesOf(start, end) <= input.byteBudget) return { start, end };
  const splitEnd = fitRowPrefixWithinBudget(rows, start, end, input.byteBudget, bytesOf);
  return { start, end: splitEnd, frameCapSplitTurnId: rows[start]?.turnId };
}

/**
 * 跳转换窗（`aroundRowId` 方向）：以目标行所在**整轮**为基线，先向下再向上交替扩整轮。
 * 目标轮自身超预算时才按行切，切出的区间必须包含目标行。
 */
export function selectAroundTurnWindow(
  rows: readonly ConversationRow[],
  input: { aroundRowId: number; byteBudget: number },
): TurnWindowRange | null {
  const length = rows.length;
  const targetIndex = rows.findIndex((row) => row.rowId === input.aroundRowId);
  if (targetIndex === -1) return null;
  const bytesOf = createRangeByteCounter(rows);
  let start = turnStartAt(rows, targetIndex);
  let end = turnEndAt(rows, targetIndex);
  if (bytesOf(start, end) > input.byteBudget) {
    // 目标轮自身超预算（只有撞上单帧上限才允许拆轮）：以目标行为锚，先向下再向上
    // 在预算内取连续区间。此时起点不再保证是轮边界——这一整轮装不进任何一帧，
    // 这是拆轮唯一被允许的形态。
    let end2 = targetIndex + 1;
    while (end2 < length && bytesOf(targetIndex, end2 + 1) <= input.byteBudget) end2 += 1;
    let start2 = targetIndex;
    while (start2 > 0 && bytesOf(start2 - 1, end2) <= input.byteBudget) start2 -= 1;
    return { start: start2, end: end2, frameCapSplitTurnId: rows[start2]?.turnId };
  }
  while (true) {
    let grew = false;
    if (end < length) {
      const candidate = turnEndAt(rows, end);
      if (bytesOf(start, candidate) <= input.byteBudget) {
        end = candidate;
        grew = true;
      }
    }
    if (start > 0) {
      const candidate = turnStartAt(rows, start - 1);
      if (bytesOf(candidate, end) <= input.byteBudget) {
        start = candidate;
        grew = true;
      }
    }
    if (!grew) return { start, end };
  }
}

/** 首个 `rowId >= target` 的下标（越界返回 rows.length）。 */
function firstIndexAtOrAfter(rows: readonly ConversationRow[], target: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((rows[mid]?.rowId ?? Number.POSITIVE_INFINITY) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 首个 `rowId > target` 的下标（越界返回 rows.length）。 */
function firstIndexAfter(rows: readonly ConversationRow[], target: number): number {
  return firstIndexAtOrAfter(rows, target + 1);
}

/**
 * 拆轮辅助：取游标侧能装进预算的**最大**连续行后缀 `[candidate, end)`。
 *
 * 从整轮（candidate = start）起向后收缩到恰好装进预算：bytes 随 candidate 递增单调
 * 不增，停下的位置即最大可装后缀。连单行都超预算时停在 end − 1——至少返回一行，
 * 游标才能推进。
 *
 * 修复依据（生产教训）：曾反向从 1 行后缀起步只在超预算时收缩——单行必然装得下，
 * 循环永不执行，恒返回单行。goal 模式巨轮（700+ 行、超单帧预算）被补齐循环逐行
 * 磨掉，单会话上滚发出 331 次单页请求（spec「切在预算允许的最大行数处」）。
 * 只在「整轮自身超预算」时被调用。
 */
function fitRowSuffixWithinBudget(
  rows: readonly ConversationRow[],
  start: number,
  end: number,
  byteBudget: number,
  bytesOf: (start: number, end: number) => number,
): number {
  let candidate = start;
  while (candidate < end - 1 && bytesOf(candidate, end) > byteBudget) candidate += 1;
  return candidate;
}

/**
 * 拆轮辅助：取能装进预算的**最大**连续行前缀 `[start, candidate)`。
 *
 * 从整轮（candidate = end）起向前收缩到恰好装进预算，镜像于 fitRowSuffixWithinBudget；
 * 同样保证至少一行（candidate ≥ start + 1）。修复依据同上。
 */
function fitRowPrefixWithinBudget(
  rows: readonly ConversationRow[],
  start: number,
  end: number,
  byteBudget: number,
  bytesOf: (start: number, end: number) => number,
): number {
  let candidate = end;
  while (candidate > start + 1 && bytesOf(start, candidate) > byteBudget) candidate -= 1;
  return candidate;
}