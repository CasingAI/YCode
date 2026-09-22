import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantTextRow, ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import {
  isBorderedShellWorkItem,
  TURN_SUMMARY_CONTENT_GAP_CLASS,
  WORK_ITEM_CARD_GAP_CLASS,
  WORK_ITEM_TIGHT_GAP_CLASS,
  workItemGapClass,
} from "../src/v4/conversationWorkItemGap.js";

// 工作项间距两条规则：
// 1. 只有真正带边框外壳的块（计划卡、自动化卡等）才给 16px，平铺行一律 2px；
// 2. 判定必须看边界的两侧。只看后一项自己的类型时，卡片后面接过程汇总行只剩贴紧态，
//    卡片上方 16px、下方 2px 不对称（就是「上面留 Gap、下面忘记了」）。

const SHOW_REASONING = { messageStreamShowReasoning: true } as const;

function toolRow(rowId: number, toolName: string, input?: unknown): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName,
    status: "success",
    inputText: "",
    ...(input === undefined ? { input: {} } : { input }),
  };
}

function reasoningRow(rowId: number): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "thinking",
    state: "complete",
  };
}

function assistantTextRow(rowId: number): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "答复",
    state: "complete",
  };
}

/**
 * 计划卡就是 ExitPlanMode 的 toolCall 行：带 plan markdown 时渲染带边框外壳，
 * 不属任何过程桶，折叠时把上下文切成两段。
 */
function planCardRow(rowId: number): ToolCallRow {
  return toolRow(rowId, "ExitPlanMode", { plan: "# 改动方案\n先做 A，再做 B。" });
}
/** 待办行走 ToolLayout 平铺行，外框没有边框。 */
const TODO_ROW = toolRow(3, "TodoWrite", { todos: [{ content: "做事", status: "pending" }] });
/** 定时任务行渲染成带边框的自动化卡。 */
const CRON_ROW = toolRow(4, "CronCreate", { cron: "0 9 * * *", prompt: "喝水" });

/** 按真实的折叠投影出 items，再逐项取挂在这个项上的间距 class。 */
function gapClassesOf(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
): (string | undefined)[] {
  const items = buildAssistantWorkRenderItems(rows, SHOW_REASONING);
  return items.map((_item, index) => workItemGapClass(index, items));
}

test("计划卡前面是过程汇总行、后面也是过程汇总行：卡片上下两侧都是 16px", () => {
  const gaps = gapClassesOf([reasoningRow(3), planCardRow(1), reasoningRow(4)]);

  // 首项（汇总行）不加间距；卡片自己带 16px；卡片后面的汇总行同样是 16px，不再贴死。
  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS, WORK_ITEM_CARD_GAP_CLASS]);
});

test("计划卡后面接正文行：仍按 16px 分开", () => {
  const gaps = gapClassesOf([planCardRow(1), assistantTextRow(2)]);

  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS]);
});

test("平铺工具行（待办）不是带边框外壳的块：与过程行、正文行一样贴紧到 2px", () => {
  const gaps = gapClassesOf([reasoningRow(1), TODO_ROW, assistantTextRow(5)]);

  // 前两行折成一行汇总；待办行与正文行都不是带边框外壳的块。
  assert.deepEqual(gaps, [undefined, WORK_ITEM_TIGHT_GAP_CLASS, WORK_ITEM_TIGHT_GAP_CLASS]);
});

test("自动化卡是带边框外壳的块：前后都按 16px", () => {
  const gaps = gapClassesOf([reasoningRow(1), CRON_ROW, assistantTextRow(5)]);

  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS, WORK_ITEM_CARD_GAP_CLASS]);
});

test("连着两张带边框外壳的卡：第二张自己带 16px", () => {
  const gaps = gapClassesOf([planCardRow(1), planCardRow(2)]);

  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS]);
});

test("只有真正带边框外壳的块才算卡片：计划卡算，过程汇总行、待办行不算", () => {
  const [summary, planCard] = buildAssistantWorkRenderItems(
    [reasoningRow(3), planCardRow(1)],
    SHOW_REASONING,
  );
  const [todo] = buildAssistantWorkRenderItems([TODO_ROW], SHOW_REASONING);

  assert.ok(summary, "应当折叠出一行汇总");
  assert.ok(planCard, "计划卡片应当保持为独立的工具卡行");
  assert.ok(todo, "待办行应当保持为独立行");

  assert.equal(summary.kind, "turnSummary");
  assert.equal(isBorderedShellWorkItem(summary), false);
  assert.equal(isBorderedShellWorkItem(planCard), true);
  assert.equal(isBorderedShellWorkItem(todo), false);
});

test("ExitPlanMode 没拿到 plan markdown 时不是卡：退化成平铺输出块", () => {
  const [row] = buildAssistantWorkRenderItems([toolRow(9, "ExitPlanMode")], SHOW_REASONING);

  assert.ok(row);
  assert.equal(isBorderedShellWorkItem(row), false);
});

test("汇总展开内容的行距与贴紧态同值：都是 0.5 档（2px），只是 mt / space-y 作用域不同", () => {
  assert.equal(WORK_ITEM_TIGHT_GAP_CLASS, "mt-0.5");
  assert.equal(TURN_SUMMARY_CONTENT_GAP_CLASS, "space-y-0.5");
  assert.equal(WORK_ITEM_CARD_GAP_CLASS, "mt-4");
});
