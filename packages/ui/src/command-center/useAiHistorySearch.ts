import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
  type WorkspaceConnectionLease,
} from "@/v4/workspaceConnectionRegistry.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX } from "@zcode/shared/zcode-protocol-v4";

/** 命令中心一次性 AI 历史搜索的运行状态（docs/specs/command-center-ai-history-search.md）。 */
export type AiHistorySearchStatus = "idle" | "running" | "failed";

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
  /** 取消当前运行并回收会话（Esc / 改字 / 关浮层时调用）。 */
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
 * 成功后持有连接租约并订阅隐藏会话投影；关闭/取消/改字时发 cancelAiHistorySearch 回收。
 * 连接租约随 run 持有随 run 释放（keep-warm 由注册表收口），不跨 run 复用。
 */
export function useAiHistorySearchRunner(params: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  agentService: WorkspaceConnectionAgentService | null;
}): AiHistorySearchRunner {
  const { workspaceAbsPath, workspaceIdentity, agentService } = params;
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<AiHistorySearchStatus>("idle");
  const [searchSessionId, setSearchSessionId] = useState<string | null>(null);
  const [projectionLease, setProjectionLease] = useState<SessionLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  // run 持有的资源：连接租约 + 会话投影租约，随 cancel/完成释放。
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

  const cancel = useCallback(() => {
    const held = heldRef.current;
    const sessionId = searchSessionId;
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

      const workspaceId = workspaceIdentity?.trim() || workspaceAbsPath;
      const connection = acquireWorkspaceConnection(
        workspaceScope(workspaceAbsPath, workspaceIdentity),
        agentService,
      );
      heldRef.current = { connection, session: null };
      void connection.transport
        .sendCommand(
          createCommandEnvelope({
            type: "startAiHistorySearch",
            payload: {
              workspaceId,
              query: trimmed,
              language: locale.startsWith("zh") ? "zh-CN" : "en-US",
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
            setSearchSessionId(sessionId);
            setProjectionLease(session);
            setStatus("running");
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
    },
    [agentService, intl, locale, releaseHeld, workspaceAbsPath, workspaceIdentity],
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
