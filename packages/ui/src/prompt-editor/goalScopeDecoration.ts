import { $isElementNode, $isTextNode, type LexicalNode } from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { GOAL_SCOPE_TEXT_CSS_TEXT } from "@/goalScopeTextStyle.js";
import {
  findGoalTokenEndInText,
  hasGoalTokenInText,
  selectGoalScopeSegmentIndexes,
  type GoalScopeSegment,
} from "@/prompt-editor/goalScopeSelection.js";

/**
 * goal 目标范围高亮（docs/specs/goal-command-scope-and-decoration.md）。
 *
 * `/goal` 之后到段落末尾的正文会被解析成目标（下发时前文丢弃），这里给同一段范围上色，
 * 让用户在下发前就能看见「哪部分会成为目标」。装饰是纯视觉：只写 TextNode 的
 * inline style，不进入 `$getPromptMarkdown` / 剪贴板的 canonical 输出。
 *
 * 为什么用 `registerNodeTransform` 而不是选区 API：手打字符（含中文 IME）不经过
 * `CONTROLLED_TEXT_INSERTION_COMMAND`，只有 node transform 在 Lexical 内部同时覆盖 IME
 * 与普通输入两条路径。
 */

/**
 * 与 goal 芯片同色同粗；色值挂在既有 token 上，四套主题自动跟随。
 *
 * 走 inline style 而不是 `setFormat("underline")`：PlainText 架构下 format 只在
 * `EDITOR_THEME.text` 配了对应键时才会渲染成 class，而本编辑器的 theme 只有 paragraph，
 * 于是 format 写进了节点模型却在 DOM 上什么都不产生。inline style 走 `createDOM` 的
 * `dom.style.cssText`，不依赖 theme，是这里唯一确定生效的路径。写进行内 style 而非外层
 * CSS，是为了让装饰完全自包含——状态回收只需把 style 置空，不必再同步一个 class。
 *
 * 声明本身在 `goalScopeTextStyle.ts`，与用户气泡共用一份。任何一侧手写色值或字重，
 * 气泡与编辑器就会画出两种高亮。
 */
const GOAL_SCOPE_STYLE = GOAL_SCOPE_TEXT_CSS_TEXT;

const GOAL_COMMAND_VALUES = new Set(["goal", "target"]);

function isGoalCommandMention(node: LexicalNode): boolean {
  if (!$isPromptMentionNode(node)) return false;
  const { category, value } = node.getMention();
  if (category !== "commands") return false;
  return GOAL_COMMAND_VALUES.has(value.trim().replace(/^\/+/, "").toLowerCase());
}

function readSegment(node: LexicalNode): GoalScopeSegment {
  if (isGoalCommandMention(node)) {
    return { isGoalCommand: true, hasText: false };
  }
  if (!$isTextNode(node)) {
    return { isGoalCommand: false, hasText: false };
  }
  // 手打 `/goal` 而没从面板选中时，编辑器里只有纯文本节点，没有 chip。
  // 只认 chip 会让这类输入完全没有下划线，用户看不出这段会成为目标。
  const text = node.getTextContent();
  return {
    isGoalCommand: hasGoalTokenInText(text),
    hasText: text.length > 0,
  };
}

/**
 * 手打 `/goal` 时 token 与目标正文同处一个 TextNode，不切分就无法只给后半段上色。
 * 在 token 结束处切开，切出的后半段成为一个独立节点，交给下面的归一逻辑装饰。
 *
 * 切分是幂等的：切开后前半段不再含 token，`findGoalTokenEndInText` 返回 -1，不会重复切。
 */
function splitTextNodesAtGoalToken(nodes: readonly LexicalNode[]): void {
  for (const node of nodes) {
    if ($isPromptMentionNode(node)) continue;
    if (!$isTextNode(node)) continue;
    const text = node.getTextContent();
    const tokenEnd = findGoalTokenEndInText(text);
    if (tokenEnd <= 0 || tokenEnd >= text.length) continue;
    node.splitText(tokenEnd);
  }
}

/**
 * 幂等归一：每次按当前树重算应装饰集合，集合外的节点把装饰摘掉。
 *
 * 状态回收必须和施加装饰走同一条路径——用户删掉 goal 图标、撤销粘贴或把光标移出作用域后，
 * 残留的下划线与颜色要同帧消失。只做「加上」不做「摘掉」会在这些操作后留下脏样式。
 */
export function normalizeGoalScopeDecoration(root: LexicalNode): void {
  const children = $isElementNode(root) ? root.getChildren() : [];

  for (const child of children) {
    if (!$isElementNode(child)) continue;
    splitTextNodesAtGoalToken(child.getChildren());
    const nodes = child.getChildren();
    const scoped = selectGoalScopeSegmentIndexes(nodes.map(readSegment));

    nodes.forEach((node, index) => {
      // PromptMentionNode 自带 chip 样式（CSS 侧处理），不参与行内 style 装饰，
      // 否则下划线颜色会被写死成 inline style，主题切换时失效。
      if ($isPromptMentionNode(node)) return;
      if (!$isTextNode(node)) return;

      // setStyle 在值未变时是 no-op，transform 因此不会自激成死循环。
      const nextStyle = scoped.has(index) ? GOAL_SCOPE_STYLE : "";
      if (node.getStyle() !== nextStyle) {
        node.setStyle(nextStyle);
      }
    });
  }
}
