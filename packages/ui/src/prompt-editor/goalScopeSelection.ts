import { findGoalCommandTokenEnd, hasGoalCommandToken } from "@zcode/shared";

/**
 * goal 目标范围选择（docs/specs/goal-command-scope-and-decoration.md）。
 *
 * 单独成文件是为了让它不依赖任何 `@/` 别名与 Lexical 运行时，能被测试直接引入；
 * 节点装饰本身在 `goalScopeDecoration.ts`。
 */

/** 范围选择只依赖这两个判据。 */
export interface GoalScopeSegment {
  /** 是否是 goal 命令 chip，或文本片段里含有 goal token。 */
  isGoalCommand: boolean;
  /** 是否是带可见文字的正文节点（空文本节点不占位，不参与范围）。 */
  hasText: boolean;
}

/** 片段文本里是否存在 goal token——手打 `/goal` 而没从面板选时，编辑器里只有纯文本节点。 */
export function hasGoalTokenInText(text: string): boolean {
  return hasGoalCommandToken(text);
}

/**
 * 文本片段里 goal token 的结束下标（即目标正文的起始下标）；没有则返回 -1。
 *
 * 手打 `/goal` 时 token 和目标正文同处一个 TextNode，不切分就没法只给后半段上色，
 * 所以装饰层要用它把节点切开。
 */
export function findGoalTokenEndInText(text: string): number {
  return findGoalCommandTokenEnd(text);
}

/**
 * 从段首往后扫描，返回「应当被装饰」的片段下标集合。
 *
 * 只认最后一个 goal：句中出现多次 `/goal` 时发送端取的是第一个（见
 * `parseV4VisibleSlashCommand`），但装饰若跟着第一个走，用户会在第二个 goal 之后继续看到
 * 无归属的下划线。以最后一个为准，能让「结尾多余 /goal」这类输入整体呈现为一条目标范围。
 */
export function selectGoalScopeSegmentIndexes(segments: readonly GoalScopeSegment[]): Set<number> {
  const scoped = new Set<number>();
  let seenGoal = false;
  for (const [index, segment] of segments.entries()) {
    if (segment.isGoalCommand) {
      seenGoal = true;
      continue;
    }
    if (seenGoal && segment.hasText) {
      scoped.add(index);
    }
  }
  return scoped;
}
