import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
} from "../../shared/src/validationAppSettings.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
} from "../src/v4/conversationTurnNavigatorHelpers.js";

const i18n = {
  assistantEmptyPreview: "暂无助手正文",
  assistantRunningPreview: "助手仍在工作",
  userFallbackPreview: "用户输入",
};

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: "k",
    rowId: 1,
    turnId: "turn:1",
    userPreview: "q",
    assistantPreview: "a",
    assistantPreviewKind: "text",
    ...overrides,
  };
}

// rail 常开后开关不复存在：旧 setting.json 残留键由 zod 默认忽略，不报错；
// patch 不再接受该键（strict 语义由外层裁决，这里只断言解析后无此字段）。
test("旧 setting.json 残留开关 disciplined：解析后无此字段且不报错", () => {
  const settings = appSettingsSchema.parse({ conversationTurnNavigatorEnabled: true });
  assert.equal((settings as Record<string, unknown>).conversationTurnNavigatorEnabled, undefined);
  assert.equal(appSettingsPatchSchema.parse({}).conversationTurnNavigatorEnabled, undefined);
});

test("目录条目直转 rail 项：空串按 kind 本地化兜底", () => {
  const [text, running] = buildConversationTurnNavigatorItems(
    [
      entry({ key: "k1", rowId: 1, userPreview: "", assistantPreview: "" }),
      entry({
        key: "k2",
        rowId: 2,
        assistantPreview: "",
        assistantPreviewKind: "running",
      }),
    ],
    i18n,
  );
  assert.equal(text?.userPreview, i18n.userFallbackPreview);
  assert.equal(text?.assistantPreview, i18n.assistantEmptyPreview);
  assert.equal(running?.assistantPreview, i18n.assistantRunningPreview);
  assert.equal(running?.isRunning, true);
  assert.equal(text?.isRunning, false);
});

test("running 叠加可用窗口实时集合覆盖目录 kind", () => {
  const [first, second] = buildConversationTurnNavigatorItems(
    [
      entry({ key: "k1", rowId: 1, assistantPreviewKind: "running" }),
      entry({ key: "k2", rowId: 2, assistantPreviewKind: "text" }),
    ],
    i18n,
    new Set([2]),
  );
  assert.equal(first?.isRunning, false);
  assert.equal(second?.isRunning, true);
});

test("active 映射按 turn 容器挂目录项：可视 turn 命中所属首个目录项", () => {
  const items = [
    { ...entry({ key: "k1", rowId: 1, turnId: "turn:1" }), isRunning: false },
    { ...entry({ key: "k2", rowId: 2, turnId: "turn:1" }), isRunning: false },
    { ...entry({ key: "k3", rowId: 3, turnId: "turn:2" }), isRunning: false },
  ];
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      virtualItems: [{ index: 5, start: 100, size: 200, turnId: "turn:2" }],
      scrollOffsetPx: 0,
      viewportHeightPx: 400,
    }),
    "turn:2",
  );
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions: [
        { rowId: 1, start: 0, end: 100 },
        { rowId: 3, start: 300, end: 400 },
      ],
      scrollOffsetPx: 250,
      viewportHeightPx: 200,
    }),
    3,
  );
});

test("可视轮无目录项时 active 落到位置最近的目录项而非首条", () => {
  // 复现冷启动停在尾部的实测形态：最后一轮没有 realUser query（goal 续写 /
  // 中枢直接启动），不在目录里；可视区全是这种轮，目录项一个都映射不到。
  // 旧实现在这里返回 items[0]，active 被钉死在第一条，向上滚再滚回来也不变。
  const items = [
    { ...entry({ key: "k1", rowId: 1, turnId: "turn:1" }), isRunning: false },
    { ...entry({ key: "k2", rowId: 2, turnId: "turn:2" }), isRunning: false },
    { ...entry({ key: "k3", rowId: 3, turnId: "turn:3" }), isRunning: false },
  ];
  const tailWindow = [
    { index: 4, start: 0, size: 300, turnId: "turn:2" },
    { index: 5, start: 300, size: 300, turnId: "turn:tail-a" },
    { index: 6, start: 600, size: 300, turnId: "turn:tail-b" },
  ];
  // 视口压在两条无 query 的尾部轮上：按位置最近的有目录项是 turn:2。
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      virtualItems: tailWindow,
      scrollOffsetPx: 400,
      viewportHeightPx: 300,
    }),
    "turn:2",
  );
  // 继续往下滚到窗口更深处，仍应停在 turn:2，不能退回首条。
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      virtualItems: tailWindow,
      scrollOffsetPx: 800,
      viewportHeightPx: 300,
    }),
    "turn:2",
  );
  // 视口移回窗口里更靠后、且确实有 query 的轮上时，按就近取该轮。
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      virtualItems: [...tailWindow, { index: 7, start: 900, size: 300, turnId: "turn:3" }],
      scrollOffsetPx: 900,
      viewportHeightPx: 300,
    }),
    "turn:3",
  );
});

test("整个窗口都无目录项时才回落到首条", () => {
  const items = [
    { ...entry({ key: "k1", rowId: 1, turnId: "turn:1" }), isRunning: false },
    { ...entry({ key: "k2", rowId: 2, turnId: "turn:2" }), isRunning: false },
  ];
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      virtualItems: [
        { index: 0, start: 0, size: 100, turnId: "turn:x" },
        { index: 1, start: 100, size: 100, turnId: "turn:y" },
      ],
      scrollOffsetPx: 0,
      viewportHeightPx: 200,
    }),
    "turn:1",
  );
});
