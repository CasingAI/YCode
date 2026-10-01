// 会话列表摘要里 pendingInteraction 这一个槽位的**位次不变量**：
// 必须优先返回计划批准，而不是数组里的首个 permission/userInput。
//
// 缺陷通路：同一会话里若另有交互排在 ExitPlanMode 审批之前，摘要槽位被它占住。
// 侧栏于是显示「等待确认」却看不出真正卡住的是计划批准，UI 侧靠摘要驱动的
// 静默拒绝也等不到触发信号——decline 永远发不出去，turn 停在审批闸门，
// 列表行就此永久停在转圈加「等待确认」。
//
// 计数不受影响：pendingInteractionSummary 仍统计全部 permission/userInput，
// 只有「哪一条被单独下发」受位次不变量约束。
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";

const WORKSPACE_ID = "/repo";
const SESSION_ID = "session-pending-priority";
const T0 = 1_700_000_000_000;

function askUserQuestion(interactionId: string): PendingInteraction {
  return {
    interactionId,
    kind: "userInput",
    anchorRowId: null,
    createdAt: T0,
    payload: {
      kind: "userInput",
      prompt: "用哪个代理？",
      freeText: true,
      toolCallId: `call-${interactionId}`,
      toolName: "AskUserQuestion",
      traceId: "trace-priority",
      schema: { toolName: "AskUserQuestion" },
      questions: [],
    },
  } as unknown as PendingInteraction;
}

function planApproval(interactionId: string): PendingInteraction {
  return {
    interactionId,
    kind: "userInput",
    anchorRowId: null,
    createdAt: T0,
    payload: {
      kind: "userInput",
      prompt: "批准这个计划？",
      freeText: true,
      toolCallId: `call-${interactionId}`,
      // ExitPlanMode 分支必定写入 toolName：摘要没有 schema，工具名是唯一信号。
      toolName: "ExitPlanMode",
      traceId: "trace-priority",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      questions: [],
    },
  } as unknown as PendingInteraction;
}

function permission(interactionId: string): PendingInteraction {
  return {
    interactionId,
    kind: "permission",
    anchorRowId: null,
    createdAt: T0,
    payload: {
      kind: "permission",
      toolCallId: `call-${interactionId}`,
      toolName: "Bash",
      traceId: "trace-priority",
    },
  } as unknown as PendingInteraction;
}

function snapshotWith(pendingInteractions: PendingInteraction[]): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    logEpoch: "session-epoch",
    revision: 1,
    control: { phase: "running", sessionEnded: false },
    meta: { title: "计划会话", titleSource: "generated" },
    rows: { window: [] },
    backgroundWorks: [],
    pendingInteractions,
    workflowRuns: [],
  } as unknown as ConversationSnapshot;
}

function derive(pendingInteractions: PendingInteraction[]) {
  const projection = new SessionsIndexProjection(WORKSPACE_ID, "index-epoch");
  const [delta] = projection.upsertFromConversation(snapshotWith(pendingInteractions), {
    createdAt: T0,
    lastActivityAt: T0,
  });
  assert.ok(delta && delta.op === "session.upserted");
  return delta.session;
}

test("计划批准排在第二位时，摘要槽位仍然返回它", () => {
  const session = derive([askUserQuestion("ask-1"), planApproval("plan-1")]);

  assert.equal(session.pendingInteraction?.interactionId, "plan-1");
  assert.equal(session.pendingInteraction?.toolName, "ExitPlanMode");
  // 计数不受位次不变量影响：两条 userInput 都要数进去。
  assert.equal(session.pendingInteractionSummary?.userInputCount, 2);
});

test("permission 排在计划批准之前时同样让位", () => {
  const session = derive([permission("perm-1"), planApproval("plan-1")]);

  assert.equal(session.pendingInteraction?.interactionId, "plan-1");
  assert.equal(session.pendingInteractionSummary?.permissionCount, 1);
  assert.equal(session.pendingInteractionSummary?.userInputCount, 1);
});

test("没有计划批准时行为不变：仍取首个可结算交互", () => {
  const session = derive([askUserQuestion("ask-1"), askUserQuestion("ask-2")]);

  assert.equal(session.pendingInteraction?.interactionId, "ask-1");
  assert.equal(session.pendingInteraction?.toolName, "AskUserQuestion");
});

test("permission 形态的 ExitPlanMode 不是计划批准，不得被当成计划批准顶到前面", () => {
  // ExitPlanMode 走 userInput + schema.interaction=plan_approval。误判会把普通
  // 权限请求当成计划批准顶掉，让真正排在前面的交互从摘要里消失。
  const session = derive([permission("perm-exit"), askUserQuestion("ask-1")]);

  assert.equal(session.pendingInteraction?.interactionId, "perm-exit");
  assert.equal(session.pendingInteraction?.kind, "permission");
});
