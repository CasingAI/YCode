import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { IModelSelectionService, ModelSelectionViewInput } from "@zcode/services";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
  type WorkspaceConnectionLease,
} from "@/v4/workspaceConnectionRegistry.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { resolveAiSearchModelSelection } from "@/command-center/aiSearchModelLevel.js";
import { AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX } from "@zcode/shared/zcode-protocol-v4";

/**
 * 命令中心一次性 AI 历史搜索的运行状态（docs/specs/command-center-ai-history-search.md）。
 * running 只表示「回合还没收口」；投影报 sessionEnded / phase=error 后进 done/failed，
 * 输入框右侧的圈才熄灭。之前没有 done 态，ACK 成功后 status 永远 running，圈一直转。
 */
export type AiHistorySearchStatus = "idle" | "running" | "done" | "failed";

export interface AiHistorySearchRunner {
  status: AiHistorySearchStatus;
  /** 隐藏会话 id；idle/failed 时为 null。 */
  searchSessionId: string | null;
  /**
   * 隐藏会话的投影租约：浮层用 useConversationProjection(lease) 读流式归纳与工具结果，
   * 只渲染回答与引用，不挂完整会话页。run 结束/取消时释放。
   */
  projectionLease: SessionLease | null;
  /** 失败时的可操作错误文案；非失败时为 null。 */
  error: string | null;
  /** 发起一次搜索（幂等防重入：running 中再次调用直接返回）。 */
  start: (query: string) => void;
  /**
   * 取消当前运行并回收会话（Esc / 改字 / 跳转来源 / 卸载时调用）。
   * 关浮层不调用：运行继续、结果保留，重开浮层照看进度与答案。
   */
  cancel: () => void;
  /** 回到结果列表（改字时调用：取消运行 + 状态复位）。 */
  reset: () => void;
}

function workspaceScope(workspaceAbsPath: string, workspaceIdentity?: string) {
  return {
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
  };
}

/**
 * 命令中心 AI 搜索运行器：经工作区连接向当前 Host 发 startAiHistorySearch，
 * 成功后持有连接租约并订阅隐藏会话投影；取消/改字/卸载时发 cancelAiHistorySearch 回收。
 * 关浮层不回收：Dialog 常驻 App 层，租约与订阅在关闭期间不断，运行继续、快照保留。
 * 回合收口（投影 control.sessionEnded / phase=error）驱动 status 进 done/failed，
 * 输入框右侧的圈随之熄灭；连接租约保留到下一次 start/reset/卸载再释放，
 * 避免收口瞬间释放把 keep-warm 中的快照一起丢掉。
 * 连接租约不跨 run 复用：新一轮 start 先放掉上一轮的持有再建新的。
 * 模型：发起时读一次工作区模型服务视图的 effectiveSelection，随 start 载荷下发
 * （CLI 钉到隐藏会话）；读失败/无选择时字段缺席，沿旧行为走 CLI 配置默认。
 */
export function useAiHistorySearchRunner(params: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  agentService: WorkspaceConnectionAgentService | null;
  modelSelectionService: Pick<IModelSelectionService, "getView"> | null;
  /** 与副文案显示同一份视图的输入：recent 意图，不带则视图无 effectiveSelection。 */
  modelSelectionInput?: ModelSelectionViewInput;
}): AiHistorySearchRunner {
  const { workspaceAbsPath, workspaceIdentity, agentService, modelSelectionService, modelSelectionInput } = params;
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<AiHistorySearchStatus>("idle");
  const [searchSessionId, setSearchSessionId] = useState<string | null>(null);
  const [projectionLease, setProjectionLease] = useState<SessionLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  // 收口订阅：投影 store 的 unsubscribe，run 结束/取消/新一轮时退订。
  // 之前没有这份订阅：ACK 成功后 status 永远 running，圈一直转到天荒地老。
  const settleUnsubRef = useRef<(() => void) | null>(null);
  // run 持有的资源：连接租约 + 会话投影租约，随 cancel/新一轮/卸载释放。
  // 收口后不清：CLI 侧删会话只影响服务端，UI 侧快照留在 store 里供展示；
  // 且数据层 release 只是引用计数归零进 30s keep-warm，此时释放租约反而
  // 可能让快照在重开浮层前过期。租约留到下一次 start/reset/卸载再放。
  const heldRef = useRef<{
    connection: WorkspaceConnectionLease;
    session: SessionLease | null;
  } | null>(null);

  const releaseHeld = useCallback(() => {
    const held = heldRef.current;
    heldRef.current = null;
    if (!held) return;
    try {
      held.session?.release();
    } catch {
      // 释放只做引用计数归零，失败不阻断后续清理。
    }
    try {
      held.connection.release();
    } catch {
      // 同上。
    }
  }, []);

  const sendCancelCommand = useCallback(
    (connection: WorkspaceConnectionLease, sessionId: string) => {
      void connection.transport
        .sendCommand(
          createCommandEnvelope({
            type: "cancelAiHistorySearch",
            payload: { searchSessionId: sessionId },
            // 工作区级命令：信封 sessionId 为 null，路由键在 payload.searchSessionId。
            sessionId: null,
          }),
        )
        .catch((sendError: unknown) => {
          // 回收失败只记日志：会话侧回合结束也会自删，不让浮层关闭被卡住。
          logger.warn("[ai-history-search] 回收隐藏会话失败", {
            searchSessionId: sessionId,
            error: sendError instanceof Error ? sendError.message : String(sendError),
          });
        });
    },
    [],
  );

  // 投影收口驱动 status：sessionEnded 进 done，phase=error 进 failed。
  // 由订阅回调调用：CLI 侧收口后删会话前先把终态帧刷出，浮层至少能看到一次 sessionEnded。
  const settleFromProjection = useCallback((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const control = (snapshot as Record<string, unknown>).control;
    if (!control || typeof control !== "object") return;
    const controlRecord = control as Record<string, unknown>;
    const turnFailed = controlRecord.phase === "error";
    const completed = controlRecord.sessionEnded === true;
    if (!completed && !turnFailed) return;
    // 订阅只用一次：收口后退订，避免后续快照反复 setState。
    settleUnsubRef.current?.();
    settleUnsubRef.current = null;
    inFlightRef.current = false;
    if (turnFailed && !completed) {
      const lastError = controlRecord.lastError;
      const message =
        lastError && typeof lastError === "object"
          ? (lastError as Record<string, unknown>).message
          : null;
      setError(typeof message === "string" && message.trim() ? message : null);
      setStatus("failed");
      return;
    }
    // error 收口也算 done：回答区自己读 turnFailed/turnError 展示服务端文案，
    // runner 的 status 只管圈灭不灭，失败文案不在这里定。
    setStatus("done");
  }, []);

  const cancel = useCallback(() => {
    const held = heldRef.current;
    const sessionId = searchSessionId;
    settleUnsubRef.current?.();
    settleUnsubRef.current = null;
    inFlightRef.current = false;
    setStatus("idle");
    setSearchSessionId(null);
    setProjectionLease(null);
    setError(null);
    if (held) {
      if (sessionId) sendCancelCommand(held.connection, sessionId);
      releaseHeld();
      return;
    }
    // 无持有租约（start 尚未 accepted）：若有已知会话 id 则临借连接发取消。
    if (!sessionId || !agentService) return;
    try {
      const connection = acquireWorkspaceConnection(
        workspaceScope(workspaceAbsPath, workspaceIdentity),
        agentService,
      );
      sendCancelCommand(connection, sessionId);
      connection.release();
    } catch (sendError) {
      logger.warn("[ai-history-search] 回收隐藏会话失败", {
        searchSessionId: sessionId,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  }, [
    agentService,
    releaseHeld,
    searchSessionId,
    sendCancelCommand,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const start = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed || inFlightRef.current) return;
      if (!agentService) {
        setStatus("failed");
        setError(intl.formatMessage({ id: "commandCenter.aiSearch.noRuntime" }));
        return;
      }
      inFlightRef.current = true;
      setStatus("running");
      setError(null);
      setSearchSessionId(null);
      setProjectionLease(null);
      // 新一轮先放上一轮的持有（上一轮收口后租约一直留着展示用），再建新的。
      settleUnsubRef.current?.();
      settleUnsubRef.current = null;
      releaseHeld();

      const workspaceId = workspaceIdentity?.trim() || workspaceAbsPath;
      const connection = acquireWorkspaceConnection(
        workspaceScope(workspaceAbsPath, workspaceIdentity),
        agentService,
      );
      heldRef.current = { connection, session: null };
      // 发起时工作区当前模型只读一次：getView 失败/无有效选择时字段缺席，
      // CLI 回退配置默认。读模型不阻断发送（失败只记日志）。
      const sendStart = (model?: ModelSelection) => {
        void connection.transport
          .sendCommand(
            createCommandEnvelope({
              type: "startAiHistorySearch",
              payload: {
                workspaceId,
                query: trimmed,
                language: locale.startsWith("zh") ? "zh-CN" : "en-US",
                ...(model ? { model } : {}),
              },
              sessionId: null,
            }),
          )
          .then((ack: CommandAck) => {
            if (!inFlightRef.current) return;
            if (ack.status === "accepted" && ack.result?.type === "startAiHistorySearch") {
              const sessionId = ack.result.sessionId;
              // 订阅隐藏会话投影：浮层只渲染回答与引用，不挂完整会话页。
              const session = connection.layer.acquire(sessionId);
              const held = heldRef.current;
              if (held) held.session = session;
              else session.release();
              // 收口订阅：终态帧一到就切 done/failed 让圈熄灭。
              // store.close 只清 subscriptionId 不清 snapshot，已有快照不受影响；
              // 快订阅在 complete 前下线（CLI 先刷终态帧再删会话）的兜底：
              // 订阅回调里读 getState，首帧若已收口直接结算。
              settleUnsubRef.current?.();
              const unsubscribe = session.store.subscribe(() => {
                settleFromProjection(session.store.getState().snapshot);
              });
              settleUnsubRef.current = unsubscribe;
              setSearchSessionId(sessionId);
              setProjectionLease(session);
              setStatus("running");
              settleFromProjection(session.store.getState().snapshot);
              return;
            }
            inFlightRef.current = false;
            releaseHeld();
            setStatus("failed");
            const reasonCode = ack.reasonCode ?? "";
            setError(
              reasonCode.startsWith(AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX)
                ? intl.formatMessage({ id: "commandCenter.aiSearch.unsupported" })
                : (ack.message?.trim() ||
                    intl.formatMessage(
                      { id: "commandCenter.aiSearch.failed" },
                      { code: reasonCode || ack.status },
                    )),
            );
          })
          .catch((sendError: unknown) => {
            if (!inFlightRef.current) return;
            inFlightRef.current = false;
            releaseHeld();
            setStatus("failed");
            setError(
              intl.formatMessage(
                { id: "commandCenter.aiSearch.failed" },
                { code: sendError instanceof Error ? sendError.message : String(sendError) },
              ),
            );
          });
      };
      if (!modelSelectionService) {
        sendStart();
        return;
      }
      // 模型读取与发送解耦：getView 挂起时不等它，缺席即按无模型发送。
      // 与副文案显示同一份意图：recent 当 input 传进去解析 effectiveSelection，
      // 还拿不到时退 preferredSelection（新建任务同款），都不在才回退 CLI 默认。
      // 搜索只跑最低成本档位：身份沿用当前选择，档位按该模型档位表压低后再下发。
      void modelSelectionService
        .getView(modelSelectionInput)
        .then(
          (view) =>
            resolveAiSearchModelSelection(
              view,
              view.effectiveSelection ?? view.preferredSelection ?? undefined,
            ) ?? undefined,
          (viewError: unknown) => {
            logger.warn("[ai-history-search] 读取工作区当前模型失败，回退 CLI 默认", {
              error: viewError instanceof Error ? viewError.message : String(viewError),
            });
            return undefined;
          },
        )
        .then((model) => {
          if (!inFlightRef.current) return;
          sendStart(model ?? undefined);
        });
    },
    [agentService, intl, locale, modelSelectionInput, modelSelectionService, releaseHeld, workspaceAbsPath, workspaceIdentity],
  );

  const reset = useCallback(() => {
    cancel();
  }, [cancel]);

  // 卸载即回收：防隐藏会话泄漏。
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    return () => {
      cancelRef.current();
    };
  }, []);

  return { status, searchSessionId, error, projectionLease, start, cancel, reset };
}
