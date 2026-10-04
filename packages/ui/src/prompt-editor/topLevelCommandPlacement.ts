import { $createTextNode, $getSelection, $isRangeSelection, type LexicalNode } from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { $isMisplacedTopLevelCommandMention } from "../slashCommandHelpers.js";

/**
 * 顶格命令芯片的持续位置约束（docs/specs/goal-command-scope-and-decoration.md
 * 「位置语义与显示对齐」）。
 *
 * 插入时刻的位置门控只覆盖「刚敲完 `/compact` 的那一瞬间」。芯片一旦落进树里就是普通
 * 节点，用户回到行首补一句字、粘贴一段带前文的内容，都会把它挪到句中，而没有任何机制
 * 回头复核——结果是编辑器画出命令芯片、参数染成命令蓝，发送端却按纯文本下发。
 *
 * 本模块是那个持续校验点：错位即把芯片降级回普通文本节点，让树重新满足「位置决定它
 * 是不是命令」。显示（作用域着色）与执行（canonical 序列化）因此读同一份事实。
 */

/**
 * 选区是否落在被降级的芯片上。
 *
 * 芯片是 token 模式，光标只可能在它前后而不在内部，但 Lexical 的 point 仍可能指着它；
 * 不接住的话替换后 point 悬空，选区会跳到别处。
 */
function reanchorSelectionToReplacement(node: LexicalNode, replacementKey: string): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const nodeKey = node.getKey();
  const points = [selection.anchor, selection.focus];
  for (const point of points) {
    // element point 指向父节点的下标，不可能落在这枚芯片上，只处理 text point。
    if (point.type === "text" && point.key === nodeKey) {
      point.set(replacementKey, 0, "text");
    }
  }
}

/**
 * 若该节点是一枚错位的顶格命令芯片，就地降级为普通文本节点并返回 true。
 *
 * 降级后的文本取芯片的 canonical（`markdown`，即 `/compact`），与发送端看到的完全一致：
 * 用户看到的字就是会被下发的字，降级不改变这条消息的内容，只是不再谎称它是命令。
 *
 * 光标不动：调用方通常是用户在芯片前面补字，光标本来就在前面的文本节点里，无脑
 * `selectStart()` 反而会把光标拽走。
 *
 * 替换后不再下降：新节点是 TextNode，判定函数只认 mention 节点，不会自激成死循环。
 * 只能在 Lexical 写事务里调用。
 */
export function $demoteTopLevelCommandMentionIfMisplaced(node: LexicalNode): boolean {
  if (!$isMisplacedTopLevelCommandMention(node)) return false;
  const replacement = $createTextNode($isPromptMentionNode(node) ? node.getMarkdown() : "");
  reanchorSelectionToReplacement(node, replacement.getKey());
  node.replace(replacement);
  return true;
}
