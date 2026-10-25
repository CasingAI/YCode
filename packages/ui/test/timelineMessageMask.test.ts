import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMELINE_MESSAGE_MASK_FADE_PX,
  TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
  resolveTimelineMessageMask,
} from "../src/v4/timelineMessageMask.js";

const baseInput = {
  atBottom: false,
  viewportHeight: 600,
  hasComposerDock: true,
  layerTopOffsetPx: 0,
};

test("没有 composer dock 时不施加遮罩：只读面板底部不留遮挡带", () => {
  assert.equal(
    resolveTimelineMessageMask({
      ...baseInput,
      hasComposerDock: false,
    }),
    null,
  );
});

test("同样的离底场景：有 dock 才有遮挡带，只读面板没有", () => {
  // 只读子代理面板的复现场景：同一份离底几何，有 composer dock 的面板底部会
  // 多出一段 96px 全透明 + 24px 渐隐的空白带，只读面板不该有这段死区。
  const withDock = resolveTimelineMessageMask({
    ...baseInput,
    hasComposerDock: true,
  });
  assert.notEqual(withDock, null);
  assert.equal(
    resolveTimelineMessageMask({
      ...baseInput,
      hasComposerDock: false,
    }),
    null,
  );
});

test("有 composer dock 且贴底时不施加遮罩", () => {
  assert.equal(
    resolveTimelineMessageMask({
      ...baseInput,
      atBottom: true,
    }),
    null,
  );
});

test("有 composer dock 且离底时遮挡带几何保持 96px 全透明 + 24px 渐隐", () => {
  const style = resolveTimelineMessageMask(baseInput);
  assert.notEqual(style, null);
  const transparentStart = baseInput.viewportHeight - TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX;
  const opaqueEnd = transparentStart - TIMELINE_MESSAGE_MASK_FADE_PX;
  assert.equal(
    style?.maskImage,
    `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`,
  );
  assert.equal(style?.maskSize, `100% ${baseInput.viewportHeight}px`);
});

test("遮罩位置跟随消息层相对滚动视口的偏移", () => {
  assert.equal(
    resolveTimelineMessageMask({ ...baseInput, layerTopOffsetPx: 120 })?.maskPosition,
    "0 120px",
  );
  // 偏移为负（消息层顶边在视口之上）时钳到 0，不产生负偏移的遮罩起点。
  assert.equal(
    resolveTimelineMessageMask({ ...baseInput, layerTopOffsetPx: -30 })?.maskPosition,
    "0 0px",
  );
});

test("视口过矮时不遮罩：遮挡带高于视口会把整屏正文裁成透明", () => {
  assert.equal(resolveTimelineMessageMask({ ...baseInput, viewportHeight: 0 }), null);
  assert.equal(resolveTimelineMessageMask({ ...baseInput, viewportHeight: -10 }), null);
  assert.equal(resolveTimelineMessageMask({ ...baseInput, viewportHeight: Number.NaN }), null);
  // 视口比遮挡带还矮（< 96px）：渐变会从 0px 起就是透明的，整屏正文会一起消失。
  assert.equal(resolveTimelineMessageMask({ ...baseInput, viewportHeight: 60 }), null);
  assert.equal(resolveTimelineMessageMask({ ...baseInput, viewportHeight: 96 }), null);
});

test("视口刚好装下遮挡带时，渐变从可见段末尾才开始透明", () => {
  const style = resolveTimelineMessageMask({ ...baseInput, viewportHeight: 120 });
  assert.notEqual(style, null);
  const transparentStart = 120 - TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX;
  const opaqueEnd = Math.max(0, transparentStart - TIMELINE_MESSAGE_MASK_FADE_PX);
  assert.equal(
    style?.maskImage,
    `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`,
  );
  assert.equal(style?.maskSize, "100% 120px");
});
