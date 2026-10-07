// 分组 emoji 归一化与校验（纯函数，无 IO；services/UI 两侧共用同一口径）。
//
// 存取规则（见 docs/specs/task-group-emoji-and-row-tag.md）：
// - 存单个 grapheme cluster；空字符串即清除（读出为 undefined）。
// - 取输入首个 grapheme，必须含 Emoji 属性（含 ZWJ 序列、国旗对、keycap 序列）；
//   多字符输入只取首个合法 grapheme，无合法 grapheme 则拒绝（返回 null）。
// - 读侧脏数据（多字符、非 emoji 文本）只读不写：normalizeTaskGroupEmojiForRead
//   按空处理，调用方不回写 DB。

const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;
const EMOJI_RE = /\p{Emoji}/u;

function firstGrapheme(value: string): string | undefined {
  const segments = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value);
  for (const segment of segments) {
    return segment.segment;
  }
  return undefined;
}

function isEmojiGrapheme(grapheme: string): boolean {
  // 国旗由两个 Regional_Indicator 组成，Extended_Pictographic 不覆盖它们，
  // 单独放行；其余要求含 Emoji 属性（含 ZWJ 序列与 keycap 序列）。
  if (REGIONAL_INDICATOR_RE.test(grapheme)) {
    return true;
  }
  return EMOJI_RE.test(grapheme);
}

/**
 * 写前归一化：返回合法 emoji 返回其 grapheme；空输入返回 ""（清除语义）；
 * 无合法 grapheme 返回 null（调用方拒绝写入并 toast，不落库）。
 */
export function normalizeTaskGroupEmojiForWrite(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  const grapheme = firstGrapheme(trimmed);
  if (!grapheme || !isEmojiGrapheme(grapheme)) {
    return null;
  }
  return grapheme;
}

/**
 * 读侧兜底：DB 脏值（多字符、非 emoji 文本、空串）一律按 undefined 处理；
 * 调用方只读不写，不回写 DB。
 */
export function normalizeTaskGroupEmojiForRead(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const grapheme = firstGrapheme(value);
  if (!grapheme || grapheme !== value || !isEmojiGrapheme(grapheme)) {
    return undefined;
  }
  return grapheme;
}

/** 首字兜底（无 emoji 的 Tag 图标）：Intl.Segmenter 首 grapheme，避免切开组合字。 */
export function firstGraphemeOf(value: string): string {
  return firstGrapheme(value.trim()) ?? "";
}
