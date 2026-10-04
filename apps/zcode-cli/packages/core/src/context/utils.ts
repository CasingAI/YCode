// ============================================================
// Token Estimation
// ============================================================

/**
 * 单个中文字符的 token 权重。中文按 0.6 计入：同一段文本里中文越集中，
 * 估算值越接近 provider 实测值；这是粗略的线性近似，不等于真实 tokenizer 分词结果。
 */
export const ESTIMATED_TOKEN_WEIGHT_CJK = 0.6;

/**
 * 单个非中文字符的 token 权重。英文等字符按 0.3 计入。
 */
export const ESTIMATED_TOKEN_WEIGHT_OTHER = 0.3;

/**
 * 中文字符判定。汉字之外必须覆盖 CJK 符号与标点、全角形式：
 * 「、。，（）」这类符号在中文文本里密度很高，只匹配汉字会让中文占比被系统性低估。
 * 三段依次为 CJK 符号与标点 U+3000-303F、CJK 统一表意文字 U+4E00-9FFF、全角形式 U+FF00-FFEF。
 */
const CJK_CHARACTER_PATTERN = /[　-〿一-鿿＀-￯]/g;

/**
 * 估算文本的 token 数量
 * 中文字符权重高于其余字符，两者按显式权重计入后向上取整
 * 这是一个粗略估算，用于上下文构成分析与调试监控
 */
export function estimateTokens(text: string): number {
  const cjkCharacters = text.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  const otherCharacters = text.length - cjkCharacters;

  return Math.ceil(cjkCharacters * ESTIMATED_TOKEN_WEIGHT_CJK + otherCharacters * ESTIMATED_TOKEN_WEIGHT_OTHER);
}
