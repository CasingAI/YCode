/* eslint-disable max-lines -- interaction dialog lifecycle and idempotent recovery must stay together. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeElicitationRequest, ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePendingInteractionTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { logger } from "@/logger.js";
import { isPlanApprovalUserInputRequest } from "@/lib/planApproval.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  isConnectionClosedError,
  isDefinitelyUnsentCommandError,
  pendingCommandRegistry,
} from "@/v4/pendingCommandRegistry.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import {
  pendingPermissionToLegacyRequest,
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "@/v4/V4UserInputDialog.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
}

function getCurrentSessionInteractionSnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot | null,
): ConversationSnapshot | null {
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

interface InteractionAutoResolutionIntentTracker {
  markInteracted(interactionId: string): void;
  consumeSnooze(interactionId: string, autoResolutionReady: boolean): boolean;
  releaseSnooze(interactionId: string): void;
}

function createInteractionAutoResolutionIntentTracker(): InteractionAutoResolutionIntentTracker {
  const interactedIds = new Set<string>();
  const sentIds = new Set<string>();
  return {
    markInteracted(interactionId) {
      interactedIds.add(interactionId);
    },
    consumeSnooze(interactionId, autoResolutionReady) {
      if (!autoResolutionReady || !interactedIds.has(interactionId) || sentIds.has(interactionId)) {
        return false;
      }
      sentIds.add(interactionId);
      return true;
    },
    releaseSnooze(interactionId) {
      sentIds.delete(interactionId);
    },
  };
}

const PLAN_APPROVAL_ENVELOPE_TTL_MS = 24 * 60 * 60 * 1_000;
const planApprovalEnvelopes = new Map<string, { envelope: CommandEnvelope; expiresAt: number }>();

function planApprovalKey(sessionId: string, interactionId: string): string {
  return `${sessionId}\u0000${interactionId}`;
}

function getPlanApprovalEnvelope(sessionId: string, interactionId: string): CommandEnvelope {
  const now = Date.now();
  for (const [key, value] of planApprovalEnvelopes) {
    if (value.expiresAt <= now) planApprovalEnvelopes.delete(key);
  }
  const key = planApprovalKey(sessionId, interactionId);
  const existing = planApprovalEnvelopes.get(key);
  if (existing) return existing.envelope;
  const envelope = createCommandEnvelope({
    type: "resolveInteraction",
    sessionId,
    payload: { interactionId, answer: { action: "decline" } },
  });
  planApprovalEnvelopes.set(key, { envelope, expiresAt: now + PLAN_APPROVAL_ENVELOPE_TTL_MS });
  return envelope;
}

function clearPlanApprovalEnvelope(sessionId: string, interactionId: string): void {
  planApprovalEnvelopes.delete(planApprovalKey(sessionId, interactionId));
}

/**
 * 竖切：把 projection.pendingInteractions 接到 PermissionDialog / userInput 弹窗。
 * ChatView 删除后若无此组件，带 tool 权限的会话会永久阻塞。
 */
export function V4InteractionDialogs({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  provider,
  snapshot,
  onCommandSettled,
}: V4InteractionDialogsProps) {
  const { sendCommand } = useV4Conversation();
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  // task 切换时 sessionId 会先更新，旧 task snapshot 可能再保留一帧。
  // 若直接使用旧 snapshot，会把当前 task 的 renderer-local 问答草稿误判为过期并清理。
  const currentSnapshot = getCurrentSessionInteractionSnapshot(sessionId, snapshot);
  // workspaceHookReview 是 Settings/Hooks 处理的特殊交互，不能由通用 Dialog 渲染；
  // 但它可以和 permission/userInput 共存，固定读取 [0] 会遮挡后续真正需要弹窗的交互。
  // 这里只选择本组件可渲染的首个交互，同时保留 permission/userInput 的队列顺序。
  const pending =
    currentSnapshot?.pendingInteractions.find(
      (interaction) =>
        interaction.payload.kind === "permission" || interaction.payload.kind === "userInput",
    ) ?? null;
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  // 计划批准不再做成模态弹窗：到达即静默拒绝，「开始实施」改由计划卡片的按钮承担。
  // 这里先算出它的 interactionId——既给下方拒绝 effect 用，也用于跳过弹窗渲染。
  const planApprovalInteractionId =
    pending &&
    pending.payload.kind === "userInput" &&
    isPlanApprovalUserInputRequest(pending.payload)
      ? pending.interactionId
      : null;
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const localElicitationDraft = useZCodeSessionStore((state) => {
    if (!pending || pending.payload.kind !== "userInput") return undefined;
    return getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
      .elicitationFormDraftsByRequestId[pending.interactionId];
  });
  usePendingInteractionTaskNotifications({
    snapshot: currentSnapshot,
    enabled: notificationEnabled,
    platform,
    formatMessage: intl.formatMessage,
  });
  useEffect(() => {
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // 软门禁：不再强制跳转 Settings/Hooks。
    // 用户通过 WorkspaceHookPendingBanner 的 [去审核] 按钮主动打开 Hooks 设置。
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
  const autoResolutionIntentRef = useRef(createInteractionAutoResolutionIntentTracker());
  const loggedSnoozeSourceIdsRef = useRef(new Set<string>());
  // 已发出静默拒绝的计划批准 interactionId。快照在 ACK 回来前仍会带着它，
  // 这个集合保证同一个交互只拒绝一次。
  const planApprovalDeclinedIdsRef = useRef(new Set<string>());
  const [permissionResponse, setPermissionResponse] = useState<{
    interactionId: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const permissionResponseFlight = useRef<string | null>(null);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      answer: {
        optionId?: string;
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
      commandEnvelope?: CommandEnvelope,
    ) => {
      const envelope =
        commandEnvelope ??
        createCommandEnvelope({
          type: "resolveInteraction",
          sessionId,
          payload: { interactionId, answer },
        });
      // 权限/freeText/content 不落盘；registry 只持摘要，用于 ACK 丢失后的 query 对账。
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        if (!accepted) {
          logger.warn("[v4-interaction] resolveInteraction 被拒绝", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return accepted;
      } catch (error) {
        if (isDefinitelyUnsentCommandError(error)) {
          pendingCommandRegistry.settle(sessionId, envelope.commandId);
        } else if (isConnectionClosedError(error)) {
          pendingCommandRegistry.markTransportInterrupted(sessionId, envelope.commandId);
        }
        logger.error("[v4-interaction] resolveInteraction 失败", { interactionId, error });
        return false;
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const snoozeAutoResolution = useCallback(
    async (interactionId: string) => {
      return sendInteractionAutoResolutionSnooze({
        sessionId,
        interactionId,
        sendCommand,
        source: "dialog",
        onCommandSettled,
      });
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const persistElicitationDraft = useCallback(
    (requestId: string, draft: ElicitationFormDraft) => {
      useZCodeSessionStore
        .getState()
        .setTaskElicitationFormDraft(workspacePath, sessionId, requestId, draft, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  const removeElicitationDraft = useCallback(
    (requestId: string) => {
      useZCodeSessionStore
        .getState()
        .removeTaskElicitationFormDraft(workspacePath, sessionId, requestId, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!currentSnapshot) return;
    const activeRequestIds = new Set(
      currentSnapshot.pendingInteractions
        .filter((interaction) => interaction.payload.kind === "userInput")
        .map((interaction) => interaction.interactionId),
    );
    const taskUiState = getTaskUiState(
      getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity),
      sessionId,
    );
    for (const requestId of Object.keys(taskUiState.elicitationFormDraftsByRequestId)) {
      if (!activeRequestIds.has(requestId)) {
        // 请求可能在 task 不可见期间被另一端回答或自动结束；回到该 task 后以
        // snapshot 的 pendingInteractions 为权威清理过期 renderer 草稿。
        removeElicitationDraft(requestId);
      }
    }
  }, [currentSnapshot, removeElicitationDraft, sessionId, workspaceIdentity, workspacePath]);

  const sendSnoozeOnce = useCallback(
    async (interactionId: string, autoResolutionReady: boolean) => {
      // 首个 userInput 与 autoResolution durable event 可能相邻两帧到达。未就绪时保留
      // tracker 意图，但向弹窗返回 false，让后续真实操作仍可重试；就绪后的 effect 会补发。
      if (!autoResolutionReady) return false;
      if (!autoResolutionIntentRef.current.consumeSnooze(interactionId, autoResolutionReady)) {
        return true;
      }
      try {
        const accepted = await snoozeAutoResolution(interactionId);
        if (!accepted) autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return accepted;
      } catch {
        autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return false;
      }
    },
    [snoozeAutoResolution],
  );

  useEffect(() => {
    // PermissionRequested 可能先投出 userInput，紧接着 autoResolution durable event 才到。
    // 用户若在这两帧之间完成首个分题操作，先记本地意图，registry 就绪后立即补发一次。
    if (pending) {
      void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
    }
  }, [pending?.autoResolution, pending?.interactionId, sendSnoozeOnce]);

  useEffect(() => {
    // 计划批准静默拒绝：跨 Root 代际复用同一 commandId，避免 ACK 丢失后换新 ID 重发。
    if (!planApprovalInteractionId) return;
    if (planApprovalDeclinedIdsRef.current.has(planApprovalInteractionId)) return;
    planApprovalDeclinedIdsRef.current.add(planApprovalInteractionId);
    const envelope = getPlanApprovalEnvelope(sessionId, planApprovalInteractionId);
    void resolveInteraction(planApprovalInteractionId, { action: "decline" }, envelope)
      .then((accepted) => {
        if (accepted || !pendingCommandRegistry.has(sessionId, envelope.commandId)) {
          clearPlanApprovalEnvelope(sessionId, planApprovalInteractionId);
          if (!accepted) {
            planApprovalDeclinedIdsRef.current.delete(planApprovalInteractionId);
          }
        }
      })
      .catch(() => {
        // 未知结果保留同一 commandId；下一次 Root 代际只做幂等重试/对账。
      });
  }, [planApprovalInteractionId, resolveInteraction, sessionId]);

  if (!pending) {
    return null;
  }

  // 计划批准没有任何弹窗可渲染：拒绝已在上面 effect 里发出。
  if (planApprovalInteractionId) {
    return null;
  }

  // workspaceHookReview 只能由 Settings/Hooks 行内 Trust 处理；绝不降级成通用 Dialog。
  if (pending.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (pending.payload.kind === "permission") {
    const request = pendingPermissionToLegacyRequest(sessionId, {
      ...pending,
      payload: pending.payload,
    });
    return (
      // 连续 permission 会复用输入框焦点状态，按 interaction 重建。
      <PermissionDialog
        key={pending.interactionId}
        request={request}
        workspacePath={workspacePath}
        provider={provider}
        responding={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.pending
        }
        responseError={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.failed
            ? intl.formatMessage({ id: "chat.permission.responseFailed" })
            : undefined
        }
        onRespond={(_requestId, option: ZCodePermissionOption, feedback?: string) => {
          if (permissionResponseFlight.current === pending.interactionId) return;
          const interactionId = pending.interactionId;
          permissionResponseFlight.current = interactionId;
          setPermissionResponse({ interactionId, pending: true, failed: false });
          void resolveInteraction(interactionId, {
            optionId: option.optionId,
            ...(feedback ? { freeText: feedback } : {}),
          }).then((accepted) => {
            if (permissionResponseFlight.current !== interactionId) return;
            permissionResponseFlight.current = null;
            setPermissionResponse({ interactionId, pending: false, failed: !accepted });
          });
        }}
      />
    );
  }

  const elicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  if (elicitationRequest) {
    const isAskUserQuestion =
      pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
      pending.autoResolution !== undefined;
    return (
      <ElicitationDialog
        key={buildV4ElicitationProgressKey(elicitationRequest)}
        request={elicitationRequest}
        initialFormDraft={localElicitationDraft}
        onFormDraftChange={persistElicitationDraft}
        autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
        onFirstInteraction={
          isAskUserQuestion
            ? (source) => {
                if (!loggedSnoozeSourceIdsRef.current.has(pending.interactionId)) {
                  loggedSnoozeSourceIdsRef.current.add(pending.interactionId);
                  logger.debug("[v4-interaction] AskUserQuestion 请求暂停自动结束", {
                    interactionId: pending.interactionId,
                    source,
                  });
                }
                autoResolutionIntentRef.current.markInteracted(pending.interactionId);
                return sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
              }
            : undefined
        }
        onRespond={(_requestId, action, content) => {
          void resolveInteraction(pending.interactionId, {
            action,
            ...(content ? { content } : {}),
          }).then((accepted) => {
            if (!accepted) return;
            removeElicitationDraft(pending.interactionId);
          });
        }}
      />
    );
  }

  const model = pendingUserInputToViewModel({
    ...pending,
    payload: pending.payload,
  });
  return (
    <V4UserInputDialog
      model={model}
      onSubmit={(answer) => {
        void resolveInteraction(pending.interactionId, answer);
      }}
    />
  );
}
