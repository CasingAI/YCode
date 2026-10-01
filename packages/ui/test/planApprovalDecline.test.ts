import assert from "node:assert/strict";
import test from "node:test";
import { markCommandNotSent } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  PendingInteraction,
  SessionSummary,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import {
  clearPlanApprovalEnvelope,
  collectPlanApprovalDeclineTargets,
  findPlanApprovalDeclineTarget,
  getPlanApprovalEnvelope,
  planApprovalDeclineKey,
  planApprovalDeclineSettledState,
  sendPlanApprovalDecline,
  shouldAttemptPlanApprovalDecline,
} from "../src/v4/planApprovalDecline.js";
import { pendingCommandRegistry } from "../src/v4/pendingCommandRegistry.js";

// 这组用例锁的是「拒绝命令发不出去之后还能不能救回来」。
// 缺陷本体：decline 发送失败后，effect 把去重标记和命令信封一起清掉，
// 而依赖数组里没有任何「有新信息了」的信号——于是 decline 永久丢失，
// runtime 永远收不到 deny，turn 停在审批闸门，列表行一直转圈加「等待确认」。

const SESSION = "session-plan-approval-test";

function planApprovalInteraction(interactionId: string): PendingInteraction {
  const payload: UserInputRequestPayload = {
    kind: "userInput",
    prompt: "批准这个计划？",
    freeText: true,
    toolCallId: `call-${interactionId}`,
    toolName: "ExitPlanMode",
    traceId: "trace-test",
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    questions: [],
  };
  return {
    interactionId,
    kind: "userInput",
    anchorRowId: null,
    createdAt: 1,
    payload,
  };
}

function askUserQuestionInteraction(interactionId: string): PendingInteraction {
  return {
    interactionId,
    kind: "userInput",
    anchorRowId: null,
    createdAt: 1,
    payload: {
      kind: "userInput",
      prompt: "用哪个代理？",
      freeText: true,
      toolCallId: `call-${interactionId}`,
      toolName: "AskUserQuestion",
      traceId: "trace-test",
      schema: { toolName: "AskUserQuestion" },
      questions: [],
    },
  };
}

function ack(status: CommandAck["status"]): CommandAck {
  return { status, commandId: "ignored" } as CommandAck;
}

/** 摘要只需要带 pendingInteraction 的最小 SessionSummary。 */
function summary(
  sessionId: string,
  pending?: SessionSummary["pendingInteraction"],
): SessionSummary {
  return {
    sessionId,
    workspaceId: "workspace-test",
    title: sessionId,
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    ...(pending ? { pendingInteraction: pending } : {}),
    lastActivityAt: 1,
    createdAt: 1,
  };
}

function planApprovalPending(
  interactionId: string,
): NonNullable<SessionSummary["pendingInteraction"]> {
  return { interactionId, kind: "userInput", toolName: "ExitPlanMode" };
}

test("后台会话（用户没在看的会话）的计划批准同样会被挑出来拒绝", () => {
  // 缺陷本体：拒绝原先挂在只为当前查看会话挂载的组件里。用户提交 prompt 后
  // 1.4 秒切走，decline 就永远没人发，turn 停在审批闸门，列表行一直转圈。
  // 改成走 sessions-index 后，摘要里出现就必须发，与会话视图无关。
  const targets = collectPlanApprovalDeclineTargets(
    [
      summary("sess-viewed", {
        interactionId: "ask-1",
        kind: "userInput",
        toolName: "Bash",
      }),
      summary("sess-background", planApprovalPending("plan-bg")),
    ],
    new Set(),
  );

  assert.deepEqual(targets, [{ sessionId: "sess-background", interactionId: "plan-bg" }]);
});

test("同一会话重复出现在摘要里只产生一个目标", () => {
  const pending = planApprovalPending("plan-dup");
  const targets = collectPlanApprovalDeclineTargets(
    [summary("sess-a", pending), summary("sess-a", pending)],
    new Set(),
  );

  assert.equal(targets.length, 1);
});

test("已拒绝过的 (会话, 交互) 组合不再重发", () => {
  const declined = new Set([planApprovalDeclineKey("sess-a", "plan-1")]);
  const targets = collectPlanApprovalDeclineTargets(
    [
      summary("sess-a", planApprovalPending("plan-1")),
      summary("sess-b", planApprovalPending("plan-2")),
    ],
    declined,
  );

  assert.deepEqual(targets, [{ sessionId: "sess-b", interactionId: "plan-2" }]);
});

test("摘要里没有 pendingInteraction、或是 permission 形态时都不挑出目标", () => {
  // permission 形态的计划批准不是本产品路径：ExitPlanMode 走 userInput +
  // schema.interaction=plan_approval。误判会把普通权限请求直接拒掉。
  const targets = collectPlanApprovalDeclineTargets(
    [
      summary("sess-idle"),
      summary("sess-perm", {
        interactionId: "perm-1",
        kind: "permission",
        toolName: "ExitPlanMode",
      }),
    ],
    new Set(),
  );

  assert.deepEqual(targets, []);
});

test("计划批准排在第二位时也要被找到：只认首个交互会让它永远轮不到被拒绝", () => {
  const target = findPlanApprovalDeclineTarget([
    askUserQuestionInteraction("ask-1"),
    planApprovalInteraction("plan-1"),
  ]);

  assert.equal(target, "plan-1");
});

test("没有计划批准时返回 null，不误伤普通问答", () => {
  assert.equal(findPlanApprovalDeclineTarget([askUserQuestionInteraction("ask-1")]), null);
  assert.equal(findPlanApprovalDeclineTarget(undefined), null);
});

test("投递结果决定重试状态：确定没送达才允许再试，结果未知必须保住幂等", () => {
  assert.deepEqual(planApprovalDeclineSettledState({ commandId: "c1", outcome: "delivered" }), {
    keepDeclinedMarker: true,
    clearEnvelope: true,
  });
  assert.deepEqual(planApprovalDeclineSettledState({ commandId: "c1", outcome: "unsent" }), {
    keepDeclinedMarker: false,
    clearEnvelope: true,
  });
  // unknown 必须两样都留：换了 commandId 重发，runtime 可能已经见过上一条。
  assert.deepEqual(planApprovalDeclineSettledState({ commandId: "c1", outcome: "unknown" }), {
    keepDeclinedMarker: true,
    clearEnvelope: false,
  });
});

test("decline 发出即被标记，同一 id 不重复发", () => {
  const declinedIds = new Set<string>();
  assert.equal(
    shouldAttemptPlanApprovalDecline({
      declinedIds,
      planApprovalInteractionId: "plan-1",
    }),
    true,
  );

  declinedIds.add("plan-1");
  assert.equal(
    shouldAttemptPlanApprovalDecline({
      declinedIds,
      planApprovalInteractionId: "plan-1",
    }),
    false,
  );
  assert.equal(
    shouldAttemptPlanApprovalDecline({
      declinedIds,
      planApprovalInteractionId: null,
    }),
    false,
  );
});

test("传输失败后移出去重标记，下一次权威信号能重新发出并成功送达", async () => {
  const declinedIds = new Set<string>();
  const interactionId = "plan-retry";
  let attempts = 0;

  const attemptOnce = async (send: (envelope: CommandEnvelope) => Promise<CommandAck>) => {
    if (
      !shouldAttemptPlanApprovalDecline({
        declinedIds,
        planApprovalInteractionId: interactionId,
      })
    ) {
      return;
    }
    declinedIds.add(interactionId);
    const envelope = getPlanApprovalEnvelope(SESSION, interactionId);
    const result = await sendPlanApprovalDecline({
      sessionId: SESSION,
      interactionId,
      envelope,
      sendCommand: send,
    });
    attempts += 1;
    const settled = planApprovalDeclineSettledState(result);
    if (settled.clearEnvelope) clearPlanApprovalEnvelope(SESSION, interactionId);
    if (!settled.keepDeclinedMarker) declinedIds.delete(interactionId);
  };

  // 第一次：命令在到达 transport 之前被拒（attachment 换代 / agent 未连接）。
  await attemptOnce(() => Promise.reject(markCommandNotSent(new Error("disposed"))));
  assert.equal(attempts, 1);
  // 确定没送达 → 标记被移出，重试通道仍然开着。
  assert.equal(declinedIds.has(interactionId), false);

  // 同一个 revision 内重复渲染不得再发（闸门仍然生效：标记在飞行中）。
  declinedIds.add(interactionId);
  await attemptOnce(async () => ack("accepted"));
  assert.equal(attempts, 1);
  declinedIds.delete(interactionId);

  // 下一个权威信号（revision / connectionGeneration 变化）到来 → 重试并成功。
  await attemptOnce(async () => ack("accepted"));
  assert.equal(attempts, 2);
  assert.equal(declinedIds.has(interactionId), true);
});

test("连接中断判定为结果未知：标记与信封都要留住，重试沿用同一 commandId", async () => {
  const interactionId = "plan-unknown";
  const envelope = getPlanApprovalEnvelope(SESSION, interactionId);
  const attempt = await sendPlanApprovalDecline({
    sessionId: SESSION,
    interactionId,
    envelope,
    sendCommand: () => {
      const error = new Error("connection closed mid-flight");
      error.name = "ConnectionClosed";
      return Promise.reject(error);
    },
  });

  assert.equal(attempt.outcome, "unknown");
  const settled = planApprovalDeclineSettledState(attempt);
  assert.equal(settled.keepDeclinedMarker, true);
  assert.equal(settled.clearEnvelope, false);
  // 同一 commandId 仍可取回，重试因此保持幂等。
  assert.equal(getPlanApprovalEnvelope(SESSION, interactionId).commandId, envelope.commandId);
  pendingCommandRegistry.settle(SESSION, envelope.commandId);
});

test("attachment 换代（ChannelClient is disposed）算确定未发出：移出去重标记以便重试", async () => {
  // 这就是本次缺陷的真实触发条件：换代时命令根本没写出去。
  // 修复前它会连同去重标记一起被清掉且无人重试，decline 永久丢失。
  const interactionId = "plan-disposed";
  const attempt = await sendPlanApprovalDecline({
    sessionId: SESSION,
    interactionId,
    envelope: getPlanApprovalEnvelope(SESSION, interactionId),
    sendCommand: () => Promise.reject(new Error("ChannelClient is disposed")),
  });

  assert.equal(attempt.outcome, "unsent");
  assert.equal(planApprovalDeclineSettledState(attempt).keepDeclinedMarker, false);
  assert.equal(pendingCommandRegistry.has(SESSION, attempt.commandId), false);
});

test("未分类的异常按结果未知处理，不假定命令没送到", async () => {
  const interactionId = "plan-unclassified";
  const attempt = await sendPlanApprovalDecline({
    sessionId: SESSION,
    interactionId,
    envelope: getPlanApprovalEnvelope(SESSION, interactionId),
    sendCommand: () => Promise.reject(new Error("boom")),
  });

  assert.equal(attempt.outcome, "unknown");
  assert.equal(planApprovalDeclineSettledState(attempt).keepDeclinedMarker, true);
  pendingCommandRegistry.settle(SESSION, attempt.commandId);
});

test("runtime 明确拒绝时判定为未送达：允许换新 commandId 重试", async () => {
  const interactionId = "plan-failed";
  const first = getPlanApprovalEnvelope(SESSION, interactionId);
  const attempt = await sendPlanApprovalDecline({
    sessionId: SESSION,
    interactionId,
    envelope: first,
    sendCommand: async () => ack("failed"),
  });

  assert.equal(attempt.outcome, "unsent");
  assert.equal(planApprovalDeclineSettledState(attempt).keepDeclinedMarker, false);

  clearPlanApprovalEnvelope(SESSION, interactionId);
  const second = getPlanApprovalEnvelope(SESSION, interactionId);
  assert.notEqual(second.commandId, first.commandId);
});

test("accepted / duplicate / noop 三种 ACK 都算已送达，不再重发", async () => {
  for (const status of ["accepted", "duplicate", "noop"] as const) {
    const interactionId = `plan-${status}`;
    const attempt = await sendPlanApprovalDecline({
      sessionId: SESSION,
      interactionId,
      envelope: getPlanApprovalEnvelope(SESSION, interactionId),
      sendCommand: async () => ack(status),
    });
    assert.equal(attempt.outcome, "delivered");
    assert.equal(planApprovalDeclineSettledState(attempt).keepDeclinedMarker, true);
  }
});
