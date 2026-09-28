/**
 * `/goal` 句中命中边界（docs/specs/goal-command-scope-and-decoration.md）。
 *
 * 中文句末通常紧贴 `。` `，` 而不插空格。只认行首、空白或 CJK 标点，不认汉字本身，
 * 避免 `前缀/goal` 被误消费。发送、回显、装饰、CLI 队列必须共用这里，不能各写一份正则。
 */
const GOAL_COMMAND_TOKEN_RE = /(^|[\s\u3000-\u303f\uff00-\uffef])(\/(?:goal|target))(?=\s|$)/i;

/** 返回句中 `/goal` 或 `/target` token 的起始下标（指向斜杠）；不存在时返回 -1。 */
export function findGoalCommandTokenStart(text: string): number {
  const match = GOAL_COMMAND_TOKEN_RE.exec(text);
  if (!match) return -1;
  return (match.index ?? 0) + (match[1] ?? "").length;
}

/** 返回 token 结束下标（目标正文起点）；不存在时返回 -1。 */
export function findGoalCommandTokenEnd(text: string): number {
  const start = findGoalCommandTokenStart(text);
  if (start < 0) return -1;
  const token = /^\/(?:goal|target)/i.exec(text.slice(start));
  return token ? start + token[0].length : -1;
}

export function hasGoalCommandToken(text: string): boolean {
  return findGoalCommandTokenStart(text) !== -1;
}

/** 去掉 goal token 后的参数；没有 token 时返回整段 trim 结果。 */
export function sliceGoalCommandArgs(text: string): string {
  const start = findGoalCommandTokenStart(text);
  if (start < 0) return text.trim();
  return text
    .slice(start)
    .replace(/^\/(?:goal|target)/i, "")
    .trim();
}
