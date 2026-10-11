import { useCallback, useSyncExternalStore } from "react";
import type { IUsageStatsService } from "@zcode/services";
import type { SessionErrorInfo, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { buildSessionQuotaBannerDismissKey } from "@/v4/sessionQuotaBannerState.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { logger } from "@/logger.js";
import { sessionQuotaBannerDismissalStore } from "@/v4/sessionQuotaBannerDismissalStore.js";

// 智谱剥离：Start Plan/套餐额度查询与提醒已下线（见 docs/specs/zhipu-special-removal.md）。
// hook 保留签名兼容 SessionPane，仅透传 MCP 不可用事实，不再读 entitlement。
/**
 * V4 quota 业务状态：conversation snapshot 只提供当前 provider/model/错误，
 * MCP 不可用事实由调用方从 conversation rows 解析。
 */
export function useV4SessionQuotaBanner(params: {
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  providerId: string | null;
  modelId: string | null;
  usageStatsService?: IUsageStatsService;
  /**
   * 官方 Server MCP 不可用的事实。由调用方从 conversation rows 解析——它是会话事件的投影，
   * 与 entitlement 服务无关，不放进这个 hook 里取。
   */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}) {
  void params.error;
  void params.phase;
  void params.providerId;
  void params.modelId;
  void params.usageStatsService;
  const state = params.mcpUnavailableNotice
    ? {
        visible: true as const,
        kind: (
          params.mcpUnavailableNotice.code === "quota_exceeded"
            ? "mcp-quota-exhausted"
            : "mcp-plan-required"
        ) as "mcp-quota-exhausted" | "mcp-plan-required",
        concurrentLimitBusinessCode: null,
        concurrentLimitReason: null,
        providerLimitedBusinessCode: null,
        providerLimitedMessage: null,
        modelName: null,
        mcpServerName: params.mcpUnavailableNotice.serverName,
        mcpNoticeRowId: params.mcpUnavailableNotice.rowId,
        remainingTokens: null,
        remainingPercent: null,
        dismissible: true,
        blocksSubmit: false,
        priority: params.mcpUnavailableNotice.code === "quota_exceeded" ? 6 : 8,
      }
    : {
        visible: false as const,
        kind: null,
        concurrentLimitBusinessCode: null,
        concurrentLimitReason: null,
        providerLimitedBusinessCode: null,
        providerLimitedMessage: null,
        modelName: null,
        mcpServerName: null,
        mcpNoticeRowId: null,
        remainingTokens: null,
        remainingPercent: null,
        dismissible: false,
        blocksSubmit: false,
        priority: 0,
      };

  const dismissKey = buildSessionQuotaBannerDismissKey(state, null);
  useSyncExternalStore(
    sessionQuotaBannerDismissalStore.subscribe,
    sessionQuotaBannerDismissalStore.getSnapshot,
    sessionQuotaBannerDismissalStore.getSnapshot,
  );
  const dismissed = Boolean(
    params.sessionId &&
    dismissKey &&
    sessionQuotaBannerDismissalStore.isDismissed(params.sessionId, dismissKey),
  );

  const dismiss = useCallback(() => {
    if (!params.sessionId || !dismissKey) return;
    sessionQuotaBannerDismissalStore.dismiss(params.sessionId, dismissKey);
  }, [dismissKey, params.sessionId]);

  const markShown = useCallback(() => {
    logger.debug("session quota banner markShown (mcp-only, no-op)");
  }, []);

  return {
    state,
    dismissKey,
    dismissed,
    dismiss,
    markShown,
    takesOverError: false,
  } as const;
}
