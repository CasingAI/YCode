/**
 * 子代理只读弹层里的 provider 额度段。
 *
 * 只按子会话 provider + workspace 级 ModelSelectionView 解析来源，再渲染既有额度面板；
 * 面板自身在挂载（弹层打开）时通过既有 hook 拉取/刷新额度，不新增缓存或 service。
 * 只读场景不传 onManage，标题行不出现管理入口，避免从只读面板离开当前会话。
 */
import { useMemo } from "react";
import type { ModelSelectionView } from "@zcode/services";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ChatCliProxyQuotaPanel } from "@/chat-input-toolbar/CliProxyContextUsage.js";
import { ChatCommandCodeQuotaPanel } from "@/chat-input-toolbar/CommandCodeContextUsage.js";
import { ChatDeepSeekBalancePanel } from "@/chat-input-toolbar/DeepSeekContextUsage.js";
import { ChatMiniMaxQuotaPanel } from "@/chat-input-toolbar/MiniMaxContextUsage.js";
import { ChatOpenCodeUsagePanel } from "@/chat-input-toolbar/OpenCodeContextUsage.js";
import { ChatOpenCodeZenBalancePanel } from "@/chat-input-toolbar/OpenCodeZenContextUsage.js";
import { ChatOpenRouterBalancePanel } from "@/chat-input-toolbar/OpenRouterContextUsage.js";
import { ChatZhipuQuotaPanel } from "@/chat-input-toolbar/ZhipuContextQuota.js";
import { buildProviderQuotaConfigs, resolveProviderQuotaSource } from "@/v4/providerQuotaSource.js";

export const SUBAGENT_PROVIDER_QUOTA_TEST_ID = "subagent-provider-quota";

export function SubagentProviderQuotaSection({
  providerId,
  modelSelectionView,
  intl,
  locale,
  separated = false,
}: {
  providerId: string;
  modelSelectionView: ModelSelectionView | null | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const source = useMemo(
    () => resolveProviderQuotaSource({ providerId, modelSelectionView }),
    [providerId, modelSelectionView],
  );
  const configs = useMemo(
    () =>
      buildProviderQuotaConfigs({
        source,
        configRevision: modelSelectionView?.revision,
      }),
    [modelSelectionView?.revision, source],
  );

  if (!source) {
    return null;
  }

  const panel = (() => {
    switch (source.kind) {
      case "opencode-go": {
        const config = configs.openCodeUsage;
        return config ? (
          <ChatOpenCodeUsagePanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "cliproxy": {
        const config = configs.cliProxyQuota;
        return config ? (
          <ChatCliProxyQuotaPanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "deepseek": {
        const config = configs.deepSeekBalance;
        return config ? (
          <ChatDeepSeekBalancePanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "minimax": {
        const config = configs.minimaxQuota;
        return config ? (
          <ChatMiniMaxQuotaPanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "openrouter": {
        const config = configs.openRouterBalance;
        return config ? (
          <ChatOpenRouterBalancePanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "commandcode": {
        const config = configs.commandCodeQuota;
        return config ? (
          <ChatCommandCodeQuotaPanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "opencode-zen": {
        const config = configs.openCodeZenBalance;
        return config ? (
          <ChatOpenCodeZenBalancePanel
            config={config}
            intl={intl}
            locale={locale}
            separated={separated}
          />
        ) : null;
      }
      case "zhipu": {
        const config = configs.zhipuQuota;
        return config ? (
          <ChatZhipuQuotaPanel config={config} intl={intl} locale={locale} separated={separated} />
        ) : null;
      }
    }
  })();

  return panel ? <div data-testid={SUBAGENT_PROVIDER_QUOTA_TEST_ID}>{panel}</div> : null;
}
