// 回合投影的输入侧：把 rows 按 turnId 归组成草稿，并判定哪些草稿可以直接沿用
// 上一帧的 unit 对象。
//
// 为什么单独成模块：这两个职责都只关心「输入有没有变」，不关心「unit 长什么样」，
// 而后者（物化 + 落位）是这个领域里最容易膨胀的部分，混在一个文件里会顶破 max-lines。
//
// 复用判据用的是行**对象引用**，不是内容指纹：`applyConversationDeltas` 只替换被
// delta 命中的那一个行对象，未命中的行原样保留引用（`row.appended` push 新对象，
// `row.upserted`/`row.delta` 只写 `window[index]`）。所以「引用相等」精确等价于
// 「这一行没变」——比逐字段比对既便宜，又不会因为漏掉某个字段而让轮次长期显示
// 过期内容。

import type {
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

export function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

export function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

export interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

/**
 * 一个 turn 的投影结果 + 它这一帧实际收到的 rows。
 *
 * rows 存行对象引用，所以「这一帧的输入」可以被下一帧精确比对。
 */
export interface ConversationTurnRenderUnitEntry {
  unit: ConversationTurnRenderUnit;
  /** 轮头行：按 turnId 归组时单独摘出，不进 orderedRows。 */
  header?: TurnHeaderRow;
  /** 该 turn 的全部非轮头行，保持 rows 原始顺序。 */
  orderedRows: ConversationRow[];
}

/**
 * 一帧的完整投影结果。带 sessionPhase 是为了让「phase 变了必须整体重算」这条规则
 * 留在函数内部——phase 不是行的属性，调用方拿行的引用判不出来。
 */
export interface ConversationTurnRenderUnitFrame {
  sessionPhase?: SessionPhase;
  entries: readonly ConversationTurnRenderUnitEntry[];
}

export function createDraftTurnRenderUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到 turnHeader 后
    // 首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，否则补页会把
    // 原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

/** 按 turnId 把整窗 rows 归组成草稿序列，保持 rows 的原始顺序。 */
export function groupRowsIntoTurnDrafts(rows: readonly ConversationRow[]): DraftTurnRenderUnit[] {
  const drafts: DraftTurnRenderUnit[] = [];
  const draftByTurnId = new Map<string, DraftTurnRenderUnit>();
  for (const row of rows) {
    let draft = draftByTurnId.get(row.turnId);
    if (draft === undefined) {
      draft = createDraftTurnRenderUnit(row.turnId);
      drafts.push(draft);
      draftByTurnId.set(row.turnId, draft);
    }
    if (isTurnHeaderRow(row)) {
      draft.header = row;
      continue;
    }
    draft.orderedRows.push(row);
    if (isUserInputRow(row)) {
      draft.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      draft.hookInvocations.push(row);
      continue;
    }
    draft.assistantWorkRows.push(row);
  }
  return drafts;
}

function sameRowSequence(
  previous: readonly ConversationRow[],
  current: readonly ConversationRow[],
): boolean {
  if (previous.length !== current.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

/**
 * 这个草稿能否跳过物化，直接沿用上一帧的 unit。
 *
 * 判据全部朝「变了就一定判不出为真」的方向，宁可多算不可错算：
 * - 轮头引用相同：它决定 isRunning、forceOpenHistory 和工时口径；
 * - 行引用全等：unit 的全部内容都由这些行推出，没变就还是上一帧那个。
 *
 * 运行中的轮一律不跨帧复用：工时吃 nowMs，时钟一变就得重算。完成态工时只来自
 * activeMs/endedAt，与 nowMs 无关，所以历史轮能安全复用——这正是每秒时钟 tick
 * 不再波及整段历史的地方。
 *
 * 位置（isLastTurn）不在这里判：它由 kept 序列的下标决定，而 kept 序列要等这一轮
 * 全部草稿都过完 shouldKeepRenderUnit 才知道。
 */
export function resolveReusableTurnUnit(
  previous: ConversationTurnRenderUnitEntry | undefined,
  draft: DraftTurnRenderUnit,
): ConversationTurnRenderUnit | undefined {
  if (previous === undefined) return undefined;
  if (previous.unit.isRunning) return undefined;
  if (previous.header !== draft.header) return undefined;
  if (!sameRowSequence(previous.orderedRows, draft.orderedRows)) return undefined;
  return previous.unit;
}
