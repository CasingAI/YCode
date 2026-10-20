import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposerAutoFocus } from "../src/v4/composer/composerAutoFocus.js";

// composer 自动聚焦的三态判定。
//
// 回归背景：移动端跳过自动聚焦的保护曾经是死代码——`focusOptsRef` 把
// `isMobileViewport` 写死为 false，导致手机端在挂载 / 切会话时就把 DOM 焦点抢到
// contenteditable 上，软键盘随之弹出遮挡界面。判定逻辑本身没错，错的是入参。
//
// 这里覆盖三态（focus-now / defer / skip）与两种意图（ambient 环境驱动 /
// explicit 用户驱动）的组合，确保移动端只跳过 ambient、不误伤 explicit。

const DESKTOP = { autoFocusEnabled: true, disabled: false, isMobileViewport: false };
const MOBILE = { autoFocusEnabled: true, disabled: false, isMobileViewport: true };

test("桌面端：环境驱动在 composer 可编辑时立即聚焦", () => {
  assert.equal(resolveComposerAutoFocus({ ...DESKTOP, intent: "ambient" }), "focus-now");
  // 不传 intent 时默认按环境驱动处理。
  assert.equal(resolveComposerAutoFocus(DESKTOP), "focus-now");
});

test("桌面端：环境驱动在 composer 暂不可编辑时暂存意图", () => {
  assert.equal(
    resolveComposerAutoFocus({ ...DESKTOP, disabled: true, intent: "ambient" }),
    "defer",
  );
});

test("移动端：环境驱动一律跳过，且不暂存意图", () => {
  // 可编辑时跳过：挂载 / 切会话 / 新建任务都不该在手机上拉起软键盘。
  assert.equal(resolveComposerAutoFocus({ ...MOBILE, intent: "ambient" }), "skip");
  // 不可编辑时同样跳过——移动端排队等一次聚焦，等来的那次照样会弹键盘。
  assert.equal(resolveComposerAutoFocus({ ...MOBILE, disabled: true, intent: "ambient" }), "skip");
});

test("移动端：用户驱动的聚焦仍然执行", () => {
  // 队列撤回恢复草稿、外部文本预填、代码评论「加到对话」——用户已经表达了
  // 「我要在这里输入」，聚焦是操作的一部分。
  assert.equal(resolveComposerAutoFocus({ ...MOBILE, intent: "explicit" }), "focus-now");
  assert.equal(
    resolveComposerAutoFocus({ ...MOBILE, disabled: true, intent: "explicit" }),
    "defer",
  );
});

test("未启用自动聚焦的 pane 一律跳过，两种意图都不聚焦", () => {
  const disabledPane = { ...DESKTOP, autoFocusEnabled: false };
  assert.equal(resolveComposerAutoFocus({ ...disabledPane, intent: "ambient" }), "skip");
  assert.equal(resolveComposerAutoFocus({ ...disabledPane, intent: "explicit" }), "skip");
});
