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

test("问题行是混排结构：控件组浮动在右、正文块在后，容器清除浮动", () => {
  const questionRow = readSourceSection(
    "{/* 控件组浮在右上、正文环绕",
    'data-elicitation-dialog-footer="true"',
  );
  assert.match(questionRow, /<div className="flow-root">/, "问题行容器必须建立块格式化上下文");
  assert.match(
    questionRow,
    /className="float-right mb-1 ml-3 flex shrink-0 items-center gap-1 whitespace-nowrap/,
    "控件组右浮动、不断行、不被正文挤散",
  );
  const floatIndex = questionRow.indexOf("float-right");
  const bodyIndex = questionRow.indexOf('data-elicitation-question-text="true"');
  assert.ok(
    floatIndex !== -1 && bodyIndex !== -1 && floatIndex < bodyIndex,
    "浮动组必须在正文块之前入 DOM，否则环绕不生效",
  );
  assert.doesNotMatch(
    questionRow,
    /flex items-start justify-between gap-3/,
    "问题行不得再用左右两列 flex，整段高度让位正是要删掉的结构",
  );
});

test("单题时分页组不挂载，理由是无信息量而非省空间", () => {
  const paginationGroup = readSourceSection(
    "{hasMultipleQuestions ? (",
    "aria-label={dialogCollapseLabel}",
  );
  assert.match(paginationGroup, /id: "chat\.elicitation\.previousQuestion"/, "分页组内保留上一页");
  assert.match(paginationGroup, /id: "chat\.elicitation\.nextQuestion"/, "分页组内保留下一页");
  assert.match(paginationGroup, /min-w-10 text-center/, "分页组内保留题目进度");
  assert.doesNotMatch(
    paginationGroup,
    /aria-label=\{dialogCollapseLabel\}/,
    "整卡收起按钮必须留在分页组之外，单题时仍在最右",
  );
});

test("单题判定覆盖空问题列表的兜底态", () => {
  assert.match(
    dialogSource,
    /const hasMultipleQuestions = questions\.length > 1;/,
    "空列表与单题同样不渲染分页，不留 questions.length === 0 的分支",
  );
});

test("分页状态仍由 questionIndex 持有，单题不引入新状态", () => {
  assert.match(
    dialogSource,
    /const canGoPreviousPage = questions\.length > 0 && questionIndex > 0;/,
    "上一页可用性计算保留，多题切回照常工作",
  );
  assert.match(
    dialogSource,
    /const canGoNextPage = questions\.length > 0 && questionIndex < questions\.length - 1;/,
    "下一页可用性计算保留，多题切回照常工作",
  );
});

test("收起态摘要行题目进度与展开态同口径，单题时不显示", () => {
  const summaryRow = readSourceSection(
    "{!isDialogExpanded ? (",
    'data-elicitation-dialog-footer="true"',
  );
  assert.match(
    summaryRow,
    /\{hasMultipleQuestions \? \(\s*<span className="shrink-0/,
    "摘要行进度同样按多题条件挂载，展开收起口径一致",
  );
});
