// ============================================================
// 工具入参校验错误的可读文案回归
// ============================================================
// 原因与修复依据：formatToolInputValidationError 只翻译了缺参、多参、类型错和
// 自定义规则四类 issue，范围（too_big/too_small）、取值（invalid_value）、格式
// （invalid_format）、联合分支（invalid_union）会整批落进 JSON 兜底，被
// `JSON.stringify(issues, null, 2)` 当成错误正文。线上实例：TaskOutput 的
// `timeout` 超过 300000 时，UI 失败气泡直接显示
// `[{"origin":"number","code":"too_big","maximum":300000,...}]`，用户和模型都
// 读不出是哪个参数超了上限。
// 本文件锁定：不变量——
// 1. 已知 issue code 全部翻译成人话，不出现内部 issue JSON；
// 2. 范围文案给出参数名与上限，字符串/数组带单位；
// 3. 未知 code 仍走 JSON 兜底，字段顺序不变。

import assert from "node:assert/strict";
import test from "node:test";
import { prepareInitialToolExecutionInput } from "../src/tool/input-normalization.js";
import { createInitialInputValidationModelContent } from "../src/tool/input-validation-model-content.js";
import {
  getInitialInputValidationModelContent,
  validateInitialModelToolInput,
} from "../src/tool/executor/validation.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import {
  createInvalidFormatIssue,
  createInvalidUnionIssue,
  createInvalidValueIssue,
  createTooBigIssue,
  createTooSmallIssue,
  type ToolInputValidationIssue,
} from "../src/tool/tool-input-validation-issues.js";

test("TaskOutput timeout 超上限 → 文案点名字段与上限，不落 JSON 兜底", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: taskOutputToolEntry,
    input: { task_id: "exec_1", block: true, timeout: 600000 },
  });
  assert.ok(prepared.runtimeValidationIssues?.length, "runtime schema 应产生 too_big issue");

  const error = validateInitialModelToolInput(
    prepared.input,
    taskOutputToolEntry,
    prepared.runtimeValidationIssues,
  );
  assert.ok(error, "超上限的 timeout 必须在校验层被拦截");

  const modelContent = getInitialInputValidationModelContent(error) ?? "";
  assert.match(modelContent, /The parameter `timeout` must be at most 300000/);
  assert.doesNotMatch(modelContent, /"code":\s*"too_big"/);
  assert.doesNotMatch(modelContent, /"origin":\s*"number"/);

  // UI 的失败气泡与错误行消费的是 CoreError.message，必须与模型通道同一份文案。
  assert.match(error.message, /The parameter `timeout` must be at most 300000/);
  assert.doesNotMatch(error.message, /"code":\s*"too_big"/);
});

test("数值下界 → 文案给出下界", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [createTooSmallIssue("number", 0, ["timeout"])],
    undefined,
  );
  assert.match(content, /The parameter `timeout` must be at least 0/);
  assert.doesNotMatch(content, /"code":\s*"too_small"/);
});

test("字符串长度上限 → 文案带 characters 单位", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [createTooBigIssue("string", 20, ["task_id"])],
    undefined,
  );
  assert.match(content, /The parameter `task_id` must be at most 20 characters/);
});

test("数组元素上限 → 文案带 items 单位", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [createTooBigIssue("array", 5, ["items"])],
    undefined,
  );
  assert.match(content, /The parameter `items` must be at most 5 items/);
});

test("枚举取值非法 → 文案列出候选值", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [createInvalidValueIssue(["read", "write"], ["mode"])],
    undefined,
  );
  assert.match(content, /The parameter `mode` must be one of "read" \| "write"/);
});

test("格式非法 → 文案带上格式说明", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [createInvalidFormatIssue("url", "Invalid URL", ["target"])],
    undefined,
  );
  assert.match(content, /The parameter `target` is invalid: Invalid URL/);
});

test("联合分支 → 文案说明没有匹配任何分支，并列出各分支明细", () => {
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [
      createInvalidUnionIssue(
        [
          [createTooBigIssue("number", 10, ["count"])],
          [createInvalidValueIssue(["a"], ["kind"])],
        ],
        ["payload"],
      ),
    ],
    undefined,
  );
  assert.match(content, /The parameter `payload` does not match any of the expected shapes:/);
  assert.match(content, /- The parameter `count` must be at most 10/);
  assert.match(content, /- The parameter `kind` must be "a"/);
});

test("未知 code → 仍走 JSON 兜底，字段顺序不变", () => {
  const unknownIssue = {
    code: "future_code",
    path: ["timeout"],
    message: "Too big: expected number to be <=300000",
  } as unknown as ToolInputValidationIssue;
  const content = createInitialInputValidationModelContent(
    taskOutputToolEntry,
    [unknownIssue],
    undefined,
  );
  assert.match(content, /"code": "future_code"/);
  assert.match(content, /"path": \[\n\s+"timeout"\n\s+\]/);
});
