import assert from "node:assert/strict";
import test from "node:test";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PENDING_HISTORY_SLOT_PX,
  TIMELINE_TOP_OCCLUSION_PX,
  resolveJumpOcclusionOffsetPx,
  resolveTurnTopPaddingClass,
  resolveTurnTopPaddingPx,
  turnStartsWithWorkflowNotificationCard,
} from "../src/v4/timelineTopOcclusion.js";

// 轮顶视觉节奏与桌面顶栏避让的拆分口径。此前两者挤在同一个 `pt-14` 里：
// 56px 恰好等于 DesktopTopOverlay 的 h-14，跳转落点全程不减顶栏高度，
// 于是这 56px 同时是「轮与轮之间的留白」和「三条跳转路径唯一的避让量」。
// 拆开后断言的重点是：padding 与补偿必须互补，任一路径漏改都会让落点被顶栏盖住。

const NOTIFICATION = { kind: "terminal", status: "completed", summary: "done" } as const;

function header(overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: "turn-1",
    createdAt: 0,
    createdAtSeq: 0,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 0,
    ...overrides,
  } as TurnHeaderRow;
}

test("轮顶 padding 分三态：首轮 0（让位常驻占位块）、workflow 通知卡 0、其余 24", () => {
  assert.equal(
    resolveTurnTopPaddingPx({ startsTimeline: true, startsWithWorkflowNotificationCard: false }),
    0,
  );
  assert.equal(
    resolveTurnTopPaddingPx({ startsTimeline: false, startsWithWorkflowNotificationCard: false }),
    24,
  );
  // workflow 通知卡轮优先级高于首轮：它没有用户气泡做视觉锚点，pt-0 是既定取舍。
  assert.equal(
    resolveTurnTopPaddingPx({ startsTimeline: true, startsWithWorkflowNotificationCard: true }),
    0,
  );
});

test("padding class 与像素值同源，不允许两处各写一份", () => {
  const cases = [
    { startsTimeline: true, startsWithWorkflowNotificationCard: false },
    { startsTimeline: false, startsWithWorkflowNotificationCard: false },
    { startsTimeline: true, startsWithWorkflowNotificationCard: true },
  ] as const;
  const expected: ReadonlyArray<readonly [string, number]> = [
    ["pt-0", 0],
    ["pt-6", 24],
    ["pt-0", 0],
  ];
  for (const [index, input] of cases.entries()) {
    const [className, px] = expected[index]!;
    assert.equal(resolveTurnTopPaddingClass(input), className);
    assert.equal(resolveTurnTopPaddingPx(input), px);
  }
});

test("首轮顶距让位后，常驻占位块补回同一份留白", () => {
  // 首轮 padding 归零后，滚到真顶的总留白必须与改造前的首轮 pt-14 一致，否则
  // 「滚到最顶」会凭空多跳或少跳 56px。这条约束靠块高恒等于顶栏高度来保证。
  assert.equal(PENDING_HISTORY_SLOT_PX, TIMELINE_TOP_OCCLUSION_PX);
  assert.equal(
    PENDING_HISTORY_SLOT_PX +
      resolveTurnTopPaddingPx({
        startsTimeline: true,
        startsWithWorkflowNotificationCard: false,
      }),
    TIMELINE_TOP_OCCLUSION_PX,
  );
});

test("跳转补偿与该轮 padding 互补，两条加起来恒为顶栏高度", () => {
  for (const startsTimeline of [true, false]) {
    for (const startsWithWorkflowNotificationCard of [true, false]) {
      const input = { startsTimeline, startsWithWorkflowNotificationCard };
      assert.equal(
        resolveTurnTopPaddingPx(input) + resolveJumpOcclusionOffsetPx(input),
        TIMELINE_TOP_OCCLUSION_PX,
        `首轮=${startsTimeline} 通知卡=${startsWithWorkflowNotificationCard}`,
      );
    }
  }
});

test("首轮与通知卡轮一样补满 56；其余轮补 56 − padding", () => {
  assert.equal(
    resolveJumpOcclusionOffsetPx({
      startsTimeline: true,
      startsWithWorkflowNotificationCard: false,
    }),
    TIMELINE_TOP_OCCLUSION_PX,
  );
  assert.equal(
    resolveJumpOcclusionOffsetPx({
      startsTimeline: false,
      startsWithWorkflowNotificationCard: false,
    }),
    32,
  );
  // pt-0 轮此前跳转时首行直接被顶栏盖住，是既有缺口；公式自然补满。
  assert.equal(
    resolveJumpOcclusionOffsetPx({
      startsTimeline: false,
      startsWithWorkflowNotificationCard: true,
    }),
    TIMELINE_TOP_OCCLUSION_PX,
  );
});

test("workflow 通知卡判定：只有 backgroundResult + workflow + 通知载荷同时在场才算", () => {
  const originMeta = { backgroundSource: "workflow", workId: "run-1", title: "跑完了" } as const;
  assert.equal(
    turnStartsWithWorkflowNotificationCard(
      header({
        origin: "backgroundResult",
        originMeta: { ...originMeta, workflowNotification: NOTIFICATION },
      }),
    ),
    true,
  );
  // source 不是 workflow
  assert.equal(
    turnStartsWithWorkflowNotificationCard(
      header({
        origin: "backgroundResult",
        originMeta: { backgroundSource: "subagent", workId: "w", title: "t" },
      }),
    ),
    false,
  );
  // source 是 workflow 但没有通知载荷：那是裸后台结果轮，仍走常规轮顶 padding
  assert.equal(
    turnStartsWithWorkflowNotificationCard(header({ origin: "backgroundResult", originMeta })),
    false,
  );
  // origin 不是后台结果
  assert.equal(
    turnStartsWithWorkflowNotificationCard(
      header({
        origin: "userInput",
        originMeta: { ...originMeta, workflowNotification: NOTIFICATION },
      }),
    ),
    false,
  );
  assert.equal(turnStartsWithWorkflowNotificationCard(undefined), false);
  assert.equal(turnStartsWithWorkflowNotificationCard(header()), false);
});
