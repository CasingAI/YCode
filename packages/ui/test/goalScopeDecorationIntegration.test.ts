import assert from "node:assert/strict";
import test from "node:test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  createEditor,
  type LexicalEditor,
} from "lexical";
import {
  $createPromptMentionNode,
  PromptMentionNode,
} from "../src/mentions/nodes/PromptMentionNode.js";
import { $getPromptMarkdown } from "../src/mentions/promptSerialization.js";
import { $demoteTopLevelCommandMentionIfMisplaced } from "../src/prompt-editor/topLevelCommandPlacement.js";
import { normalizeGoalScopeDecoration } from "../src/prompt-editor/goalScopeDecoration.js";

// 位置语义与作用域着色的联动（docs/specs/goal-command-scope-and-decoration.md
// 「位置语义与显示对齐」）。
//
// 这里把降级与着色放在同一个 headless 编辑器里跑，因为两者单独绿都不够：降级把芯片换成
// 文本节点后，那段 `/compact` 会变成一个「自己看起来顶格」的独立节点，纯文本 token 扫描
// 若不看树位置就会重新认它当命令 token，把后面的参数继续染蓝——显示与执行再次脱节。

function commandChip(value: string) {
  return $createPromptMentionNode({
    id: `slash:${value}`,
    category: "commands",
    label: value,
    value,
    markdown: `/${value}`,
    description: "",
  });
}

/** 跑一遍真实的降级 + 着色链路，顺序与 `LexicalChatInput` 挂的两个插件一致。 */
function settle() {
  const root = $getRoot();
  for (const child of root.getChildren()) {
    if (!$isElementNode(child)) continue;
    for (const node of child.getChildren()) {
      $demoteTopLevelCommandMentionIfMisplaced(node);
    }
  }
  normalizeGoalScopeDecoration(root);
}

function createTestEditor(): LexicalEditor {
  return createEditor({ nodes: [PromptMentionNode] });
}

/** 建出「顶格 compact 芯片 + 参数」的编辑器，对应用户从面板选中命令后的形状。 */
function editorWithTopLevelCompactChip(): LexicalEditor {
  const editor = createTestEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append(commandChip("compact"), $createTextNode(" 12313123"));
      $getRoot().append(paragraph);
      settle();
    },
    { discrete: true },
  );
  return editor;
}

function snapshot(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const nodeTypes: string[] = [];
    const styles: string[] = [];
    for (const child of $getRoot().getChildren()) {
      if (!$isElementNode(child)) continue;
      for (const node of child.getChildren()) {
        nodeTypes.push(node.getType());
        styles.push(node.getStyle());
      }
    }
    return { markdown: $getPromptMarkdown(), nodeTypes, styles };
  });
}

const isColored = (styles: readonly string[]) =>
  styles.some((style) => style.includes("command-node-foreground"));
const countChips = (nodeTypes: readonly string[]) =>
  nodeTypes.filter((type) => type === "prompt-mention").length;

test("顶格 /compact 保留芯片，参数染命令蓝", () => {
  const state = snapshot(editorWithTopLevelCompactChip());
  assert.equal(state.markdown, "/compact 12313123");
  assert.equal(countChips(state.nodeTypes), 1);
  assert.equal(isColored(state.styles), true);
});

test("行首补字后芯片降级，蓝色同帧消失，复制为纯文本", () => {
  // 截图复现：Compact 芯片建好后，用户光标回行首打了 12313213。
  const editor = editorWithTopLevelCompactChip();
  editor.update(
    () => {
      const paragraph = $getRoot().getFirstChildOrThrow<ReturnType<typeof $createParagraphNode>>();
      paragraph.getFirstChildOrThrow().insertBefore($createTextNode("12313213 "));
      settle();
    },
    { discrete: true },
  );

  const state = snapshot(editor);
  assert.equal(state.markdown, "12313213 /compact 12313123");
  assert.equal(countChips(state.nodeTypes), 0);
  // 关键：降级后的 `/compact` 不能因为「自己看起来顶格」被重新认成命令 token。
  assert.equal(isColored(state.styles), false);
});

test("粘贴带前文同样降级且不着色", () => {
  const editor = createTestEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("hello "), commandChip("compact"), $createTextNode(" xxx"));
      $getRoot().append(paragraph);
      settle();
    },
    { discrete: true },
  );

  const state = snapshot(editor);
  assert.equal(state.markdown, "hello /compact xxx");
  assert.equal(countChips(state.nodeTypes), 0);
  assert.equal(isColored(state.styles), false);
});

test("手打句中 /compact xxx 从一开始就不着色", () => {
  // 没有芯片时也要成立：纯文本 token 扫描同样要看位置，否则句中手打也会被染色。
  const editor = createTestEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("关系。/compact 压缩一下"));
      $getRoot().append(paragraph);
      settle();
    },
    { discrete: true },
  );

  assert.equal(isColored(snapshot(editor).styles), false);
});

test("句中 /goal 芯片与目标染蓝不受顶格门控影响", () => {
  const editor = createTestEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("前面 "), commandChip("goal"), $createTextNode(" 修复登录"));
      $getRoot().append(paragraph);
      settle();
    },
    { discrete: true },
  );

  const state = snapshot(editor);
  assert.equal(countChips(state.nodeTypes), 1);
  assert.equal(isColored(state.styles), true);
});

test("顶格手打 /compact 文本同样保留着色", () => {
  const editor = createTestEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("/compact 12313123"));
      $getRoot().append(paragraph);
      settle();
    },
    { discrete: true },
  );

  const state = snapshot(editor);
  assert.equal(state.markdown, "/compact 12313123");
  assert.equal(isColored(state.styles), true);
});

test("降级是幂等的：重复 settle 不改变结果", () => {
  const editor = editorWithTopLevelCompactChip();
  editor.update(
    () => {
      const paragraph = $getRoot().getFirstChildOrThrow<ReturnType<typeof $createParagraphNode>>();
      paragraph.getFirstChildOrThrow().insertBefore($createTextNode("12313213 "));
      settle();
      settle();
      settle();
    },
    { discrete: true },
  );

  const state = snapshot(editor);
  assert.equal(state.markdown, "12313213 /compact 12313123");
  assert.equal(countChips(state.nodeTypes), 0);
  assert.equal(isColored(state.styles), false);
});
