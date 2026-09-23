import { type SessionEvent, SessionEventType } from "@zcode/core";

/**
 * 会话活动时间的分类事实源：哪些会话事件**不代表**用户活动。
 *
 * `record.updatedAt` 就是 sessions-index 的 `lastActivityAt`（v4-bridge `getSessionIndexMeta`），
 * 侧栏任务时间线按它分组排序。`onSessionEvent` 的写入规则是「不在此集合内就
 * `record.updatedAt = Date.now()`」，并且**同一个同步块紧接着 `v4Gateway.ingest` 把新时间发帧**，
 * 所以一次误判会立刻把点开的旧任务顶进侧栏「今天」，事后无法收回。
 *
 * 归类标准是「这是用户产生会话内容的活动吗」，不是「这次操作是不是用户点的」：
 *
 * - 会话选型配置 `ModelSelected` / `SessionModeChanged` / `FollowupModeChanged` /
 *   `QueueAutoDrainChanged`：会话级选型与路由开关。UI 打开会话时会按 app 级设置回填，
 *   属配置同步而非用户内容活动。
 * - 会话元数据 `SessionTitleUpdated`：标题是元数据；冷恢复会为 v4 投影补发标题事件
 *   （内存事件 store 不回灌历史标题），不能因此把历史任务当成刚活动过。
 * - 恢复/准入 `SessionResumed` / `WorkspaceHookAdmissionUpdated`：打开、恢复、重新评估工作区
 *   hook 准入都是读取；冷恢复路径已把 `record.updatedAt` 回填成 store 的真实时间，若再被冲成
 *   `Date.now()`，点开或刷新任务就会被顶到列表最前并整列重排。
 * - hook 生命周期 `HookRun*`：hook 是 turn/session 的内部执行细节；正常 turn 已有消息、工具等
 *   内容事件负责推进时间，冷恢复的 SessionStart hook 不能单独制造一次用户活动。
 *
 * 完整性由 `test/sessionActivityEvent.test.ts` 机械保证：新增事件类型必须显式归类，
 * 否则该测试失败。历史上正是靠人工维护负枚举漏掉了 `followup_mode_changed`，导致
 * 「点一下旧消息立刻变成今天」。
 */
export const NON_ACTIVITY_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  // 会话选型配置：切模型 / 切协作模式 / 切 followup 路由 / 切 queue autoDrain。
  SessionEventType.ModelSelected,
  SessionEventType.SessionModeChanged,
  SessionEventType.FollowupModeChanged,
  SessionEventType.QueueAutoDrainChanged,
  // 会话元数据：标题补发。
  SessionEventType.SessionTitleUpdated,
  // 恢复与准入：打开是读取。
  SessionEventType.SessionResumed,
  SessionEventType.WorkspaceHookAdmissionUpdated,
  // hook 生命周期。
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

/** 该会话事件是否不属于用户活动（不推进 `record.updatedAt`）。 */
export function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return NON_ACTIVITY_SESSION_EVENT_TYPES.has(event.type);
}
