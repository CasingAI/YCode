import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowCompositingRepaintEvents } from "../src/main/windowCompositingRepaint.js";

// Windows Acrylic 已有 resize/show 兜底，行为不能在这次改动里回退。
test("Windows：保留 resize 与 show 两条兜底事件", () => {
  assert.deepEqual(resolveWindowCompositingRepaintEvents("win32"), ["resized", "show"]);
});

// macOS 主窗口默认一直 visible，从后台或被遮挡状态重新激活只发 focus/restore，
// 不发 show；只绑 resize/show 覆盖不到 vibrancy surface 失效的那条路径。
test("macOS：额外覆盖 restore 与 focus", () => {
  assert.deepEqual(resolveWindowCompositingRepaintEvents("darwin"), [
    "resized",
    "show",
    "restore",
    "focus",
  ]);
});

// Linux 是 frameless + transparent，没有宿主合成材质，不引入这条兜底。
test("其他平台不绑定任何事件", () => {
  assert.deepEqual(resolveWindowCompositingRepaintEvents("linux"), []);
});
