import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(new URL("../src/ElicitationDialog.tsx", import.meta.url), "utf8");

function readSourceSection(start: string, end: string): string {
  const startIndex = dialogSource.indexOf(start);
  assert.notEqual(startIndex, -1, `缺少源码片段起点：${start}`);
  const endIndex = dialogSource.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `缺少源码片段终点：${end}`);
  return dialogSource.slice(startIndex, endIndex);
}

test("移动端顶部操作顺序把整框收起按钮放在最右侧", () => {
  const headerControls = readSourceSection(
    'className="flex items-center gap-1 text-ui-base font-medium leading-tight text-foreground-subtlest"',
    "{currentQuestion ? (",
  );
  const previousIndex = headerControls.indexOf("chat.elicitation.previousQuestion");
  const progressIndex = headerControls.indexOf(
    "`${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`",
  );
  const nextIndex = headerControls.indexOf("chat.elicitation.nextQuestion");
  const collapseIndex = headerControls.indexOf("dialogCollapseLabel");

  assert.ok(previousIndex >= 0, "顶部必须保留上一页按钮");
  assert.ok(progressIndex > previousIndex, "题目进度必须位于上一页之后");
  assert.ok(nextIndex > progressIndex, "下一页按钮必须位于题目进度之后");
  assert.ok(collapseIndex > nextIndex, "整框收起按钮必须位于顶部操作区最右侧");
});

test("移动端底部主操作按钮显式右对齐", () => {
  const footer = readSourceSection(
    'data-elicitation-dialog-footer="true"',
    "intl.formatMessage({ id: primaryActionMessageId })",
  );
  const hintIndex = footer.indexOf("chat.elicitation.keyboardHint");
  const actionGroupIndex = footer.indexOf("<div className=", hintIndex);
  const actionGroupTagEnd = footer.indexOf(">", actionGroupIndex);
  const secondaryActionIndex = footer.indexOf("footerSecondaryAction.kind", actionGroupIndex);
  const primaryActionIndex = footer.indexOf(
    "onClick={questions.length === 0 ? submit : continueOrSubmit}",
    actionGroupIndex,
  );

  assert.ok(hintIndex >= 0, "页脚必须保留键盘提示");
  assert.ok(actionGroupIndex > hintIndex, "主操作按钮组必须位于键盘提示之后");
  assert.notEqual(actionGroupTagEnd, -1, "主操作按钮组必须有明确的容器");
  assert.match(
    footer.slice(actionGroupIndex, actionGroupTagEnd),
    /className="[^"]*max-sm:ml-auto[^"]*"/,
    "主操作按钮组必须显式右对齐",
  );
  assert.ok(secondaryActionIndex > actionGroupIndex, "次操作必须位于右对齐按钮组内");
  assert.ok(primaryActionIndex > secondaryActionIndex, "主操作必须位于次操作之后");
});
