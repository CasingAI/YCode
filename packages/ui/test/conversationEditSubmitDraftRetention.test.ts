import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// specs/message-history-edit.md 规则 43 / docs/specs/conversation-edit-undo-confirm.md 规则 8：
// 编辑提交是延迟提交——撤销确认在途期间草稿必须留在编辑器里。确认被取消 / 点遮罩 / Esc
// 关闭时，编辑卡保持打开、文本原样保留。
//
// 回归背景：编辑卡的 onSubmit 早先返回 undefined，Lexical 侧
// shouldResetLexicalEditorAfterSubmit 判定为「要清空」，提交瞬间就把草稿抹掉——
// 用户点遮罩关掉确认框后只剩一个空输入框。ui 包测试为源码断言式（无组件渲染），
// 这里锁定各文件的实现要点防回退。

test("规则 43：编辑卡提交入口按「延迟/拒绝」返回 false，Lexical 不自行 reset", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  assert.match(
    rowView,
    /onSubmit=\{\(nextText\) => \{[\s\S]*?void requestSubmitEdit\(nextText\);[\s\S]*?return false;[\s\S]*?\}\}/,
    "编辑卡 onSubmit 必须返回 false（延迟提交），否则草稿在提交瞬间被清空",
  );

  const editor = read("../src/prompt-editor/ChatPromptEditor.tsx");
  assert.match(
    editor,
    /onSubmit: \(value: string\) => boolean \| void;/,
    "ChatPromptEditor 的 onSubmit 契约必须允许返回 boolean",
  );
  assert.match(
    editor,
    /返回 false 表示业务层拒绝\/延迟本次提交，Lexical 不自行 reset（草稿保留）/,
    "ChatPromptEditor 必须写明 false = 不 reset 的约定",
  );

  const lexical = read("../src/LexicalChatInput.tsx");
  assert.match(
    lexical,
    /function shouldResetLexicalEditorAfterSubmit\(result: LexicalSubmitResult\): boolean \{\s*return result !== false;/,
    "只有显式 false 才跳过 reset；undefined 会被当成「要清空」",
  );
});

test("规则 43：主 composer 与编辑卡同一约定（提交后由业务层自行清草稿）", () => {
  const composer = read("../src/v4/ConversationComposer.tsx");
  const submitHandler = composer.slice(
    composer.indexOf("const handleEditorSubmit = useCallback"),
    composer.indexOf("const handleModifiedEditorSubmit = useCallback"),
  );
  assert.match(
    submitHandler,
    /return false;/,
    "主 composer 提交后返回 false，草稿由 inputApiRef.clear() 在成功后统一清",
  );
});

test("规则 43：确认被取消 / 关闭只清暂存，不动编辑卡草稿", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");

  // 纯对话确认的 dismiss/cancel 分支。
  const confirmBlock = rowView.slice(
    rowView.indexOf("const confirmed = await requestConfirmation("),
    rowView.indexOf('return "preserve";'),
  );
  assert.match(confirmBlock, /setPendingFileRewind\(null\);/);
  assert.match(confirmBlock, /setPendingSubmit\(null\);/);
  assert.ok(!confirmBlock.includes("setDraft("), "取消确认不得复位草稿");

  // 带 Checkbox 的确认分支。
  const choiceBlock = rowView.slice(
    rowView.indexOf("const choice = await requestChoice("),
    rowView.indexOf("return resolveUndoWorkspaceMode(restoreChecked);"),
  );
  assert.match(choiceBlock, /setPendingFileRewind\(null\);/);
  assert.match(choiceBlock, /setPendingSubmit\(null\);/);
  assert.ok(!choiceBlock.includes("setDraft("), "取消确认不得复位草稿");
});

test("规则 43：确认在途期间禁掉第二次提交，避免同一草稿走两条写入路径", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  const submitDisabled = rowView.slice(
    rowView.indexOf("submitDisabled={"),
    rowView.indexOf("allowSubmitWhenEmpty={", rowView.indexOf("submitDisabled={")),
  );
  assert.match(
    submitDisabled,
    /pendingSubmit !== null/,
    "pendingSubmit 非空（确认在途）时必须禁用发送键与 Enter",
  );
});
