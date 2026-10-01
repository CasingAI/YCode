import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
} from "lexical";
import { $isPromptMentionNode } from "./nodes/PromptMentionNode.js";

export function getCurrentTextNodeSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return null;
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const text = node.getTextContent();
  return {
    selection,
    node,
    cursorOffset: anchor.offset,
    nodeKey: node.getKey(),
    text,
    textAfterCursor: text.slice(anchor.offset),
    textBeforeCursor: text.slice(0, anchor.offset),
  };
}

/**
 * 读出整条输入里命令芯片（`category: "commands"` 的 mention）的命令名。
 *
 * 一条输入只允许一个命令：命令之后的全部正文会整体归为该命令的参数，第二个命令插进来
 * 既不会执行也不会被拒绝，只会静默变成参数文本。判定放在输入层而不是发送层，是因为
 * 第二个命令根本不该能被插进来。
 *
 * 范围取整个编辑态而不是当前段落——规则是「一条输入」，跨段落塞两个命令同样不合法。
 * 草稿恢复只重建 plugin mention、预填命令整篇替换，两条路径都造不出第二个命令芯片，
 * 所以这个判定是唯一的入口。
 *
 * 命令名供命令绑定模型着色使用（docs/specs/command-model-binding.md）：
 * 芯片出现即返回名字，删除后返回 null。
 */
export function findCommandMentionNameInEditorState(): string | null {
  let commandName: string | null = null;
  const readCommandMention = (node: LexicalNode): boolean => {
    if ($isPromptMentionNode(node) && node.getMention().category === "commands") {
      const value = node.getMention().value.trim();
      if (value) commandName = value;
      return true;
    }
    return false;
  };
  for (const child of $getRoot().getChildren()) {
    if (readCommandMention(child)) return commandName;
    if ($isElementNode(child) && child.getChildren().some(readCommandMention)) {
      return commandName;
    }
  }
  return null;
}

export function hasCommandMentionInEditorState(): boolean {
  return findCommandMentionNameInEditorState() !== null;
}
