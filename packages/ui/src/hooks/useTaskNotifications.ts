import { useEffect, useMemo, useRef, useState } from "react";
import type { IPlatformService, TaskNotificationPayload } from "@zcode/shared";
import type { ConversationSnapshot, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import {
  collectPendingInteractionNotificationPayloads,
  collectTerminalTaskNotificationPayloads,
} from "@/lib/taskNotificationOrchestrator.js";
import { playSoundForStatus } from "@/lib/taskNotificationSound.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";

type FormatMessage = IntlInstance["formatMessage"];
type TaskNotificationPlatform = Pick<IPlatformService, "showTaskNotification">;

interface WorkspaceTerminalTaskNotificationsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  rpcReady: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface PendingInteractionTaskNotificationsParams {
  snapshot: ConversationSnapshot | null;
  enabled: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface SessionsIndexNotificationState {
  signature: string;
  sessions: readonly SessionSummary[];
  status: SessionsIndexStoreStatus;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildWorkspaceNotificationSignature(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string;
}): string {
  return [
    params.endpointKey ?? "__base__",
    params.workspaceIdentity ?? "",
    params.workspacePath,
  ].join("\0");
}

function toSessionMap(sessions: readonly SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

import type { SoundEventStatus } from "@/lib/systemSoundCatalog.js";

function toPlayableStatus(status: TaskNotificationPayload["status"]): SoundEventStatus | null {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "permission_request" ||
    status === "elicitation_request"
  )
    ? status
    : null;
}

// renderer 侧的聚焦判断与各 platform 的抑制语义对齐：
// Desktop 任一窗口 focused 即前台、Web document.hasFocus() 即前台。
// 注意 hooks 无法直接读 main 的窗口聚焦态，这里用 document.hasFocus() 近似；
// Desktop 多窗口下“本窗口失焦但别窗口聚焦”会误判为后台、从而走通道由 main 抑制去重兜底，
// 最终仍只响一次（见 dispatchTaskNotification 的聚焦抑制 + 3s 去重）。
function isRendererForeground(): boolean {
  if (typeof document === "undefined" || typeof document.hasFocus !== "function") {
    return false;
  }
  try {
    return document.hasFocus();
  } catch {
    return false;
  }
}

function showTaskNotification(
  platform: TaskNotificationPlatform,
  payload: TaskNotificationPayload,
): void {
  // feedback_update 无配音，不在设置页出现，这里直接跳过。
  const playableStatus = toPlayableStatus(payload.status);
  if (!playableStatus) {
    return;
  }
  // 前台聚焦时 platform 层会抑制系统通知（Desktop 任一窗口 focused 直接 return，
  // Web document.hasFocus() 就 return），且提示音只在 show() 成功后才发——
  // 所以前台在这里直接按映射播一声，不再走通道；失焦时只走通道（通知+回放），同一事件只响一次。
  if (isRendererForeground()) {
    void playSoundForStatus(playableStatus);
    return;
  }
  try {
    platform.showTaskNotification(payload);
  } catch (error) {
    logger.warn("[task-notification] 触发平台通知失败", {
      taskId: payload.taskId,
      status: payload.status,
      error,
    });
  }
}

/**
 * v4 任务终态通知编排。
 *
 * v4 重构删掉旧 renderer background monitor 后，platform 通知通道仍在，
 * 但 sessions-index 事实没有再被翻译成展示命令，导致任务完成/失败没有系统通知。
 * 这里只在 renderer 做“已观察边沿”的通知意图，事实仍以 sessions-index 为准；
 * 是否因窗口活跃而抑制通知继续交给 desktop/web platform 层判断。
 */
export function useWorkspaceTerminalTaskNotifications({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  rpcReady,
  platform,
  formatMessage,
}: WorkspaceTerminalTaskNotificationsParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const signature = useMemo(
    () =>
      buildWorkspaceNotificationSignature({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(endpointKey ? { endpointKey } : {}),
      }),
    [endpointKey, workspaceIdentity, workspacePath],
  );
  const [indexState, setIndexState] = useState<SessionsIndexNotificationState>({
    signature,
    sessions: [],
    status: "idle",
  });
  const previousBySessionIdRef = useRef<Map<string, SessionSummary> | null>(null);

  useEffect(() => {
    previousBySessionIdRef.current = null;
    setIndexState({ signature, sessions: [], status: "idle" });
  }, [signature]);

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      // App 壳在 remote attachment 就绪前会先挂载，旧通知 hook
      // 只看用户开关就订阅 sessions-index，从而越过 conversation 的 readiness gate
      // 访问断连代理。这里共用 workspace rpcReady；本地 workspace 始终为 true。
      previousBySessionIdRef.current = null;
      setIndexState({ signature, sessions: [], status: "idle" });
      return;
    }

    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    const syncState = () => {
      setIndexState({
        signature,
        sessions: store.getSessions(),
        status: store.getStatus(),
      });
    };
    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
    };
  }, [
    enabled,
    endpointKey,
    platform,
    rpcReady,
    signature,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !platform ||
      indexState.signature !== signature ||
      indexState.status !== "live"
    ) {
      return;
    }

    const previousBySessionId = previousBySessionIdRef.current;
    const nextBySessionId = toSessionMap(indexState.sessions);
    if (!previousBySessionId) {
      previousBySessionIdRef.current = nextBySessionId;
      return;
    }

    const payloads = collectTerminalTaskNotificationPayloads({
      previousBySessionId,
      sessions: indexState.sessions,
      formatMessage,
    });
    for (const payload of payloads) {
      showTaskNotification(platform, payload);
    }
    previousBySessionIdRef.current = nextBySessionId;
  }, [enabled, formatMessage, indexState, platform, signature]);
}

/**
 * 当前 conversation snapshot 的阻塞交互通知。
 *
 * 首个 snapshot 只作为基线，避免订阅历史/恢复 replayable snapshot 时重放旧权限弹窗通知；
 * 后续新增 interactionId 才发通知，重复 pending 不会刷屏。
 */
export function usePendingInteractionTaskNotifications({
  snapshot,
  enabled,
  platform,
  formatMessage,
}: PendingInteractionTaskNotificationsParams): void {
  const seenRef = useRef<{ sessionId: string; seenRequestIds: Set<string> } | null>(null);

  useEffect(() => {
    if (!enabled || !snapshot) {
      seenRef.current = null;
      return;
    }

    const currentRequestIds = snapshot.pendingInteractions.map(
      (interaction) => interaction.interactionId,
    );
    const currentSeen = seenRef.current;
    if (!currentSeen || currentSeen.sessionId !== snapshot.sessionId) {
      seenRef.current = {
        sessionId: snapshot.sessionId,
        seenRequestIds: new Set(currentRequestIds),
      };
      return;
    }

    if (platform) {
      const payloads = collectPendingInteractionNotificationPayloads({
        snapshot,
        seenRequestIds: currentSeen.seenRequestIds,
        formatMessage,
      });
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
    }

    for (const requestId of currentRequestIds) {
      currentSeen.seenRequestIds.add(requestId);
    }
  }, [enabled, formatMessage, platform, snapshot]);
}
