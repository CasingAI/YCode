import { $createParagraphNode, $createTextNode, type ElementNode } from "lexical";
import { $createPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import {
  splitMentionLinks,
  type RestoredMentionPayload,
  type RestoredMentionSegment,
} from "@/mentions/mentionMarkdownRestore.js";
import { goalCommandChipPayload, splitGoalCommandToken } from "@/mentions/goalCommandPrefill.js";

/**
 * 「按 mention 语义把整段文本重建为段落」的编辑器侧实现。从 LexicalChatInput 的
 * `replaceEditorTextWithMentions` 提出（节点构建行为逐字保留），使还原逻辑能被
 * headless editor 集成测试直接驱动；调用方仍负责 root.clear 与选区复位。
 */

export interface RestoreTextWithMentionsOptions {
  /**
   * 编辑卡预填专用（docs/specs/goal-command-scope-and-decoration.md「编辑卡预填形态」）：
   * 行 commandKind 为 sendGoalCommand 时把首个 goal/target token 还原成命令芯片。
   * 整框最多一枚——发送端只认第一个命令，其余出现保持纯文本、由文本匹配着色。
   */
  restoreGoalCommand?: boolean;
}

export function $restoreTextAsParagraphs(
  root: ElementNode,
  text: string,
  options?: RestoreTextWithMentionsOptions,
): void {
  let goalChipPlaced = false;
  for (const line of text.split("\n\n")) {
    const paragraph = $createParagraphNode();
    let appended = false;

    const appendSegments = (
      segments: Array<RestoredMentionSegment | { payload: RestoredMentionPayload }>,
    ) => {
      for (const segment of segments) {
        if ("payload" in segment) {
          paragraph.append($createPromptMentionNode(segment.payload));
          appended = true;
        } else if (segment.text) {
          paragraph.append($createTextNode(segment.text));
          appended = true;
        }
      }
    };

    // 编辑卡预填：行 commandKind=sendGoalCommand 时把首个 goal/target token 还原成
    // 命令芯片。不还原的旧行为会让已判定为命令的行开卡后丢图标、只剩正文染蓝
    // （图标与颜色来自两套互不知情的规则）。before/after 仍走 splitMentionLinks，
    // 前后文里的 canonical 链接照常还原，不因切 token 丢能力。
    const split =
      options?.restoreGoalCommand && !goalChipPlaced ? splitGoalCommandToken(line) : null;
    if (split) {
      goalChipPlaced = true;
      appendSegments(splitMentionLinks(split.before));
      paragraph.append($createPromptMentionNode(goalCommandChipPayload(split)));
      appendSegments(splitMentionLinks(split.after));
      appended = true;
    } else {
      // splitMentionLinks 只切 canonical 链接；裸 token（/$/@/#/sess）保持纯文本，
      // 无法区分"用户真敲的"与"mention 序列化产物"，还原会凭空造芯片。
      appendSegments(splitMentionLinks(line));
    }

    if (!appended) {
      paragraph.append($createTextNode(""));
    }
    root.append(paragraph);
  }
}
