import assert from "node:assert/strict";
import test from "node:test";
import { resolveAboutWindowPosition, shouldUseAboutWindowModal } from "../src/main/about.js";

test("macOS 即使有父窗口也不把关于面板做成 modal sheet", () => {
  assert.equal(shouldUseAboutWindowModal(true, "darwin"), false);
  assert.equal(shouldUseAboutWindowModal(false, "darwin"), false);
});

test("Windows / Linux 在有父窗口时用 modal 挡住父窗口", () => {
  assert.equal(shouldUseAboutWindowModal(true, "win32"), true);
  assert.equal(shouldUseAboutWindowModal(true, "linux"), true);
  assert.equal(shouldUseAboutWindowModal(false, "win32"), false);
  assert.equal(shouldUseAboutWindowModal(false, "linux"), false);
});

test("关于面板相对父窗口内容区水平居中并贴顶", () => {
  assert.deepEqual(
    resolveAboutWindowPosition({ x: 100, y: 80, width: 800, height: 600 }, { width: 256, height: 320 }),
    { x: 372, y: 80 },
  );
});
