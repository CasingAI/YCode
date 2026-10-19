import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { logger } from "@/logger.js";

/**
 * ChatGPT Plan 的模型目录刷新入口，内嵌在统一模型列表标题行（对标 CliProxyModelSyncButton）。
 * Host 侧 refreshModels() 重新选择活动账户并拉取目录，随后由 publishChatGPTPlanProvider
 * 发布进 provider 配置；卡片模型列表经 revision 刷新，本组件不持有目录状态。
 */
export function ChatGPTPlanModelRefreshButton() {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const { showFeedback } = useProviderDetailFeedback();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    const service = services?.chatGPTPlanService;
    if (!service || refreshing) return;
    setRefreshing(true);
    const feedbackKey = "chatgpt-plan-model-refresh";
    try {
      await service.refreshModels();
      showFeedback({
        key: feedbackKey,
        state: "success",
        message: intl.formatMessage({ id: "settings.chatGPTPlan.modelsRefreshed" }),
        dismissible: true,
      });
    } catch (error) {
      logger.warn("[chatgpt-plan] 刷新模型目录失败", { error });
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.chatGPTPlan.modelsRefreshFailed" }),
        dismissible: true,
      });
    } finally {
      setRefreshing(false);
    }
  };

  // 内嵌在「模型列表」标题行时由父级提供排版，此处只渲染按钮本体。
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={refreshing}
      onClick={() => void handleRefresh()}
    >
      {refreshing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: "settings.chatGPTPlan.refreshModels" })}
    </Button>
  );
}
