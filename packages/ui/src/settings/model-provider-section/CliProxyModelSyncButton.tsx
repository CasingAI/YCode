import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { logger } from "@/logger.js";

/**
 * cliproxy-codex provider 的「同步模型」按钮。
 * 从数据面 `GET /v1/models` 拉取后逐个写入 provider（模板 builtinModelIds 为空，
 * 动态清单是唯一的模型来源）。失败回退到上次结果并如实提示。
 */
export function CliProxyModelSyncButton({
  providerId,
  onAddModel,
}: {
  providerId: string;
  onAddModel: (
    providerId: string,
    modelId: string,
    config: Record<string, never>,
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
}) {
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
      const snapshot = await service.fetchModels();
      if (snapshot.models.length === 0) {
        showFeedback({
          key: feedbackKey,
          state: "failure",
          message: intl.formatMessage({ id: "settings.modelProvider.cliproxyModels.empty" }),
          dismissible: true,
        });
        return;
      }
      let added = 0;
      for (const model of snapshot.models) {
        try {
          await onAddModel(providerId, model.id, {}, true);
          added += 1;
        } catch (error) {
          // 已存在等单条失败不中断整体（幂等同步）。
          logger.warn("[cli-proxy] 同步模型单条失败", { model: model.id, error });
        }
      }
      showFeedback({
        key: feedbackKey,
        state: snapshot.stale ? "failure" : "success",
        message: intl.formatMessage(
          { id: "settings.modelProvider.cliproxyModels.synced" },
          { count: added },
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
