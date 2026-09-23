import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/core";
import {
  NON_ACTIVITY_SESSION_EVENT_TYPES,
  isNonActivitySessionEvent,
} from "../src/zcode-protocol/session-activity-event.js";

// 活动时间的判定入口是「不在此集合内就 bump record.updatedAt」，而它同时是把新时间
// 发进 sessions-index 的同一个同步块。负枚举漏项会直接表现为「点一下几天前的消息，
// 侧栏立刻把它顶进今天」——历史上正是漏了 followup_mode_changed。
//
// 因此这里把「活动」这一侧也显式登记：两侧之和必须等于 SessionEventType 全集，
// 新增事件类型而不归类会让本用例失败，逼迫作者在改动里做一次显式判断。

/** 代表用户会话内容的活动事件（推进 record.updatedAt）。 */
const ACTIVITY_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.SessionForked,
  SessionEventType.SessionCompacted,
  SessionEventType.SessionEnded,
  SessionEventType.TurnStarted,
  SessionEventType.TurnInputReceived,
  SessionEventType.TurnSteerQueued,
  SessionEventType.TurnSteerDeliveryChanged,
  SessionEventType.TurnSteerDispatchChanged,
  SessionEventType.TurnSteerDrained,
  SessionEventType.TurnSteerRejected,
  SessionEventType.TurnSteerDiscarded,
  SessionEventType.TurnSteerReordered,
  SessionEventType.SessionInputPromoted,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.UserMessage,
  SessionEventType.AssistantMessage,
  SessionEventType.AssistantFeedbackUpdated,
  SessionEventType.SystemMessage,
  SessionEventType.ModelRequest,
  SessionEventType.ModelStreaming,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.StreamRecoveryAnchorCreated,
  SessionEventType.StreamRecoveryStarted,
  SessionEventType.StreamRecoveryAnchorSelected,
  SessionEventType.StreamRecoveryTailDiscarded,
  SessionEventType.StreamRecoveryRetryStarted,
  SessionEventType.StreamRecoveryBlocked,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.ModelAnomalyWarning,
  SessionEventType.NetworkRequestStatus,
  SessionEventType.ModelComplete,
  SessionEventType.ModelError,
  SessionEventType.ToolCallScheduled,
  SessionEventType.PlanFileWritten,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.ToolBatchComplete,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.WorkspaceHookReviewRequested,
  SessionEventType.WorkspaceHookReviewSettled,
  SessionEventType.WorkspaceHookReviewSuperseded,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.CompactBoundary,
  SessionEventType.MicrocompactBoundary,
  SessionEventType.RewindTriggered,
  SessionEventType.CheckpointCreated,
  SessionEventType.TargetChanged,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
  SessionEventType.Interrupt,
  SessionEventType.Cancel,
  SessionEventType.Resume,
  SessionEventType.Error,
]);

test("每个会话事件类型都必须在活动/非活动两侧之一登记", () => {
  const unclassified = Object.values(SessionEventType).filter(
    (type) =>
      !ACTIVITY_SESSION_EVENT_TYPES.has(type) && !NON_ACTIVITY_SESSION_EVENT_TYPES.has(type),
  );
  assert.deepEqual(
    unclassified,
    [],
    "新增会话事件类型必须显式归类：推进活动时间放进活动集合，配置/恢复类放进 session-activity-event.ts",
  );
});

test("活动与非活动两侧不能相交", () => {
  const overlap = [...NON_ACTIVITY_SESSION_EVENT_TYPES].filter((type) =>
    ACTIVITY_SESSION_EVENT_TYPES.has(type),
  );
  assert.deepEqual(overlap, []);
});

test("两侧登记的都是真实存在的事件类型常量", () => {
  const known = new Set<string>(Object.values(SessionEventType));
  const unknown = [...ACTIVITY_SESSION_EVENT_TYPES, ...NON_ACTIVITY_SESSION_EVENT_TYPES].filter(
    (type) => !known.has(type),
  );
  assert.deepEqual(unknown, []);
});

test("会话级配置事件不推进活动时间", () => {
  // followup 路由模式：UI 打开会话时按 app 级设置回填，是本次事故的泄漏点。
  for (const type of [
    SessionEventType.FollowupModeChanged,
    SessionEventType.QueueAutoDrainChanged,
    SessionEventType.ModelSelected,
    SessionEventType.SessionModeChanged,
    SessionEventType.SessionTitleUpdated,
    SessionEventType.SessionResumed,
    SessionEventType.WorkspaceHookAdmissionUpdated,
    SessionEventType.HookRunStarted,
  ]) {
    assert.equal(
      isNonActivitySessionEvent({ type } as never),
      true,
      `${type} 不应推进活动时间`,
    );
  }
});

test("用户内容活动事件推进活动时间", () => {
  for (const type of [
    SessionEventType.TurnStarted,
    SessionEventType.UserMessage,
    SessionEventType.AssistantMessage,
    SessionEventType.ToolCallResult,
    SessionEventType.TurnComplete,
    SessionEventType.SessionInputPromoted,
  ]) {
    assert.equal(
      isNonActivitySessionEvent({ type } as never),
      false,
      `${type} 应当推进活动时间`,
    );
  }
});
