import assert from "node:assert/strict";
import test from "node:test";
import { resolveStartupBrandPresentation } from "../src/root/startupBrandPresentation.js";
import { STARTUP_BRAND_FACES } from "../src/root/startupBrandTiming.js";

// 两阶段形态必须互斥：字形与 App 图标位图同屏（或图标静止停在轮播里）会被读成
// 「表情外面围了一圈粗边框」。曾经把收尾改成定格字形、把图标整个删掉，也是错的：
// 阶段 2 必须是图标弹出。两条都靠这里钉住。

test("阶段 1 轮播裸字形，不出现图标位图", () => {
  const presentation = resolveStartupBrandPresentation("emojiSequence", false);
  assert.deepEqual(presentation.faces, STARTUP_BRAND_FACES);
  assert.equal(presentation.cycling, true);
  assert.equal(presentation.badgeVisible, false);
});

test("阶段 2 只出 App 图标位图，字形全部退出", () => {
  const presentation = resolveStartupBrandPresentation("emojiSequence", true);
  assert.deepEqual(presentation.faces, []);
  assert.equal(presentation.cycling, false);
  assert.equal(presentation.badgeVisible, true);
});

test("静态态只给首帧字形：不轮播，也不出图标位图", () => {
  const presentation = resolveStartupBrandPresentation("staticFace", false);
  assert.deepEqual(presentation.faces, [STARTUP_BRAND_FACES[0]]);
  assert.equal(presentation.cycling, false);
  assert.equal(presentation.badgeVisible, false);
  // 静态态忽略 settled：迁移/失败态没有「就绪」这一步。
  assert.deepEqual(
    resolveStartupBrandPresentation("staticFace", true),
    resolveStartupBrandPresentation("staticFace", false),
  );
});

test("任一阶段都不出现字形与图标同屏", () => {
  for (const mode of ["emojiSequence", "staticFace"] as const) {
    for (const settled of [false, true]) {
      const { faces, badgeVisible } = resolveStartupBrandPresentation(mode, settled);
      assert.ok(!(faces.length > 0 && badgeVisible), `${mode}/${settled} 同时显示了字形与图标`);
    }
  }
});
