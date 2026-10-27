import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// SessionPane 接线（源码断言式，与 goalModeGate / conversationDraftEmptyState 同形态）：
// errored 态历史保留 + 只读门禁（docs/specs/session-subscription-error-panel.md）。
// ui 包测试无组件渲染宿主，SessionPane 依赖整棵 store/transport 树，只能钉源码要点。

const pane = readFileSync(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");

test("errored 定义与 timelineSnapshot 身份匹配保持原样", () => {
  assert.match(pane, /const errored = sessionId !== null && state\.status === "error";/);
  // 历史保留复用 timelineSnapshot 的身份匹配，不另起一份错判定。
  assert.match(
    pane,
    /const timelineSnapshot =\s*\n\s*!isDraft &&\s*\(lease === null \|\| sessionLeaseReady\) &&\s*snapshot\?\.sessionId === sessionId/,
  );
  // 遥测曝光口径不变（紧凑横幅与完整面板同属可见错误面）。
  assert.match(
    pane,
    /visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled/,
  );
});

test("errored 且有历史：只读 timeline + 紧凑横幅；无历史才整块空态面板", () => {
  assert.match(pane, /const erroredWithHistory = errored && timelineSnapshot !== null;/);

  const panelIdx = pane.indexOf("<SessionSubscriptionErrorPanel");
  const timelineIdx = pane.indexOf("<ConversationTimeline");
  const noticeIdx = pane.indexOf("<SessionSubscriptionErrorNotice");
  assert.notEqual(panelIdx, -1);
  assert.notEqual(timelineIdx, -1);
  assert.notEqual(noticeIdx, -1);

  const conditionalIdx = pane.indexOf("errored && !erroredWithHistory");
  assert.notEqual(conditionalIdx, -1, "完整面板必须只在无历史时渲染");
  // 面板在条件分支内、timeline 仍在 else 分支（历史不再被整块替换）、横幅在其后。
  assert.ok(conditionalIdx < panelIdx, "面板应位于 errored && !erroredWithHistory 条件分支内");
  assert.ok(panelIdx < timelineIdx, "有历史时 timeline 仍在面板之后渲染");
  assert.ok(timelineIdx < noticeIdx, "紧凑横幅必须渲染在 timeline 之后");

  // 横幅走同一重连接入口。
  const noticeBlock = pane.slice(noticeIdx, noticeIdx + 400);
  assert.match(noticeBlock, /onReconnect=\{handleRetrySubscribe\}/);
  assert.match(noticeBlock, /sessionId=\{sessionId\}/);
});

test("errored 关闭 composer 与行级命令入口（断线不可提交）", () => {
  const composerIdx = pane.indexOf("const composerNode = readOnly ? null :");
  assert.notEqual(composerIdx, -1);
  const disabledIdx = pane.indexOf("disabled={", composerIdx);
  assert.notEqual(disabledIdx, -1);
  const disabledBlock = pane.slice(disabledIdx, disabledIdx + 600);
  assert.match(disabledBlock, /connecting/);
  assert.match(disabledBlock, /errored/, "composer 不得在断线时接受提交");

  assert.match(
    pane,
    /const retryActionsEnabled =\s*!readOnly && !selectionSideChat && Boolean\(sessionId\) && !errored;/,
  );
  assert.match(
    pane,
    /const forkActionsEnabled =\s*!readOnly && !selectionSideChat && Boolean\(sessionId\) && !errored;/,
  );
  assert.match(
    pane,
    /const editActionsEnabled =\s*!readOnly && !selectionSideChat && Boolean\(sessionId\) && !errored;/,
  );
  // 断言需兼容格式化换行，同时保留三个禁用条件的顺序约束。
  assert.match(pane, /onPauseGoal=\{\s*!readOnly\s*&&\s*!selectionSideChat\s*&&\s*!errored/);
  assert.match(pane, /onResumeGoal=\{\s*!readOnly\s*&&\s*!selectionSideChat\s*&&\s*!errored/);
});
