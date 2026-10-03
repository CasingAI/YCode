import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";
import {
  estimateConversationTurnHeight,
  MAX_TURN_ESTIMATE_PX,
} from "../src/v4/timelineTurnHeightEstimate.js";
import { DEFAULT_ROW_HEIGHT_ESTIMATE_PX } from "../src/v4/timelineRowHeightCache.js";
import {
  AgentTitleByIdentityMemo,
  buildAgentTitleByIdentity,
} from "../src/v4/conversationAssistantWorkItems.js";

// 未测量 turn 的高度估算。此前一律回落 72px 常量，而实测平均约 372px，
// 差 5 倍量级：首屏期间总高持续暴涨，滚动锚点补偿一直在追一个移动的目标。
// 这里的断言不是锁死具体像素，而是锁死三条结构性性质。

function userRow(rowId: number): UserInputRow {
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

function textRow(rowId: number, text: string): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
  };
}

function reasoningRow(rowId: number): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "思考中",
    state: "complete",
  };
}

function toolRow(rowId: number, toolName = "Read"): ToolCallRow {
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
    input: {},
  };
}

/** Read 属 explore 家族，落进「查阅」桶，渲染层会把连续段收成一行汇总。 */
function readRow(rowId: number): ToolCallRow {
  return toolRow(rowId, "Read");
}

/** TodoWrite 不属任何过程桶（family=todo），每条各占一行。 */
function todoRow(rowId: number): ToolCallRow {
  return toolRow(rowId, "TodoWrite");
}

/**
 * CreatePlan 行，带得动完整计划卡。脱流判定认的是「switch-mode 身份 + title/overview/markdown
 * 任一在场」，所以这里用现役工具名而不是历史 ExitPlanMode。
 */
function createPlanRow(rowId: number, input: Record<string, unknown>): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "CreatePlan",
    status: "success",
    inputText: "",
    input,
  };
}

function estimateOf(rows: ConversationRow[]): number {
  const frame = buildConversationTurnRenderUnitFrame(rows, {});
  const unit = frame.entries[0]?.unit;
  assert.ok(unit, "应当投影出一个 turn");
  return estimateConversationTurnHeight(unit);
}

test("典型完成轮：估算高于 72px 常量，且落在合理量级内", () => {
  const minimal = estimateOf([userRow(1), textRow(2, "好的")]);
  assert.ok(
    minimal > DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    `最小轮估算 ${minimal} 应高于常量 ${DEFAULT_ROW_HEIGHT_ESTIMATE_PX}`,
  );
  assert.ok(minimal < 400, `最小轮估算 ${minimal} 不该虚高`);

  // 真实回复普遍是几段而不是一行，那才是常量低估的主战场。
  const realistic = estimateOf([userRow(1), textRow(2, "a".repeat(1200))]);
  assert.ok(realistic > minimal * 2, `${realistic} 应明显高于最小轮 ${minimal}`);
});

test("正文越长估得越高，且按行数而非字数跳变", () => {
  const short = estimateOf([userRow(1), textRow(2, "a".repeat(50))]);
  const medium = estimateOf([userRow(1), textRow(2, "a".repeat(500))]);
  const long = estimateOf([userRow(1), textRow(2, "a".repeat(5000))]);

  assert.ok(medium > short, "500 字应高于 50 字");
  assert.ok(long > medium, "5000 字应高于 500 字");
});

test("折叠的工具调用历史不计入高度（Radix Presence 关闭时不挂载子 DOM）", () => {
  const fewTools = estimateOf([userRow(1), readRow(2), textRow(9, "答复")]);
  const manyTools = estimateOf([
    userRow(1),
    readRow(2),
    readRow(3),
    readRow(4),
    readRow(5),
    readRow(6),
    readRow(7),
    readRow(8),
    textRow(9, "答复"),
  ]);

  assert.equal(manyTools, fewTools, "历史默认折叠时，DOM 上只剩一个触发按钮，工具条数不该改变高度");
});

test("强制展开的轮才让工具调用进入高度估算", () => {
  // 没有最终正文的轮会整轮默认展开，工具调用是唯一可见内容。
  // TodoWrite 不属任何过程桶，所以条数必须原样体现在高度里。
  const collapsed = estimateOf([userRow(1), textRow(9, "答复")]);
  const oneRow = estimateOf([userRow(1), todoRow(2)]);
  const fourRows = estimateOf([userRow(1), todoRow(2), todoRow(3), todoRow(4), todoRow(5)]);

  assert.ok(oneRow > collapsed, "展开轮的可见内容比折叠轮多");
  assert.ok(fourRows > oneRow, "展开态下不进汇总桶的工具条数必须计入高度");
});

test("连续可折叠的过程行按汇总计，不按原始行数计", () => {
  // 三条连续 Read 收成一行汇总；被 TodoWrite 隔断后是两段汇总。
  const oneRun = estimateOf([userRow(1), readRow(2), readRow(3), readRow(4)]);
  const splitRuns = estimateOf([
    userRow(1),
    readRow(2),
    readRow(3),
    todoRow(4),
    readRow(5),
    readRow(6),
  ]);

  assert.ok(splitRuns > oneRun, "同样 5 行，被隔断成两段应比一段更高，说明是按连续段而非行数计的");
});

test("超长正文按行数封顶，不按字符数无限累加", () => {
  const huge = estimateOf([userRow(1), textRow(2, "a".repeat(2_000_000))]);
  const bigger = estimateOf([userRow(1), textRow(2, "a".repeat(20_000_000))]);
  assert.equal(huge, bigger, "正文行数封顶后不应再随字符数增长");
  assert.ok(huge < MAX_TURN_ESTIMATE_PX);
});

test("单轮估算受上界约束，撑不爆滚动条比例", () => {
  const rows: ConversationRow[] = [userRow(1)];
  for (let rowId = 2; rowId <= 700; rowId += 1) rows.push(todoRow(rowId));
  assert.equal(estimateOf(rows), MAX_TURN_ESTIMATE_PX);
});

test("unit 缺失时给出下界而不是抛错", () => {
  assert.ok(estimateConversationTurnHeight(undefined) > 0);
});

// 末轮计划卡脱流后多出两种 flow 项：原位的紧凑调用记录与轮末的完整卡片。
// `estimateFlowItemHeight` 没有 exhaustiveness 检查，漏掉 planCard 会被 default
// 当成 cuaGroup 去读 `item.rows`（这两项带的是 `row`），虚拟列表当场抛错；
// 就算补错分支按触发行估，滚到底再滚回也会跳。

test("脱流后的计划卡按可见卡片高度估，不是过程行也不是 cuaGroup 触发行", () => {
  const withoutPlan = estimateOf([userRow(1), textRow(2, "好的")]);
  const withPlan = estimateOf([
    userRow(1),
    createPlanRow(2, { plan: "a".repeat(200) }),
    textRow(3, "好的"),
  ]);

  // 一张卡片的外壳本身就有上百 px，远高于一条 32px 的过程行。
  assert.ok(
    withPlan - withoutPlan > 200,
    `脱流后的卡片应显著高于没有计划的那一轮（差 ${withPlan - withoutPlan}px）`,
  );
});

test("Plan 档（计划行在段末）不脱流：只按一条过程行估，不凭空多一张卡", () => {
  const detached = estimateOf([
    userRow(1),
    createPlanRow(2, { plan: "a".repeat(200) }),
    textRow(3, "好的"),
  ]);
  const inPlace = estimateOf([userRow(1), createPlanRow(2, { plan: "a".repeat(200) })]);

  assert.ok(
    detached > inPlace + 200,
    `只有脱流那一轮才该渲染出完整卡片（差 ${detached - inPlace}px）`,
  );
});

test("计划正文越长估得越高，并按 max-h-64 封顶", () => {
  const short = estimateOf([
    userRow(1),
    createPlanRow(2, { plan: "a".repeat(200) }),
    textRow(3, "x"),
  ]);
  const long = estimateOf([
    userRow(1),
    createPlanRow(2, { plan: "a".repeat(2000) }),
    textRow(3, "x"),
  ]);
  const huge = estimateOf([
    userRow(1),
    createPlanRow(2, { plan: "a".repeat(400_000) }),
    textRow(3, "x"),
  ]);

  assert.ok(long > short, "更长的计划正文应估得更高");
  assert.equal(huge, long, "渲染层把正文裁在 max-h-64，超出部分不进估算");
});

test("带 overview 的折叠形态计划卡：高度与正文长度无关，正文根本不进卡片", () => {
  const short = estimateOf([
    userRow(1),
    createPlanRow(2, { title: "方案", overview: "改三处", plan: "a".repeat(200) }),
    textRow(3, "x"),
  ]);
  const long = estimateOf([
    userRow(1),
    createPlanRow(2, { title: "方案", overview: "改三处", plan: "a".repeat(400_000) }),
    textRow(3, "x"),
  ]);

  assert.equal(short, long);
});

test("子智能体标题索引：rows 未变时复用同一个 Map", () => {
  const rows: ConversationRow[] = [userRow(1), toolRow(2, "Task")];
  const memo = new AgentTitleByIdentityMemo();

  const first = memo.resolve(rows);
  // 换一份 rows 数组但行对象全复用——这正是 delta 帧的形状。
  const second = memo.resolve([...rows]);
  assert.equal(second, first, "引用未变时必须复用同一个 Map，否则所有 turn 的 memo 失效");
});

test("子智能体标题索引：任一行换新对象就重算", () => {
  const rows: ConversationRow[] = [userRow(1), toolRow(2, "Task")];
  const memo = new AgentTitleByIdentityMemo();
  const first = memo.resolve(rows);

  const second = memo.resolve([rows[0]!, { ...toolRow(2, "Task"), status: "running" }]);
  assert.notEqual(second, first);
});

test("子智能体标题索引：clear 后不复用旧 Map", () => {
  const rows: ConversationRow[] = [userRow(1), toolRow(2, "Task")];
  const memo = new AgentTitleByIdentityMemo();
  const first = memo.resolve(rows);

  memo.clear();
  assert.notEqual(memo.resolve(rows), first);
});

test("短路不改变索引内容：与每次全量重算结果一致", () => {
  const rows: ConversationRow[] = [userRow(1), toolRow(2, "Task"), toolRow(3, "Bash")];
  const memo = new AgentTitleByIdentityMemo();
  memo.resolve(rows);
  const warmed = memo.resolve([...rows]);

  assert.deepEqual([...warmed.entries()], [...buildAgentTitleByIdentity(rows).entries()]);
});
