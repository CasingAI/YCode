// ============================================================
// 工具输入校验投影回归：runtime-only 失败必须生成模型可读错误
// ============================================================
// 原因与修复依据：validateInitialModelToolInput 曾在 JSON Schema 粗检通过时
// 提前返回，把 runtimeValidationIssues 整批丢弃；Sandbox「code/filePath
// 二选一」这类 superRefine 规则因此穿透到 handler 内裸 parse 抛 ZodError，
// 模型与 UI 只能收到未翻译的内部 issue JSON（线上实例：gpt-6.1-sol 子代理
// 同时传 code + filePath:"/dev/null" 连续四次撞同一句天书后原样重试）。
// 本文件锁定四条不变量：
// 1. 粗检通过 + 运行时规则失败 → 仍产出带可读 modelContent 的校验错误；
// 2. custom（refine/superRefine）issue 的投影是完整句子，不落 JSON 兜底；
// 3. 粗检与 runtime 全部通过 → 放行不变；
// 4. 纯参数类错误（缺参数等）的既有可读文案不回退。

import assert from "node:assert/strict";
import test from "node:test";
import { prepareInitialToolExecutionInput } from "../src/tool/input-normalization.js";
import { createInitialInputValidationModelContent } from "../src/tool/input-validation-model-content.js";
import {
  getInitialInputValidationModelContent,
  validateInitialModelToolInput,
} from "../src/tool/executor/validation.js";
import { sandboxToolEntry } from "../src/tool/handlers/sandbox.js";

test("runtime-only 失败（二选一都给）→ 粗检通过仍产出校验错误，文案点名字段", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: sandboxToolEntry,
    input: { description: "都给", code: "return 1;", filePath: "/work/a.js" },
  });
  assert.ok(prepared.runtimeValidationIssues?.length, "superRefine 失败应产生 runtime issues");
  const error = validateInitialModelToolInput(
    prepared.input,
    sandboxToolEntry,
    prepared.runtimeValidationIssues,
  );
  assert.ok(error, "runtime-only 失败必须在校验层拦截，不得穿透到 handler");
  const modelContent = getInitialInputValidationModelContent(error);
  assert.ok(modelContent?.includes("<tool_use_error>InputValidationError:"));
  assert.match(modelContent ?? "", /exactly one of `code` and `filePath`/);
  assert.ok(modelContent?.includes("both were provided"));
  assert.ok(modelContent?.includes("remove one of them"));
  // 不再是原始 issue JSON 数组（`"code": "custom"` 是 zod 内部格式的指纹）。
  assert.doesNotMatch(modelContent ?? "", /"code":\s*"custom"/);
});

test("runtime-only 失败（二选一都不给）→ 文案给出补齐动作", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: sandboxToolEntry,
    input: { description: "都不给" },
  });
  const error = validateInitialModelToolInput(
    prepared.input,
    sandboxToolEntry,
    prepared.runtimeValidationIssues,
  );
  assert.ok(error);
  const modelContent = getInitialInputValidationModelContent(error);
  assert.match(modelContent ?? "", /neither was provided/);
  assert.ok(modelContent?.includes("add one of them"));
  assert.doesNotMatch(modelContent ?? "", /"code":\s*"custom"/);
});

test("粗检与 runtime 全部通过 → 不产生错误（放行不变量）", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: sandboxToolEntry,
    input: { description: "算一下", code: "return 1;" },
  });
  assert.equal(prepared.runtimeValidationIssues, undefined);
  assert.equal(
    validateInitialModelToolInput(prepared.input, sandboxToolEntry, undefined),
    undefined,
  );
});

test("custom issue 投影为完整句子，不落 JSON 兜底", () => {
  const content = createInitialInputValidationModelContent(
    sandboxToolEntry,
    [],
    [{ code: "custom", message: "Custom rule violated.", path: [] }],
  );
  assert.match(
    content,
    /<tool_use_error>InputValidationError: Sandbox failed due to the following issue:\nCustom rule violated\.<\/tool_use_error>/,
  );
  assert.doesNotMatch(content, /"code":\s*"custom"/);
});

test("纯参数类错误（缺 description）→ 既有可读文案不回退", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: sandboxToolEntry,
    input: { code: "return 1;" },
  });
  const error = validateInitialModelToolInput(
    prepared.input,
    sandboxToolEntry,
    prepared.runtimeValidationIssues,
  );
  assert.ok(error);
  const modelContent = getInitialInputValidationModelContent(error);
  assert.match(modelContent ?? "", /The required parameter `description` is missing/);
});
