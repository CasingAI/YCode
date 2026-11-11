/**
 * provider 额度来源解析（主 composer 与子代理 footer 共用）。
 *
 * 额度段只由 provider 实例的 templateId 决定；目录事实来自 workspace 级
 * ModelSelectionView。这里只做纯匹配，不拉取、不缓存额度；面板挂载时才由各 provider
 * 的既有 hook 读取。两处共用同一函数，避免模板判定顺序在两条 UI 路径上漂移。
 */
import {
  isCliProxyProviderTemplateId,
  isCommandCodeProviderTemplateId,
  isDeepSeekProviderTemplateId,
  isMiniMaxTokenPlanProviderTemplateId,
  isOpenCodeGoProviderTemplateId,
  isOpenCodeZenProviderTemplateId,
  isOpenRouterProviderTemplateId,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ChatCliProxyQuotaConfig } from "@/chat-input-toolbar/CliProxyContextUsage.js";
import type { ChatCommandCodeQuotaConfig } from "@/chat-input-toolbar/CommandCodeContextUsage.js";
import type { ChatDeepSeekBalanceConfig } from "@/chat-input-toolbar/DeepSeekContextUsage.js";
import type { ChatMiniMaxQuotaConfig } from "@/chat-input-toolbar/MiniMaxContextUsage.js";
import type { ChatOpenCodeUsageConfig } from "@/chat-input-toolbar/OpenCodeContextUsage.js";
import type { ChatOpenCodeZenBalanceConfig } from "@/chat-input-toolbar/OpenCodeZenContextUsage.js";
import type { ChatOpenRouterBalanceConfig } from "@/chat-input-toolbar/OpenRouterContextUsage.js";
import type { ChatZhipuQuotaConfig } from "@/chat-input-toolbar/ZhipuContextQuota.js";
import { isZhipuTemplateId } from "@/settings/model-provider-section/ZhipuTemplateQuotaSection.js";

export type ProviderQuotaSourceKind =
  | "opencode-go"
  | "cliproxy"
  | "deepseek"
  | "minimax"
  | "openrouter"
  | "commandcode"
  | "opencode-zen"
  | "zhipu";

export interface ProviderQuotaSource {
  readonly kind: ProviderQuotaSourceKind;
  readonly providerId: string;
  readonly templateId: string;
}

export interface ProviderQuotaConfigs {
  openCodeUsage?: ChatOpenCodeUsageConfig;
  cliProxyQuota?: ChatCliProxyQuotaConfig;
  deepSeekBalance?: ChatDeepSeekBalanceConfig;
  minimaxQuota?: ChatMiniMaxQuotaConfig;
  openRouterBalance?: ChatOpenRouterBalanceConfig;
  commandCodeQuota?: ChatCommandCodeQuotaConfig;
  openCodeZenBalance?: ChatOpenCodeZenBalanceConfig;
  zhipuQuota?: ChatZhipuQuotaConfig;
}

export function resolveProviderQuotaSource({
  providerId,
  modelSelectionView,
}: {
  providerId: string | null | undefined;
  modelSelectionView: ModelSelectionView | null | undefined;
}): ProviderQuotaSource | null {
  const normalizedProviderId = providerId?.trim();
  if (!normalizedProviderId) {
    return null;
  }
  const provider = modelSelectionView?.providers.find(
    (candidate) => candidate.providerId === normalizedProviderId,
  );
  const templateId = provider?.templateId?.trim();
  if (!templateId) {
    return null;
  }
  const source = (kind: ProviderQuotaSourceKind): ProviderQuotaSource => ({
    kind,
    providerId: normalizedProviderId,
    templateId,
  });

  if (isOpenCodeGoProviderTemplateId(templateId)) return source("opencode-go");
  if (isCliProxyProviderTemplateId(templateId)) return source("cliproxy");
  if (isDeepSeekProviderTemplateId(templateId)) return source("deepseek");
  if (isMiniMaxTokenPlanProviderTemplateId(templateId)) return source("minimax");
  if (isOpenRouterProviderTemplateId(templateId)) return source("openrouter");
  if (isCommandCodeProviderTemplateId(templateId)) return source("commandcode");
  if (isOpenCodeZenProviderTemplateId(templateId)) return source("opencode-zen");
  if (isZhipuTemplateId(templateId)) return source("zhipu");
  return null;
}

/**
 * 把来源描述转成既有面板的 config。主 composer 传 onManage 展示管理入口；
 * 子代理只读面板不传，标题行不出现管理按钮。
 */
export function buildProviderQuotaConfigs({
  source,
  onManage,
  configRevision,
}: {
  source: ProviderQuotaSource | null;
  onManage?: () => void;
  configRevision?: number;
}): ProviderQuotaConfigs {
  if (!source) {
    return {};
  }
  const base = {
    providerId: source.providerId,
    ...(onManage ? { onManage } : {}),
  };

  switch (source.kind) {
    case "opencode-go":
      return { openCodeUsage: { ...base, configRevision } };
    case "cliproxy":
      return { cliProxyQuota: base };
    case "deepseek":
      return { deepSeekBalance: base };
    case "minimax":
      return { minimaxQuota: base };
    case "openrouter":
      return { openRouterBalance: base };
    case "commandcode":
      return { commandCodeQuota: base };
    case "opencode-zen":
      return { openCodeZenBalance: { ...base, configRevision } };
    case "zhipu":
      return { zhipuQuota: base };
  }
}
