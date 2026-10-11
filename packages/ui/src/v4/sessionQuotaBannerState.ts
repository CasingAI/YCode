import type { UsageEntitlementSnapshot } from "@zcode/shared";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";

// 智谱剥离：Start Plan/套餐额度 banner 已下线，仅保留官方 Server MCP 不可用提示
//（见 docs/specs/zhipu-special-removal.md）。MCP 提示与模型额度是独立通道。

export type SessionQuotaBannerKind = "mcp-quota-exhausted" | "mcp-plan-required";

export interface SessionQuotaBannerState {
  visible: boolean;
  kind: SessionQuotaBannerKind | null;
  concurrentLimitBusinessCode: null;
  concurrentLimitReason: null;
  providerLimitedBusinessCode: null;
  providerLimitedMessage: string | null;
  modelName: string | null;
  /** 官方 Server MCP 提示专用：出问题的 MCP server 名，用于文案点名。 */
  mcpServerName: string | null;
  /** 官方 Server MCP 提示专用：产生该事实的 tool row，参与去重键。 */
  mcpNoticeRowId: number | null;
  reminderKey?: string;
  reminderExpiresAt?: number;
  reminderReferenceTime?: number;
  quotaPeriod?: string;
  remainingTokens: number | null;
  remainingPercent: number | null;
  dismissible: boolean;
  blocksSubmit: boolean;
  priority: number;
}

const HIDDEN_SESSION_QUOTA_BANNER_STATE: SessionQuotaBannerState = {
  visible: false,
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

export function buildSessionQuotaBannerState(params: {
  activeProviderId: string | null;
  snapshot: UsageEntitlementSnapshot | null;
  modelId: string | null;
  serverQuotaExhausted?: boolean;
  isReminderHidden?: (key: string, referenceTime: number) => boolean;
  serverConcurrentLimited?: boolean;
  serverConcurrentLimitBusinessCode?: "3008" | "3009" | "3010";
  serverConcurrentLimitReason?: unknown;
  serverProviderLimitedBusinessCode?: unknown;
  serverProviderLimitedMessage?: string | null;
  /** 官方 Server MCP 在本次会话内被判定不可用的事实（来自 tool row 的结构化标识）。 */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}): SessionQuotaBannerState {
  void params.activeProviderId;
  void params.snapshot;
  void params.modelId;
  void params.serverQuotaExhausted;
  void params.isReminderHidden;
  void params.serverConcurrentLimited;
  void params.serverConcurrentLimitBusinessCode;
  void params.serverConcurrentLimitReason;
  void params.serverProviderLimitedBusinessCode;
  void params.serverProviderLimitedMessage;
  if (params.mcpUnavailableNotice) {
    const mcpQuotaExhausted = params.mcpUnavailableNotice.code === "quota_exceeded";
    return {
      visible: true,
      kind: mcpQuotaExhausted ? "mcp-quota-exhausted" : "mcp-plan-required",
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
      priority: mcpQuotaExhausted ? 6 : 8,
    };
  }
  return HIDDEN_SESSION_QUOTA_BANNER_STATE;
}

export function buildSessionQuotaBannerDismissKey(
  state: SessionQuotaBannerState,
  serverErrorKey?: string | null,
): string | null {
  if (!state.visible || !state.kind) return null;
  if (state.reminderKey) return state.reminderKey;
  return [
    state.kind,
    state.modelName ?? "",
    state.mcpServerName ?? "",
    state.mcpNoticeRowId ?? "",
    state.remainingTokens ?? "",
    state.remainingPercent ?? "",
    state.blocksSubmit ? "blocked" : "unblocked",
    serverErrorKey ?? "",
  ].join(":");
}
