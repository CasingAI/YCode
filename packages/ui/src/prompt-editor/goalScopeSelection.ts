import { findGoalCommandTokenEnd, hasGoalCommandToken } from "@zcode/shared";
import { topLevelSlashCommandTokenEnd } from "../v4/slashCommands.js";

/**
 * 命令参数正文范围选择（docs/specs/goal-command-scope-and-decoration.md
 * 「位置语义与显示对齐」）。
 *
 * 单独成文件是为了让它不依赖任何 `@/` 别名与 Lexical 运行时，能被测试直接引入；
 * 节点装饰本身在 `goalScopeDecoration.ts`。
 *
 * token 读取有两条来源，共用同一套范围算法：
 * - goal/target：句中可命中，边界见 `packages/shared/src/goal-command-token.ts`；
 * - compact/compress/plan/init：仅顶格，边界见 `slashCommands.ts` 的
 *   `topLevelSlashCommandTokenEnd`（与 `parseV4VisibleSlashCommand` 同一份判定）。
 *
 * 装饰层只关心「这段是否含命令 token」，不关心命令是谁：两者之后的正文都会作为参数
 * 下发（goal 是目标，compact 是 instructions），所以着色范围必须与下发范围完全重合。
 */

/** 范围选择只依赖这两个判据。 */
export interface GoalScopeSegment {
  /** 是否是命令 token（命令 chip，或文本片段里含命令 token）。 */
  isGoalCommand: boolean;
  /** 是否是带可见文字的正文节点（空文本节点不占位，不参与范围）。 */
  hasText: boolean;
}

/**
 * 文本片段里是否存在命令 token——手打 `/goal` 或 `/compact` 而没从面板选时，编辑器里只有纯文本节点。
 *
 * `isTopLevelNode` 是这个节点在树里的位置事实：顶格命令只有当节点本身就是整条输入的
 * 第一个内容时才算命令。少了它，降级后的 `/compact` 会因为「节点文本恰好顶格」被重新
 * 认成命令 token，把后面的参数继续染蓝——显示与执行再次脱节。
 * goal/target 不受它影响：句中命中本就是命令语义，由 shared 的 token 正则自行判边界。
 */
export function hasGoalTokenInText(text: string, isTopLevelNode = true): boolean {
  return hasGoalCommandToken(text) || (isTopLevelNode && hasTopLevelCommandToken(text));
}

/** 文本片段是否为顶格命令开头（`/compact 1231231`、`/plan 切计划`）。 */
function hasTopLevelCommandToken(text: string): boolean {
  return topLevelSlashCommandTokenEnd(text) > 0;
}

/**
 * 文本片段里命令 token 的结束下标（即参数正文起始下标）；没有则返回 -1。
 *
 * 手打命令时 token 和参数正文同处一个 TextNode，不切分就没法只给后半段上色，
 * 所以装饰层要用它把节点切开。goal/target 与顶格命令任一命中即算，先命中者为准。
 *
 * `isTopLevelNode` 语义同 `hasGoalTokenInText`：顶格命令要连节点位置一起算。
 */
export function findGoalTokenEndInText(text: string, isTopLevelNode = true): number {
  const topLevelEnd = isTopLevelNode ? topLevelSlashCommandTokenEnd(text) : -1;
  if (topLevelEnd >= 0) return topLevelEnd;
  return findGoalCommandTokenEnd(text);
}

/**
 * 从段首往后扫描，返回「应当被装饰」的片段下标集合。
 *
 * 认第一个命令，覆盖它之后的全部正文到段尾：`seenGoal` 一旦置真就不再复位，与发送端
 * `parseV4VisibleSlashCommand` 取第一个 token 的语义一致——「一条输入只有一个命令，命令
 * 之后的全部正文都是它的参数」，高亮必须与实际下发范围完全重合。
 *
 * 命令芯片本身不占范围（`isGoalCommand` 片段被跳过）：那是命令，不是参数正文。
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
