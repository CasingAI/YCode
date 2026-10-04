import assert from "node:assert/strict";
import test from "node:test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type LexicalEditor,
} from "lexical";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "../src/mentions/nodes/PromptMentionNode.js";
import { $getPromptMarkdown } from "../src/mentions/promptSerialization.js";
import { $demoteTopLevelCommandMentionIfMisplaced } from "../src/prompt-editor/topLevelCommandPlacement.js";

// 顶格命令的持续位置约束（docs/specs/goal-command-scope-and-decoration.md
// 「位置语义与显示对齐」）。
//
// 插入时刻的位置门控只覆盖「刚敲完 `/compact` 的那一瞬间」。芯片落进树里之后，用户回到
// 行首补一句字就会把它挪到句中，若没有持续校验，编辑器会画出命令芯片、参数染蓝，发送端
// 却按纯文本下发。这组用例用 headless editor 走真实节点树，覆盖截图复现的形状。

function createTestEditor(): LexicalEditor {
  return createEditor({ nodes: [PromptMentionNode] });
}

/** 命令芯片的载荷与 `buildSlashApplyMentionPayload` 对齐：canonical 就是 `/name`。 */
function commandMention(value: string) {
  return $createPromptMentionNode({
    id: `slash:${value}`,
    category: "commands",
    label: value,
    value,
    markdown: `/${value}`,
    description: "",
  });
}

/** 在编辑器里执行一次离散更新并读回结果；discrete 让 update 同步提交，测试无需等待。 */
function runEditor(
  editor: LexicalEditor,
  update: () => void,
): { markdown: string; demoted: boolean } {
  let demoted = false;
  editor.update(
    () => {
      update();
      const root = $getRoot();
      for (const child of root.getChildren()) {
        if (!$isElementNode(child)) continue;
        for (const node of child.getChildren()) {
          if ($demoteTopLevelCommandMentionIfMisplaced(node)) demoted = true;
        }
      }
    },
    { discrete: true },
  );
  const markdown = editor.getEditorState().read(() => $getPromptMarkdown());
  return { markdown, demoted };
}

/** 读回树里还剩几枚 mention 芯片；降级后应为 0。 */
function countMentionNodes(editor: LexicalEditor): number {
  return editor.getEditorState().read(() => {
    let count = 0;
    for (const child of $getRoot().getChildren()) {
      if (!$isElementNode(child)) continue;
      for (const node of child.getChildren()) {
        if ($isPromptMentionNode(node)) count += 1;
      }
    }
    return count;
  });
}

test("顶格命令芯片不被降级", () => {
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const paragraph = $createParagraphNode();
    paragraph.append(commandMention("compact"), $createTextNode(" 12313123"));
    $getRoot().append(paragraph);
  });
  assert.equal(result.demoted, false);
  assert.equal(countMentionNodes(editor), 1);
});

test("芯片前面补字后降级为普通文本，canonical 保持 /compact", () => {
  // 截图复现：Compact 芯片建好后，用户回到行首打了 12313213。
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode("12313213 "), commandMention("compact"));
    paragraph.append($createTextNode(" 12313123"));
    $getRoot().append(paragraph);
  });
  assert.equal(result.demoted, true);
  assert.equal(countMentionNodes(editor), 0);
  // 降级不改变这条消息的内容：用户看到的字就是会被下发的字。
  assert.equal(result.markdown, "12313213 /compact 12313123");
});

test("压缩别名同样按位置判定，大小写不影响", () => {
  for (const value of ["compress", "Compact"]) {
    const editor = createTestEditor();
    const result = runEditor(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("前面 "), commandMention(value));
      $getRoot().append(paragraph);
    });
    assert.equal(result.demoted, true, value);
    assert.equal(countMentionNodes(editor), 0, value);
  }
});

test("plan / init 走同一套位置约束", () => {
  for (const value of ["plan", "init"]) {
    const editor = createTestEditor();
    const result = runEditor(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("前面 "), commandMention(value));
      $getRoot().append(paragraph);
    });
    assert.equal(result.demoted, true, value);
  }
});

test("goal / target 芯片句中不算错位，永远不降级", () => {
  // goal 的句中命中本来就是命令语义（`goal-command-token.ts`），不受顶格约束。
  for (const value of ["goal", "target"]) {
    const editor = createTestEditor();
    const result = runEditor(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("前面 "), commandMention(value), $createTextNode(" 修复"));
      $getRoot().append(paragraph);
    });
    assert.equal(result.demoted, false, value);
    assert.equal(countMentionNodes(editor), 1, value);
  }
});

test("第二个段落开头的芯片同样算错位", () => {
  // 顶格判定看整条输入而非仅本段：发送端 `parseV4VisibleSlashCommand` 只认整串顶格。
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const first = $createParagraphNode();
    first.append($createTextNode("先说一句话"));
    const second = $createParagraphNode();
    second.append(commandMention("compact"));
    $getRoot().append(first, second);
  });
  assert.equal(result.demoted, true);
  assert.equal(countMentionNodes(editor), 0);
});

test("前面的段落只有空白时不算错位", () => {
  // 空白不是正文：顶格判定与面板过滤、发送端 trim 后判定同口径。
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const first = $createParagraphNode();
    first.append($createTextNode("   "));
    const second = $createParagraphNode();
    second.append(commandMention("compact"));
    $getRoot().append(first, second);
  });
  assert.equal(result.demoted, false);
  assert.equal(countMentionNodes(editor), 1);
});

test("非命令类 mention 不受影响", () => {
  // skills 的 `$`、subagent 的 `@` 是 mention 载荷，不参与位置语义。
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const paragraph = $createParagraphNode();
    paragraph.append(
      $createTextNode("前面 "),
      $createPromptMentionNode({
        id: "skill:review",
        category: "skills",
        label: "review",
        value: "review",
        markdown: "$review",
        description: "",
      }),
    );
    $getRoot().append(paragraph);
  });
  assert.equal(result.demoted, false);
  assert.equal(countMentionNodes(editor), 1);
});

test("普通文本节点不会被降级函数误伤", () => {
  const editor = createTestEditor();
  const result = runEditor(editor, () => {
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode("前面 /compact 12313123"));
    $getRoot().append(paragraph);
  });
  assert.equal(result.demoted, false);
  assert.equal(result.markdown, "前面 /compact 12313123");
  const isText = editor.getEditorState().read(() => $isTextNode($getRoot().getFirstDescendant()));
  assert.equal(isText, true);
});
