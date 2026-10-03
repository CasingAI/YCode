import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
} from "../src/v4/conversationTurnFlowItems.js";
import { buildConversationFlowItems } from "../src/v4/conversationTurnFlowItems.js";
import { buildConversationTurnWorkSegments } from "../src/v4/conversationTurnWorkSegments.js";
import {
  conversationFlowGapSides,
  flowGapPaddingClass,
  flowItemGapClass,
  HISTORY_CONTENT_DEFAULT_PADDING_CLASS,
  isBorderedShellWorkItem,
  lastRenderedFlowItemEndsWithBorderedShell,
  TURN_PROCESS_CONTENT_GAP_CLASS,
  WORK_ITEM_CARD_GAP_CLASS,
  WORK_ITEM_TIGHT_GAP_CLASS,
  WORK_ITEM_USER_GAP_CLASS,
  workItemGapClass,
} from "../src/v4/conversationWorkItemGap.js";

// 工作项间距两条规则：
// 1. 只有真正带边框外壳的块（计划卡、自动化卡等）才给 16px，平铺行一律 2px；
// 2. 判定必须看边界的两侧。只看后一项自己的类型时，卡片后面接过程行只剩贴紧态，
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

function userInputRow(rowId: number): UserInputRow {
  return {
    kind: "userInput",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "提问",
    origin: "realUser",
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
 * 计划卡就是计划工具的 toolCall 行：带 plan markdown 时渲染带边框外壳，
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

test("计划卡前面是过程行、后面也是过程行：卡片上下两侧都是 16px", () => {
  const gaps = gapClassesOf([reasoningRow(3), planCardRow(1), reasoningRow(4)]);

  // 首项（过程行）不加间距；卡片自己带 16px；卡片后面的过程行同样是 16px，不再贴死。
  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS, WORK_ITEM_CARD_GAP_CLASS]);
});

test("计划卡后面接正文行：仍按 16px 分开", () => {
  const gaps = gapClassesOf([planCardRow(1), assistantTextRow(2)]);

  assert.deepEqual(gaps, [undefined, WORK_ITEM_CARD_GAP_CLASS]);
});

test("平铺工具行（待办）不是带边框外壳的块：与过程行、正文行一样贴紧到 2px", () => {
  const gaps = gapClassesOf([reasoningRow(1), TODO_ROW, assistantTextRow(5)]);

  // 前两行折成一行过程行；待办行与正文行都不是带边框外壳的块。
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

test("只有真正带边框外壳的块才算卡片：计划卡算，过程行、待办行不算", () => {
  const [processRow, planCard] = buildAssistantWorkRenderItems(
    [reasoningRow(3), planCardRow(1)],
    SHOW_REASONING,
  );
  const [todo] = buildAssistantWorkRenderItems([TODO_ROW], SHOW_REASONING);

  assert.ok(processRow, "应当折叠出过程行");
  assert.ok(planCard, "计划卡片应当保持为独立的工具卡行");
  assert.ok(todo, "待办行应当保持为独立行");

  assert.equal(processRow.kind, "process");
  assert.equal(isBorderedShellWorkItem(processRow), false);
  assert.equal(isBorderedShellWorkItem(planCard), true);
  assert.equal(isBorderedShellWorkItem(todo), false);
});

test("计划工具没拿到 plan markdown 时不是卡：退化成平铺输出块", () => {
  const [row] = buildAssistantWorkRenderItems([toolRow(9, "ExitPlanMode")], SHOW_REASONING);

  assert.ok(row);
  assert.equal(isBorderedShellWorkItem(row), false);
});

test("计划工具流式期只有 title/overview 也是卡：定稿不得跳间距", () => {
  // 计划工具按 title → overview → plan 顺序流出，流式期正文还没到，卡片已经能成形。
  // 间距判据必须与渲染器同源（hasPlanCardContent），否则这段按平铺行排 2px，
  // 定稿那一刻跳成 16px 卡片间距——卡片凭空往上下各撑一下。
  const streaming: ToolCallRow = {
    kind: "toolCall",
    rowId: 10,
    turnId: "turn-1",
    createdAt: 10,
    createdAtSeq: 10,
    toolCallId: "call-10",
    toolName: "ExitPlanMode",
    status: "inputStreaming",
    inputText:
      '{"title":"数据源分区与搜索引擎","overview":"在设置页新增「数据源」分区管理 jina 与智谱',
  };
  const [row] = buildAssistantWorkRenderItems([streaming], SHOW_REASONING);

  assert.ok(row);
  assert.equal(isBorderedShellWorkItem(row), true);
});

test("过程行展开内容的行距与贴紧态同值：都是 0.5 档（2px），只是 mt / space-y 作用域不同", () => {
  assert.equal(WORK_ITEM_TIGHT_GAP_CLASS, "mt-0.5");
  assert.equal(TURN_PROCESS_CONTENT_GAP_CLASS, "space-y-0.5");
  assert.equal(WORK_ITEM_CARD_GAP_CLASS, "mt-4");
});

// flow 容器（ConversationWorkSegmentFlow）里相邻 flow 项之间的间距。
// 正文段是独立 flow 项、直接作为容器子元素渲染，间距必须自己带：只靠容器那条统一的
// 20px，同一段过程会被正文切成「列表内 2px、跨 flow 项 20px」的几截。

function flowItemsOf(
  orderedRows: readonly ConversationRow[],
  options: {
    historyRows?: readonly AssistantWorkRow[];
    visibleAssistantTextRow?: AssistantTextRow;
    /** 计划卡脱流只对末轮生效；默认 false 表示「历史 turn」，保持原渲染路径。 */
    isLastTurn?: boolean;
  } = {},
) {
  return buildConversationFlowItems({
    orderedRows,
    assistantHistoryRows: options.historyRows ?? [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    ...(options.visibleAssistantTextRow === undefined
      ? {}
      : { visibleAssistantTextRow: options.visibleAssistantTextRow }),
    isLastTurn: options.isLastTurn ?? false,
    timelineOnly: false,
  });
}

function flowGapsOf(
  orderedRows: readonly ConversationRow[],
  options: {
    historyRows?: readonly AssistantWorkRow[];
    visibleAssistantTextRow?: AssistantTextRow;
  } = {},
): (string | undefined)[] {
  const sides = conversationFlowGapSides(flowItemsOf(orderedRows, options));
  return sides.map((_side, index) => flowItemGapClass(index, sides));
}

test("过程块 → 正文段 → 过程块：正文段上下都贴紧到 2px，不再各留 20px", () => {
  const gaps = flowGapsOf([userInputRow(1), reasoningRow(2), assistantTextRow(3), reasoningRow(4)]);

  // 用户气泡后面是表头所在的那个块（自己交回容器默认 20px），再往下都是助手侧内容。
  assert.deepEqual(gaps, [
    undefined,
    undefined,
    WORK_ITEM_TIGHT_GAP_CLASS,
    WORK_ITEM_TIGHT_GAP_CLASS,
  ]);
});

test("flow 项角色：用户气泡、表头后的第一个助手块（defaultGap）、其余助手侧内容", () => {
  const sides = conversationFlowGapSides(
    flowItemsOf([userInputRow(1), reasoningRow(2), assistantTextRow(3)]),
  );

  assert.deepEqual(sides, [
    { kind: "user" },
    { kind: "assistant", shellAtStart: false, shellAtEnd: false, defaultGap: true },
    { kind: "assistant", shellAtStart: false, shellAtEnd: false, defaultGap: false },
  ]);
});

test("计划卡收尾的过程块后面接正文段：仍按 16px 分开，块上下对称", () => {
  const gaps = flowGapsOf([userInputRow(1), reasoningRow(2), planCardRow(3), assistantTextRow(4)]);

  assert.deepEqual(gaps, [undefined, undefined, WORK_ITEM_CARD_GAP_CLASS]);
});

test("正文段后面接以卡片开头的过程块：按 16px 分开", () => {
  const gaps = flowGapsOf([userInputRow(1), assistantTextRow(2), planCardRow(3), reasoningRow(4)]);

  assert.deepEqual(gaps, [undefined, undefined, WORK_ITEM_CARD_GAP_CLASS]);
});

test("用户气泡两侧仍是默认 20px：气泡不并入过程流", () => {
  const gaps = flowGapsOf([
    userInputRow(1),
    toolRow(2, "Read", { filePath: "a.ts" }),
    assistantTextRow(3),
    userInputRow(4),
    reasoningRow(5),
  ]);

  assert.deepEqual(gaps, [
    undefined,
    undefined,
    WORK_ITEM_TIGHT_GAP_CLASS,
    WORK_ITEM_USER_GAP_CLASS,
    WORK_ITEM_USER_GAP_CLASS,
  ]);
});

test("history 折叠块与可见正文段之间同样贴紧到 2px", () => {
  const gaps = flowGapsOf([reasoningRow(1), assistantTextRow(2), reasoningRow(3)], {
    historyRows: [reasoningRow(1)],
    visibleAssistantTextRow: assistantTextRow(2),
  });

  // 折叠块 → 可见正文段 → 后面的过程块，都是助手侧内容：一路 2px，中间不再有 20px 的洞。
  assert.deepEqual(gaps, [undefined, WORK_ITEM_TIGHT_GAP_CLASS, WORK_ITEM_TIGHT_GAP_CLASS]);
});

test("history 外壳内的间距换成 pt：与 mt 档位一一对应，未分类时沿用默认档 pt-3", () => {
  assert.equal(flowGapPaddingClass(WORK_ITEM_TIGHT_GAP_CLASS), "pt-0.5");
  assert.equal(flowGapPaddingClass(WORK_ITEM_CARD_GAP_CLASS), "pt-4");
  assert.equal(
    flowGapPaddingClass(WORK_ITEM_USER_GAP_CLASS),
    HISTORY_CONTENT_DEFAULT_PADDING_CLASS,
  );
  assert.equal(HISTORY_CONTENT_DEFAULT_PADDING_CLASS, "pt-3");
  assert.equal(flowGapPaddingClass(undefined), undefined);
});

test("用户分界档与容器默认档同值：mt-3 / pt-3，改一侧必须同步另一侧", () => {
  // 这两个常量描述的是同一处留白——带 data-flow-gap 的项用自己的档位，未分类的项
  // 交回 ConversationTurnGroup 里那条 `[&>*+*…]:mt-3`。两边一旦漂移，同一个分界
  // 会在带标记和不带标记的项上排出两个不同的间距。
  assert.equal(WORK_ITEM_USER_GAP_CLASS, "mt-3");
  assert.equal(HISTORY_CONTENT_DEFAULT_PADDING_CLASS, "pt-3");
});

// 轮级工具栏脱流后落在 group/assistant-turn 的 padding box 里：容器补 pb-6(24) 时
// 工具栏顶边正好压在内容底边上（间距 0），补 pb-9(36) 才顶开 12px。判错的代价是卡片
// 变成「上面 16、下面 0」。计划卡曾经就是这样——它渲染出来是带边框的独立盒子，却因为
// 不在那份「独立组件轮尾块」白名单里而按普通内容算 0。

test("末尾是计划卡：工具栏要顶开 12px，卡片上下才对称", () => {
  // 正文段在上、计划卡收尾——和实际截图一致。此时卡片上方走 WORK_ITEM_CARD_GAP_CLASS
  // 的 16px，下方必须由 pb-9 顶开 12px，否则就是「上面 16、下面 0」。
  const segments = [
    { flowItems: flowItemsOf([userInputRow(1), assistantTextRow(2), planCardRow(3)]) },
  ];

  assert.equal(lastRenderedFlowItemEndsWithBorderedShell(segments), true);
});

test("计划卡是第一个助手块时也算末尾是卡：上方走容器默认档，但下方仍要顶开", () => {
  // 首个助手块交回容器默认规则（defaultGap），它自己不吃 mt-*；判「末尾是不是卡」
  // 不能跟着这个分支走——卡片下方要不要留白和它上方用哪一档是两件事。
  const items = flowItemsOf([userInputRow(1), planCardRow(2)]);

  assert.equal(lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: items }]), true);
  assert.equal(flowItemGapClass(items.length - 1, conversationFlowGapSides(items)), undefined);
});

test("末尾是正文段：工具栏贴住正文，0 间距", () => {
  const segments = [
    { flowItems: flowItemsOf([userInputRow(1), planCardRow(2), assistantTextRow(3)]) },
  ];

  // 卡片后面还有正文，视觉上挨着工具栏的是正文：正文自己已是可辨识的块，再留一段反而
  // 把工具栏推成独立块。
  assert.equal(lastRenderedFlowItemEndsWithBorderedShell(segments), false);
});

test("末尾是平铺工具行：不是卡，按 0 间距算", () => {
  const segments = [{ flowItems: flowItemsOf([userInputRow(1), TODO_ROW]) }];

  assert.equal(lastRenderedFlowItemEndsWithBorderedShell(segments), false);
});

test("多段时看最后一段；末段为空则回看上一段，不被空段挡住", () => {
  const withPlanCard = flowItemsOf([userInputRow(1), planCardRow(2)]);
  const withText = flowItemsOf([userInputRow(1), assistantTextRow(2)]);

  // 空段渲染为 null，真正挨着工具栏的是它前面那一段。
  assert.equal(
    lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: withPlanCard }, { flowItems: [] }]),
    true,
  );
  assert.equal(
    lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: withText }, { flowItems: [] }]),
    false,
  );
  // 末段有内容就只看末段，不回看更早那段是不是卡。
  assert.equal(
    lastRenderedFlowItemEndsWithBorderedShell([
      { flowItems: withPlanCard },
      { flowItems: withText },
    ]),
    false,
  );
});

test("没有 flow 项时不是卡：不凭空给容器补 pb-9", () => {
  assert.equal(lastRenderedFlowItemEndsWithBorderedShell([]), false);
  assert.equal(lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: [] }]), false);
});

test("末尾判据与卡片上方那 16px 同源：同一份 shellAtEnd", () => {
  // 两处必须一起变：上方 WORK_ITEM_CARD_GAP_CLASS 决定卡片独立成段，下方
  // toolbarFollowsCard 决定工具栏要不要顶开。判据漂移就会出现「上面 16、下面 0」。
  const items = flowItemsOf([userInputRow(1), assistantTextRow(2), planCardRow(3)]);
  const sides = conversationFlowGapSides(items);
  const lastSide = sides.at(-1);

  assert.equal(lastSide?.kind, "assistant");
  assert.equal(lastSide?.kind === "assistant" && lastSide.shellAtEnd, true);
  assert.equal(flowItemGapClass(items.length - 1, sides), WORK_ITEM_CARD_GAP_CLASS);
  assert.equal(
    lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: items }]),
    lastSide?.kind === "assistant" && lastSide.shellAtEnd,
  );
});

// 末轮计划卡脱流：Ask/Agent 档调完 CreatePlan 不停轮，卡片落在最后一条正文**之前**，
// 会被 slice 进 assistantHistory 随过程一起收起（写了正文看不见，不写反而看得见）。
// 末轮里把它摘成原位的紧凑调用记录，完整卡片统一去段末。

type PlanFlowItem = Extract<ConversationTurnFlowItem, { kind: "planCard" | "planCallRecord" }>;

function planFlowItemsOf(items: readonly ConversationTurnFlowItem[]): PlanFlowItem[] {
  return items.filter(
    (item): item is PlanFlowItem => item.kind === "planCard" || item.kind === "planCallRecord",
  );
}

/** 计划工具行，但没带得动卡片内容（失败或空）：脱流判定认的是「能不能成卡」。 */
function barePlanRow(rowId: number): ToolCallRow {
  return toolRow(rowId, "CreatePlan");
}

/**
 * Ask 档主场景的真实分段：计划行落在段内最后一条正文之前，本来会被切进 history 桶。
 * 三个条件（末轮 + 是完整计划卡 + 不是段内最后一行）都成立时才脱流。
 */
function askModeLastTurnItems() {
  const plan = planCardRow(2);
  const text = assistantTextRow(3);
  return flowItemsOf([userInputRow(1), plan, text], {
    historyRows: [plan],
    visibleAssistantTextRow: text,
    isLastTurn: true,
  });
}

test("末轮 + 计划卡不在段末：原位变紧凑调用记录，完整卡片推到段末", () => {
  const items = askModeLastTurnItems();

  assert.deepEqual(
    items.map((item) => item.kind),
    ["userInput", "planCallRecord", "assistantText", "planCard"],
  );
  // 关键性质：计划行不再落进任何过程桶，所以不展开过程也能在轮末直接看到完整卡片。
  assert.equal(
    items.some((item) => item.kind === "assistantHistory" || item.kind === "assistantWork"),
    false,
  );
  assert.deepEqual(
    planFlowItemsOf(items).map((item) => `${item.kind}:${item.row.rowId}`),
    ["planCallRecord:2", "planCard:2"],
  );
});

test("脱流条件之一不成立就不脱流：历史 turn 的计划卡留在原位", () => {
  const plan = planCardRow(2);
  const text = assistantTextRow(3);
  const items = flowItemsOf([userInputRow(1), plan, text], {
    historyRows: [plan],
    visibleAssistantTextRow: text,
    isLastTurn: false,
  });

  assert.deepEqual(planFlowItemsOf(items), []);
  const history = items.find((item) => item.kind === "assistantHistory");
  assert.ok(history && history.kind === "assistantHistory");
  assert.deepEqual(
    history.rows.map((row) => row.rowId),
    [plan.rowId],
  );
});

test("Plan 档不重复：计划行本来就是段末就不脱流，不会出现调用记录 + 完整卡两份", () => {
  // Plan 档 CreatePlan 一成功就 plan_created 停轮，卡片天然在末尾。
  const plan = planCardRow(2);
  const items = flowItemsOf([userInputRow(1), plan], { isLastTurn: true });

  assert.deepEqual(planFlowItemsOf(items), []);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["userInput", "assistantWork"],
  );
  const work = items.at(-1);
  assert.ok(work && work.kind === "assistantWork");
  assert.deepEqual(
    work.rows.map((row) => row.rowId),
    [plan.rowId],
  );
});

test("只有渲染得成完整卡片的计划行才脱流：空计划行与普通工具行都留在原位", () => {
  const barePlan = barePlanRow(2);
  const text = assistantTextRow(4);
  const bareItems = flowItemsOf([userInputRow(1), barePlan, text], {
    historyRows: [barePlan],
    visibleAssistantTextRow: text,
    isLastTurn: true,
  });
  const todoItems = flowItemsOf([userInputRow(1), TODO_ROW, assistantTextRow(5)], {
    historyRows: [TODO_ROW],
    visibleAssistantTextRow: assistantTextRow(5),
    isLastTurn: true,
  });

  assert.deepEqual(planFlowItemsOf(bareItems), []);
  assert.deepEqual(planFlowItemsOf(todoItems), []);
});

test("同轮多个计划调用：原位记录保持先后，卡片也按原相对顺序排在段末", () => {
  const first = planCardRow(2);
  const second = planCardRow(3);
  const text = assistantTextRow(4);
  const items = flowItemsOf([userInputRow(1), first, second, text], {
    historyRows: [first, second],
    visibleAssistantTextRow: text,
    isLastTurn: true,
  });

  assert.deepEqual(
    planFlowItemsOf(items).map((item) => `${item.kind}:${item.row.rowId}`),
    ["planCallRecord:2", "planCallRecord:3", "planCard:2", "planCard:3"],
  );
});

test("脱流后的间距归类：原位调用记录贴紧 2px，轮末卡片按 16px 且顶开工具栏", () => {
  const items = askModeLastTurnItems();
  const sides = conversationFlowGapSides(items);

  assert.deepEqual(sides, [
    { kind: "user" },
    // 表头后的第一个助手块（这里就是那条调用记录）交回容器默认 12px。
    { kind: "assistant", shellAtStart: false, shellAtEnd: false, defaultGap: true },
    { kind: "assistant", shellAtStart: false, shellAtEnd: false, defaultGap: false },
    { kind: "assistant", shellAtStart: true, shellAtEnd: true, defaultGap: false },
  ]);
  assert.deepEqual(
    sides.map((_side, index) => flowItemGapClass(index, sides)),
    [undefined, undefined, WORK_ITEM_TIGHT_GAP_CLASS, WORK_ITEM_CARD_GAP_CLASS],
  );
  // 轮末确实是卡：容器补 pb-9，卡片上方 16px、下方 12px，上下对称。
  assert.equal(lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: items }]), true);
});

test("调用记录夹在两段过程之间时不按卡片排版：原位行没有边框外壳", () => {
  // 同一份行既当 planCallRecord（平铺）又当 planCard（外壳）时，间距必须分开算；
  // 漏掉 planCallRecord 分支时它会被 `item.rows` 型的兜底当成外壳行，间距凭空多 14px。
  const items = flowItemsOf(
    [userInputRow(1), planCardRow(2), assistantTextRow(3), reasoningRow(4)],
    {
      historyRows: [reasoningRow(4)],
      visibleAssistantTextRow: assistantTextRow(3),
      isLastTurn: true,
    },
  );
  const sides = conversationFlowGapSides(items);
  const recordSide = sides.find((_side, index) => items[index]?.kind === "planCallRecord");

  assert.deepEqual(recordSide, {
    kind: "assistant",
    shellAtStart: false,
    shellAtEnd: false,
    defaultGap: true,
  });
  // 轮末的卡片仍然是外壳：工具栏要顶开。
  assert.equal(lastRenderedFlowItemEndsWithBorderedShell([{ flowItems: items }]), true);
});

// 上面几例直接调 buildConversationFlowItems。这一例走完整的工作段装配：
// isLastTurn 的透传与 CUA 分组的透传都在这条路径上——漏掉任一处，
// 计划卡要么不脱流，要么在 prepareCuaGroupFlowItems 里被当成 rows 型工作项展开而抛错。

function workSegmentItems(options: {
  orderedRows: readonly ConversationRow[];
  isLastTurn: boolean;
}): ConversationTurnFlowItem[] {
  const segments = buildConversationTurnWorkSegments({
    key: "turn-1",
    orderedRows: options.orderedRows,
    assistantTailRows: [],
    isRunning: false,
    isLastTurn: options.isLastTurn,
    isInterrupted: false,
    forceOpenHistory: false,
    timelineOnly: false,
  });
  return segments[0]?.flowItems ?? [];
}

test("整条工作段装配路径：末轮计划卡脱流，且能穿过 CUA 分组投影", () => {
  const plan = planCardRow(2);
  const text = assistantTextRow(3);
  const items = workSegmentItems({
    orderedRows: [userInputRow(1), plan, text],
    isLastTurn: true,
  });

  assert.deepEqual(
    items.map((item) => item.kind),
    ["userInput", "planCallRecord", "assistantText", "planCard"],
  );
  assert.equal(items.at(-1)?.kind, "planCard");
});

test("整条工作段装配路径：Plan 档（计划行在段末）只有一份，不脱流", () => {
  const items = workSegmentItems({
    orderedRows: [userInputRow(1), planCardRow(2)],
    isLastTurn: true,
  });

  // 这一轮没有末段正文，整段落进 history 桶——计划卡就在其中原位渲染，没有第二份。
  assert.deepEqual(planFlowItemsOf(items), []);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["userInput", "assistantHistory"],
  );
  const history = items.at(-1);
  assert.ok(history && history.kind === "assistantHistory");
  assert.deepEqual(
    history.rows.map((row) => row.rowId),
    [planCardRow(2).rowId],
  );
});

test("整条工作段装配路径：历史 turn 的末轮判定不生效，计划卡留在原位", () => {
  const plan = planCardRow(2);
  const text = assistantTextRow(3);
  const items = workSegmentItems({
    orderedRows: [userInputRow(1), plan, text],
    isLastTurn: false,
  });

  assert.deepEqual(planFlowItemsOf(items), []);
});
