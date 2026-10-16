import assert from "node:assert/strict";
import test from "node:test";
import { renderReasoningInlineBold } from "../src/components/ai-elements/reasoning.js";

// 思考内容是纯文本渲染（性能原因不走完整 Markdown 解析），
// 只有 `**加粗**` 额外渲染成 strong。这里只断言分段结构，不挂载 DOM。

test("无加粗标记时原样返回字符串", () => {
  assert.equal(renderReasoningInlineBold("纯文本思考"), "纯文本思考");
});

test("成对加粗标记渲染成 strong 节点", () => {
  const result = renderReasoningInlineBold("**Analyzing quirks** and planning");
  assert.ok(Array.isArray(result));
  const [first, second] = result as { props: { children: string } }[];
  assert.equal(first?.props.children, "Analyzing quirks");
  assert.equal(second, " and planning");
});

test("未闭合的标记保持原文，不闪烁", () => {
  assert.equal(renderReasoningInlineBold("半截 **加粗"), "半截 **加粗");
});

test("多段加粗各自成节点，段间文本保留", () => {
  const result = renderReasoningInlineBold("**A**\n\nB\n\n**C**");
  assert.ok(Array.isArray(result));
  assert.equal((result as unknown[]).length, 3);
});
