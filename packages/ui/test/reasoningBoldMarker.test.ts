import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveReasoningStreamingSummary,
  stripReasoningBoldMarkers,
} from "../src/components/ai-elements/reasoning.js";

// 思考内容按纯文本展示，只移除成对的 Markdown 加粗标记。

test("无加粗标记时原样返回字符串", () => {
  assert.equal(stripReasoningBoldMarkers("纯文本思考"), "纯文本思考");
});

test("成对加粗标记被移除但文字保留", () => {
  assert.equal(
    stripReasoningBoldMarkers("**Analyzing quirks** and planning"),
    "Analyzing quirks and planning",
  );
});

test("未闭合的标记保持原文", () => {
  assert.equal(stripReasoningBoldMarkers("半截 **加粗"), "半截 **加粗");
});

test("多段标记被移除且段间文本保留", () => {
  assert.equal(stripReasoningBoldMarkers("**A**\n\nB\n\n**C**"), "A\n\nB\n\nC");
});

test("进行中摘要移除成对星号标记", () => {
  assert.deepEqual(resolveReasoningStreamingSummary("检查图片\n**Verifying PNG data**"), {
    key: "1",
    text: "Verifying PNG data",
  });
});

test("进行中摘要保留未闭合的流式标记", () => {
  assert.deepEqual(resolveReasoningStreamingSummary("**Verifying PNG"), {
    key: "0",
    text: "**Verifying PNG",
  });
});
