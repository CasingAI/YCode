import assert from "node:assert/strict";
import test from "node:test";
import { $getRoot, $isElementNode, createEditor, type LexicalEditor } from "lexical";
import {
  $isPromptMentionNode,
  PromptMentionNode,
} from "../src/mentions/nodes/PromptMentionNode.js";
import { $getPromptMarkdown } from "../src/mentions/promptSerialization.js";
import { normalizeGoalScopeDecoration } from "../src/prompt-editor/goalScopeDecoration.js";
import {
  $restoreTextAsParagraphs,
  type RestoreTextWithMentionsOptions,
} from "../src/mentions/mentionTextRestore.js";
import { GOAL_SCOPE_TEXT_CSS_TEXT } from "../src/goalScopeTextStyle.js";

// 编辑卡预填形态的 headless 集成（docs/specs/goal-command-scope-and-decoration.md
// 「编辑卡预填形态」）：还原 + 着色放在同一个 headless 编辑器里跑，与真实编辑器中
// 「回填 → GoalScopeDecorationPlugin transform 归一」的顺序一致。

function createTestEditor(): LexicalEditor {
  return createEditor({ nodes: [PromptMentionNode] });
}

/** 真实顺序：$restoreTextAsParagraphs（开卡回填）→ normalizeGoalScopeDecoration（transform）。 */
function restore(editor: LexicalEditor, text: string, options?: RestoreTextWithMentionsOptions) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $restoreTextAsParagraphs(root, text, options);
      normalizeGoalScopeDecoration(root);
    },
    // headless 无事件上下文，discrete 让提交立即可读（与既有集成测试同口径）。
    { discrete: true },
  );
}

interface FlatNode {
  type: string;
  text: string;
  style: string;
  mention?: { id: string; category: string; value: string; markdown: string };
}

function flatten(editor: LexicalEditor): { nodes: FlatNode[]; markdown: string } {
  return editor.getEditorState().read(() => {
    const nodes: FlatNode[] = [];
    for (const child of $getRoot().getChildren()) {
      if (!$isElementNode(child)) continue;
      for (const node of child.getChildren()) {
        const flat: FlatNode = {
          type: node.getType(),
          text: node.getTextContent(),
          style: node.getStyle(),
        };
        if ($isPromptMentionNode(node)) {
          const mention = node.getMention();
          flat.mention = {
            id: mention.id,
            category: mention.category,
            value: mention.value,
            markdown: mention.markdown,
          };
        }
        nodes.push(flat);
      }
    }
    return { nodes, markdown: $getPromptMarkdown() };
  });
}

test("sendGoalCommand 预填：token 还原成命令芯片，正文染色，markdown 逐字回环", () => {
  const editor = createTestEditor();
  restore(editor, "/goal 完成计划", { restoreGoalCommand: true });

  const { nodes, markdown } = flatten(editor);
  assert.equal(nodes.length, 2);
  const [chip, body] = nodes;
  assert.equal(chip.type, "prompt-mention");
  assert.deepEqual(chip.mention, {
    id: "prefill-slash:goal",
    category: "commands",
    value: "goal",
    markdown: "/goal",
  });
  assert.equal(body.type, "text");
  assert.equal(body.text, " 完成计划");
  assert.equal(body.style, GOAL_SCOPE_TEXT_CSS_TEXT);
  // 提交链不变式：整框 getMarkdown 与原文逐字一致，CLI hasGoalCommandToken 重判不受影响。
  assert.equal(markdown, "/goal 完成计划");
});

test("前文不被染色，夹在 token 之前保持普通正文", () => {
  const editor = createTestEditor();
  restore(editor, "先说一句 /goal 目标正文", { restoreGoalCommand: true });

  const { nodes, markdown } = flatten(editor);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0]?.text, "先说一句 ");
  assert.equal(nodes[0]?.style, "");
  assert.equal(nodes[1]?.type, "prompt-mention");
  assert.equal(nodes[2]?.text, " 目标正文");
  assert.equal(nodes[2]?.style, GOAL_SCOPE_TEXT_CSS_TEXT);
  assert.equal(markdown, "先说一句 /goal 目标正文");
});

test("原大小写保留在 markdown，芯片 value 归一小写", () => {
  const editor = createTestEditor();
  restore(editor, "/GOAL 大写目标", { restoreGoalCommand: true });

  const { nodes, markdown } = flatten(editor);
  assert.equal(nodes[0]?.mention?.markdown, "/GOAL");
  assert.equal(nodes[0]?.mention?.value, "goal");
  assert.equal(markdown, "/GOAL 大写目标");
});

test("整框最多一枚芯片：第二段 token 保持纯文本", () => {
  const editor = createTestEditor();
  restore(editor, "/goal 第一段\n\n/goal 第二段", { restoreGoalCommand: true });

  const { nodes } = flatten(editor);
  const chips = nodes.filter((node) => node.type === "prompt-mention");
  assert.equal(chips.length, 1);
  // 第二段的 token 仍是文本节点（由文本匹配着色，与手打表现一致）。
  const secondParagraphNodes = nodes.slice(2);
  assert.ok(secondParagraphNodes.every((node) => node.type !== "prompt-mention"));
  assert.equal(secondParagraphNodes.map((node) => node.text).join(""), "/goal 第二段");
});

test("不传开关（sendText/旧 snapshot）：维持纯文本回填，文本匹配染色照旧", () => {
  const editor = createTestEditor();
  restore(editor, "/goal 完成计划");

  const { nodes, markdown } = flatten(editor);
  assert.ok(nodes.every((node) => node.type !== "prompt-mention"));
  // 既有行为：token 与正文同处一个 TextNode 时被 transform 切开，后半段染蓝。
  assert.equal(nodes[0]?.text, "/goal");
  assert.equal(nodes[0]?.style, "");
  assert.equal(nodes[1]?.text, " 完成计划");
  assert.equal(nodes[1]?.style, GOAL_SCOPE_TEXT_CSS_TEXT);
  assert.equal(markdown, "/goal 完成计划");
});

test("正文里的 canonical 链接不因切 token 丢还原能力", () => {
  const editor = createTestEditor();
  // 相对路径 destination 走文件分支（restoreMentionLinkPayload 既有口径）。
  restore(editor, "/goal 看 [文件](src/a.txt) 之后再做", { restoreGoalCommand: true });

  const { nodes, markdown } = flatten(editor);
  const types = nodes.map((node) => node.type);
  assert.deepEqual(types, ["prompt-mention", "text", "prompt-mention", "text"]);
  // 文件芯片显示 basename（fileDisplay 既有口径），category 才是身份。
  assert.equal(nodes[2]?.mention?.category, "files");
  assert.equal(nodes[2]?.text, "a.txt");
  assert.equal(markdown, "/goal 看 [文件](src/a.txt) 之后再做");
});
