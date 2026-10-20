import assert from "node:assert/strict";
import test from "node:test";
import { shouldBlurComposerOnCollapsibleToggle } from "../src/lib/pickerFocus.js";

// 点开时间线折叠块后的焦点让渡决策。
//
// 移动端上折叠触发器的 mousedown preventDefault 会阻止焦点转移，composer 的
// contenteditable 因此仍持有 DOM 焦点；展开引起的高度变化与 scrollTop 补偿再把它
// 滚回视口，软键盘随即弹出遮挡刚展开的内容。移动端需要显式 blur，桌面端保持
// 触发器自然接管焦点。

test("移动端点开折叠块时显式让出 composer 焦点", () => {
  assert.equal(shouldBlurComposerOnCollapsibleToggle({ isCoarseTouchDevice: true }), true);
});

test("桌面端点开折叠块时不干预焦点", () => {
  assert.equal(shouldBlurComposerOnCollapsibleToggle({ isCoarseTouchDevice: false }), false);
});
