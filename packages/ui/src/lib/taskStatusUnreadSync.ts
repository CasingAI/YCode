import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { isTerminalActivitySeen, isValidTerminalActivityVersion } from "@/lib/taskReadWatermark.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { logger } from "@/logger.js";

/** 复用 Host task service 的权威方法签名，避免界面层复制参数/返回类型。 */
export type TaskUnreadDecisionService = Pick<IZCodeTaskService, "setTaskUnread">;

/** `terminalActivityAt` 已进入 shared 协议类型，直接复用，不再本地交叉扩展。 */
export type TaskStatusChangedEvent = ZCodeWorkspaceTaskListChanged;

const STATUS_UNREAD_DEDUPE_WINDOW_MS = 1_000;
const STATUS_UNREAD_DEDUPE_MAX_KEYS = 256;
const recentStatusUnreadAtByKey = new Map<string, number>();

/**
 * 只登记“正在等待 Host 回包”的请求上下文；广播到达时更新这些在途快照。
 * 没有在途请求就不保存未读状态，避免 renderer 形成第二份派生权威/无界内存。
 */
interface InFlightTaskUnreadContext {
  latestBroadcast?: {
    unreadAt?: number;
    lastSeenActivityAt?: number;
  };
}

const inFlightUnreadContextsByEntityKey = new Map<string, Set<InFlightTaskUnreadContext>>();

function registerInFlightUnreadContext(entityKey: string): InFlightTaskUnreadContext {
  const context: InFlightTaskUnreadContext = {};
  const contexts = inFlightUnreadContextsByEntityKey.get(entityKey) ?? new Set();
  contexts.add(context);
  inFlightUnreadContextsByEntityKey.set(entityKey, contexts);
  return context;
}

function unregisterInFlightUnreadContext(
  entityKey: string,
  context: InFlightTaskUnreadContext,
): void {
  const contexts = inFlightUnreadContextsByEntityKey.get(entityKey);
  if (!contexts) {
    return;
  }
  contexts.delete(context);
  if (contexts.size === 0) {
    inFlightUnreadContextsByEntityKey.delete(entityKey);
  }
}

/** 仅用于回归测试：确认回包结束后没有遗留的在途登记。 */
export function getInFlightTaskUnreadContextCountForTest(entityKey: string): number {
  return inFlightUnreadContextsByEntityKey.get(entityKey)?.size ?? 0;
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function resolveTerminalActivityAt(event: TaskStatusChangedEvent): number | undefined {
  return isValidTerminalActivityVersion(event.terminalActivityAt)
    ? event.terminalActivityAt
    : undefined;
}

/**
 * 去重必须区分两次不同完成：`updatedAt` 相同也允许 `terminalActivityAt` 不同。
 * 旧事件没有活动版本时才回退到 `updatedAt`。
 */
function buildStatusUnreadKey(event: TaskStatusChangedEvent, taskId: string): string {
  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  const activityVersion = resolveTerminalActivityAt(event) ?? event.taskMeta?.updatedAt ?? "";
  return [workspaceKey, taskId, event.taskMeta?.status ?? "", activityVersion].join("::");
}

function shouldSkipRecentStatusUnread(key: string): boolean {
  const now = Date.now();
  for (const [recentKey, at] of recentStatusUnreadAtByKey) {
    if (now - at > STATUS_UNREAD_DEDUPE_WINDOW_MS) {
      recentStatusUnreadAtByKey.delete(recentKey);
    }
  }
  if (recentStatusUnreadAtByKey.has(key)) {
    return true;
  }
  recentStatusUnreadAtByKey.set(key, now);
  if (recentStatusUnreadAtByKey.size > STATUS_UNREAD_DEDUPE_MAX_KEYS) {
    const oldestKey = recentStatusUnreadAtByKey.keys().next().value;
    if (oldestKey) {
      recentStatusUnreadAtByKey.delete(oldestKey);
    }
  }
  return false;
}

function shouldMarkStatusEventTaskUnread(params: {
  activeTaskId: string | null;
  activeWorkspace?: { workspacePath: string; workspaceIdentity?: string };
  event: TaskStatusChangedEvent;
}): boolean {
  const taskId = params.event.taskId ?? params.event.taskMeta?.taskId;
  if (
    params.event.reason !== "task_status_changed" ||
    params.event.unreadSignal !== "background_terminal" ||
    !taskId ||
    !isTerminalTaskStatus(params.event.taskMeta?.status)
  ) {
    return false;
  }
  // 新事件带终态活动版本时由 Host 结合 lastSeenActivityAt 裁决，
  // renderer 不再用“当前 active task”绕过跨端已读。
  if (resolveTerminalActivityAt(params.event) !== undefined) {
    return true;
  }
  // 旧事件没有可比对的版本，保留原有 active task 豁免。
  if (!params.activeWorkspace) {
    return true;
  }
  const isEventWorkspaceActive =
    buildTaskWorkspaceKey(
      params.activeWorkspace.workspacePath,
      params.activeWorkspace.workspaceIdentity,
    ) === buildTaskWorkspaceKey(params.event.workspacePath, params.event.workspaceIdentity);
  return !isEventWorkspaceActive || params.activeTaskId !== taskId;
}

function publishInFlightTaskUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  meta: Pick<ZCodeTaskMeta, "unreadAt" | "lastSeenActivityAt">,
): void {
  const contexts = inFlightUnreadContextsByEntityKey.get(buildTaskEntityKey(task));
  if (!contexts) {
    return;
  }
  const snapshot = {
    unreadAt: typeof meta.unreadAt === "number" ? meta.unreadAt : undefined,
    lastSeenActivityAt:
      typeof meta.lastSeenActivityAt === "number" ? meta.lastSeenActivityAt : undefined,
  };
  for (const context of contexts) {
    context.latestBroadcast = snapshot;
  }
}

/**
 * 回包与期间广播的权威性裁决。
 *
 * - 广播中的水位已覆盖本次终态（例如手机 seen）：以广播为准，迟到 marker 不得复活绿点；
 * - 广播 marker 不早于回包 marker：广播更新（marker 严格递增）或同版本；
 * - 广播只是更早的空状态（水位未覆盖本次终态）时，不能用它压掉 Host 刚提交的新未读。
 */
function resolveCommittedUnread(params: {
  latestBroadcast: InFlightTaskUnreadContext["latestBroadcast"];
  responseUnreadAt: number | undefined;
  responseLastSeenActivityAt: number | undefined;
  terminalActivityAt: number;
}): number | undefined {
  const { latestBroadcast, responseUnreadAt, responseLastSeenActivityAt, terminalActivityAt } =
    params;
  if (!latestBroadcast) {
    return responseUnreadAt;
  }
  if (
    isTerminalActivitySeen({
      lastSeenActivityAt: latestBroadcast.lastSeenActivityAt,
      terminalActivityAt,
    })
  ) {
    return latestBroadcast.unreadAt;
  }
  if (
    typeof responseUnreadAt !== "number" &&
    isTerminalActivitySeen({
      lastSeenActivityAt: responseLastSeenActivityAt,
      terminalActivityAt,
    })
  ) {
    // 回包提交更晚且明确无未读：期间到达的旧 numeric 广播不能复活绿点。
    return undefined;
  }
  if (typeof latestBroadcast.unreadAt === "number") {
    if (typeof responseUnreadAt !== "number" || latestBroadcast.unreadAt >= responseUnreadAt) {
      return latestBroadcast.unreadAt;
    }
    return responseUnreadAt;
  }
  // 广播没有 marker 且水位未覆盖本次终态：它早于 Host 本次提交。
  return responseUnreadAt;
}

/**
 * Host 的 task_meta_changed 是未读/水位的权威收敛事件（含其他客户端的 seen）。
 * 用它更新精确 entity overlay，避免本端旧的数值 overlay 永远压过已清除的未读。
 */
export function reconcileTaskMetaChangedEvent(event: TaskStatusChangedEvent): void {
  if (event.reason !== "task_meta_changed" || !event.taskMeta) {
    return;
  }
  const taskId = event.taskId ?? event.taskMeta.taskId;
  if (!taskId) {
    return;
  }
  const targetTask = {
    taskId,
    workspacePath: event.workspacePath,
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
  };
  publishInFlightTaskUnread(targetTask, event.taskMeta);
  reconcileTaskQueryCacheUnread(targetTask, event.taskMeta.unreadAt);
  // Dock/旧 badge 投影跟随同一权威事件；其他端 seen 后必须同步熄灭。
  useZCodeSessionStore
    .getState()
    .setTaskUnreadIndicator(
      event.workspacePath,
      taskId,
      typeof event.taskMeta.unreadAt === "number",
      event.workspaceIdentity,
    );
}

/**
 * 旧 CLi 事件没有终态版本：保留原 Host/缓存短路路径，避免行为回退。
 */
async function syncLegacyStatusUnread(params: {
  event: TaskStatusChangedEvent;
  service: TaskUnreadDecisionService;
  targetTask: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;
  taskId: string;
}): Promise<void> {
  const { event, service, targetTask, taskId } = params;
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(event.workspacePath, event.workspaceIdentity);
  const taskEntityKey = buildTaskEntityKey(targetTask);
  const queryCacheState = useTaskQueryCacheStore.getState();
  const cachedTask = queryCacheState.taskMetaByEntityKey[taskEntityKey];
  const pendingUnreadAt = queryCacheState.taskUnreadOverlayByEntityKey[taskEntityKey];
  const persistedUnreadAt =
    cachedTask?.unreadAt ??
    event.taskMeta?.unreadAt ??
    (typeof pendingUnreadAt === "number" ? pendingUnreadAt : undefined);
  if (typeof persistedUnreadAt === "number") {
    // 同一条 status 事件会由多个侧栏订阅收到。首个 listener 已经写入
    // query-row overlay 后，后续 listener 只补兼容 Dock badge，不重复落库。
    // 如果 unreadAt 已由事件携带，则直接对账字段；不能为已有未读再创建永久 overlay。
    if (typeof cachedTask?.unreadAt !== "number" && typeof pendingUnreadAt !== "number") {
      rollbackTaskQueryCacheUnread(targetTask, persistedUnreadAt);
    }
    store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    return;
  }

  const dedupeKey = buildStatusUnreadKey(event, taskId);
  if (shouldSkipRecentStatusUnread(dedupeKey)) {
    return;
  }

  const previousUnreadAt = cachedTask?.unreadAt;
  const previousLegacyUnread = getTaskUnreadIndicator(workspaceState, taskId);
  try {
    const meta = await service.setTaskUnread({
      ...targetTask,
      unread: true,
    });
    const committedUnreadAt = typeof meta?.unreadAt === "number" ? meta.unreadAt : undefined;
    if (committedUnreadAt === undefined) {
      // Host 已读水位覆盖终态：不产生新未读，也不能留下 renderer-only 绿点。
      reconcileTaskQueryCacheUnread(targetTask, undefined);
      store.setTaskUnreadIndicator(event.workspacePath, taskId, false, event.workspaceIdentity);
      return;
    }
    reconcileTaskQueryCacheUnread(targetTask, committedUnreadAt);
    store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
  } catch (error) {
    // 持久化失败时不能留下 renderer-only 假未读。恢复提交前字段，
    // 再标脏精确 workspace，让下一轮 membership join 回到 tasks-index 事实。
    rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
    store.setTaskUnreadIndicator(
      event.workspacePath,
      taskId,
      previousLegacyUnread,
      event.workspaceIdentity,
    );
    markTaskQueryCacheScopesStale([targetTask]);
    bumpTaskListMembershipVersion();
    logger.warn(
      "[taskStatusUnreadSync] 持久化后台终态未读失败",
      {
        taskId,
        workspaceIdentity: event.workspaceIdentity ?? null,
        workspacePath: event.workspacePath,
        terminalActivityAt: null,
      },
      error,
    );
  }
}

/**
 * 新版本事件必须每次经 Host：缓存/事件里的旧 marker 不能阻断更高终态推进
 * `unread_activity_at`，否则 seen(T1) 会误清 T2。
 */
async function syncVersionedStatusUnread(params: {
  event: TaskStatusChangedEvent;
  service: TaskUnreadDecisionService;
  targetTask: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;
  taskId: string;
  terminalActivityAt: number;
}): Promise<void> {
  const { event, service, targetTask, taskId, terminalActivityAt } = params;
  const store = useZCodeSessionStore.getState();
  const taskEntityKey = buildTaskEntityKey(targetTask);

  if (shouldSkipRecentStatusUnread(buildStatusUnreadKey(event, taskId))) {
    return;
  }

  // 不读 cached/event marker，也不提前写乐观绿点；只等待 Host 在同一事务内裁决。
  // 在途期间才登记上下文，广播到达时更新；回包结束后立即移除。
  const context = registerInFlightUnreadContext(taskEntityKey);
  try {
    const meta = await service.setTaskUnread({
      ...targetTask,
      unread: true,
      terminalActivityAt,
    });

    // 回包期间若权威广播已到达（例如手机 seen 后 unreadAt 被清除），
    // 迟到 numeric 回包不得复活绿点；以期间最新广播为唯一事实。
    const committedUnreadAt = resolveCommittedUnread({
      latestBroadcast: context.latestBroadcast,
      responseUnreadAt: typeof meta?.unreadAt === "number" ? meta.unreadAt : undefined,
      responseLastSeenActivityAt:
        typeof meta?.lastSeenActivityAt === "number" ? meta.lastSeenActivityAt : undefined,
      terminalActivityAt,
    });

    reconcileTaskQueryCacheUnread(targetTask, committedUnreadAt);
    store.setTaskUnreadIndicator(
      event.workspacePath,
      taskId,
      typeof committedUnreadAt === "number",
      event.workspaceIdentity,
    );
  } catch (error) {
    // 版本化路径没有乐观写入，失败时不能 rollback 旧字段覆盖并发到达的新事实；
    // 只标脏并 bump，让下一次权威 membership/广播收敛。
    markTaskQueryCacheScopesStale([targetTask]);
    bumpTaskListMembershipVersion();
    logger.warn(
      "[taskStatusUnreadSync] Host 裁决后台终态未读失败",
      {
        taskId,
        workspaceIdentity: event.workspaceIdentity ?? null,
        workspacePath: event.workspacePath,
        terminalActivityAt,
      },
      error,
    );
  } finally {
    unregisterInFlightUnreadContext(taskEntityKey, context);
  }
}

/**
 * 后台终态未读只等待 Host 裁决：不在 renderer 先写 `Date.now()` 乐观绿点。
 * 版本化事件即使已有旧未读也必须再次交给 Host，才能推进 `unread_activity_at`；
 * 旧事件保留既有短路/回滚路径。
 */
export async function syncTaskUnreadFromStatusWorkspaceEvent(params: {
  activeWorkspace?: { workspacePath: string; workspaceIdentity?: string };
  event: TaskStatusChangedEvent;
  service: TaskUnreadDecisionService;
}): Promise<void> {
  const { event, service } = params;
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (
    !taskId ||
    event.reason !== "task_status_changed" ||
    event.unreadSignal !== "background_terminal"
  ) {
    return;
  }

  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(event.workspacePath, event.workspaceIdentity);
  if (
    !shouldMarkStatusEventTaskUnread({
      activeTaskId: workspaceState.activeTaskId,
      ...(params.activeWorkspace ? { activeWorkspace: params.activeWorkspace } : {}),
      event,
    })
  ) {
    return;
  }

  const targetTask = {
    taskId,
    workspacePath: event.workspacePath,
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
  };
  const terminalActivityAt = resolveTerminalActivityAt(event);

  if (terminalActivityAt === undefined) {
    await syncLegacyStatusUnread({ event, service, targetTask, taskId });
    return;
  }
  await syncVersionedStatusUnread({
    event,
    service,
    targetTask,
    taskId,
    terminalActivityAt,
  });
}
