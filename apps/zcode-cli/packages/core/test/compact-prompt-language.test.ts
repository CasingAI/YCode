import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactPrompt } from "../src/compact/prompt.js";

// 压缩总结的语言必须跟随用户对话语言，而不是跟随英文指令本体或 UI 语言。
// 这里锁住语言指令的存在性，以及与 customInstructions 拼接时不丢失、位置正确。

test("buildCompactPrompt 包含跟随用户对话语言的输出要求", () => {
  const prompt = buildCompactPrompt(undefined);
  assert.match(prompt, /primary language the user has been using/i);
  assert.match(prompt, /Do not switch to English/i);
});

test("buildCompactPrompt 携带 customInstructions 时语言指令仍保留", () => {
  const prompt = buildCompactPrompt("focus on typescript code changes");
  assert.match(prompt, /primary language the user has been using/i);
  assert.match(prompt, /focus on typescript code changes/);
  // 语言指令位于正文要求之后、附加指令说明之前，不被 customInstructions 挤掉。
  const languageIndex = prompt.search(/primary language the user has been using/i);
  const additionalIndex = prompt.indexOf("Additional Instructions:");
  assert.ok(languageIndex !== -1 && additionalIndex !== -1 && languageIndex < additionalIndex);
});
