import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { logger } from "@/logger.js";

/**
 * CLI Proxy Provider 的模型同步入口。Host 独立获取名单和能力并批量提交配置。
 */
export function CliProxyModelSyncButton({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const { showFeedback } = useProviderDetailFeedback();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    const service = services?.cliProxyService;
    if (!service || syncing) return;
    setSyncing(true);
    const feedbackKey = `cliproxy-sync:${providerId}`;
    try {
      const result = await service.syncModels(providerId);
      const partialFailure = result.capabilitiesError !== null;
      showFeedback({
        key: feedbackKey,
        state: partialFailure ? "failure" : "success",
        message: partialFailure
          ? intl.formatMessage({ id: "settings.modelProvider.cliproxyModels.capabilitiesFailed" })
          : intl.formatMessage(
              { id: "settings.modelProvider.cliproxyModels.synced" },
              { count: result.added, updated: result.updated },
            ),
        dismissible: true,
      });
    } catch (error) {
      logger.warn("[cli-proxy] 同步模型失败", { error });
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.cliproxyModels.failed" }),
        dismissible: true,
      });
    } finally {
      setSyncing(false);
    }
  };

  // 内嵌在「模型列表」标题行时由父级提供排版，此处只渲染按钮本体。
  return (
    <Button type="button" size="sm" variant="outline" disabled={syncing} onClick={() => void handleSync()}>
      {syncing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: "settings.modelProvider.cliproxyModels.sync" })}
    </Button>
  );
}
