// Jina 独立搜索源实例的设置模态（docs/specs/web-search-provider-capability.md）。
// 实例就是 standard-personal provider 记录：Key 走 personalConfig.access 稀疏 overlay，
// 出站代理走 provider rule 的 proxyMode（语义同 network-settings 的 per-provider 代理，
// 由 CLI 执行器 resolveWebSearchFetch 消费），删除走 deletePersonalProvider；
// 本组件不新增持久化路径，也不维护第二份 Jina 配置存储。

import { useEffect, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  getProviderFormApiKey,
  getProviderFormApiKeyManagementUrl,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";

const PROXY_MODES = ["default", "proxy", "direct"] as const;
export type WebSearchProxyMode = (typeof PROXY_MODES)[number];

export function WebSearchJinaSettingsDialog({
  provider,
  saving,
  onOpenChange,
  onSave,
  onDelete,
}: {
  /** null = 关闭；非 null = 正在编辑该实例。 */
  provider: ProviderSettingsFormProvider | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    provider: ProviderSettingsFormProvider,
    patch: { apiKey: string; proxyMode: WebSearchProxyMode },
  ) => Promise<void>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [apiKey, setApiKey] = useState("");
  const [proxyMode, setProxyMode] = useState<WebSearchProxyMode>("default");

  // 打开（或切换实例）时从权威表单状态重置草稿；保存由父级落盘后关窗。
  useEffect(() => {
    if (!provider) return;
    setApiKey(getProviderFormApiKey(provider));
    setProxyMode(provider.proxyMode ?? "default");
  }, [provider]);

  const managementUrl = provider
    ? getProviderFormApiKeyManagementUrl(provider)
    : undefined;
  const disabled = saving || provider === null;

  const handleDelete = async () => {
    if (!provider) return;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "settings.webSearch.jinaDeleteTitle" }),
      description: intl.formatMessage(
        { id: "settings.webSearch.jinaDeleteDescription" },
        { name: getProviderFormLabel(provider) },
      ),
      confirmLabel: intl.formatMessage({ id: "common.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    await onDelete(provider);
  };

  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="settings.webSearch.jinaDialog">
        <DialogHeader>
          <DialogTitle>
            {provider
              ? intl.formatMessage(
                  { id: "settings.webSearch.jinaSettingsTitle" },
                  { name: getProviderFormLabel(provider) },
                )
              : null}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.webSearch.jinaSettingsDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="web-search-jina-api-key">
              {intl.formatMessage({ id: "settings.webSearch.jinaApiKey" })}
            </Label>
            <Input
              id="web-search-jina-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={disabled}
              data-testid="settings.webSearch.jinaApiKeyInput"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <div className="flex items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
              <span className="min-w-0">
                {intl.formatMessage({ id: "settings.webSearch.jinaApiKeyHint" })}
              </span>
              {managementUrl ? (
                <a
                  className="shrink-0 underline-offset-2 hover:underline"
                  href={managementUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {intl.formatMessage({ id: "settings.webSearch.jinaGetKey" })}
                </a>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "settings.webSearch.jinaProxy" })}</Label>
            <Select
              value={proxyMode}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === "default" || value === "proxy" || value === "direct") {
                  setProxyMode(value);
                }
              }}
            >
              <SelectTrigger
                className="w-full"
                data-testid="settings.webSearch.jinaProxyTrigger"
                aria-label={intl.formatMessage({ id: "settings.webSearch.jinaProxy" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_MODES.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    data-testid={`settings.webSearch.jinaProxyItem.${mode}`}
                  >
                    {intl.formatMessage({ id: `settings.webSearch.jinaProxy.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.webSearch.jinaProxyHint" })}
            </span>
          </div>
        </div>
        <DialogFooter className="mt-2 items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={disabled}
            data-testid="settings.webSearch.jinaDelete"
            onClick={() => void handleDelete()}
          >
            {intl.formatMessage({ id: "common.delete" })}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              disabled={disabled}
              data-testid="settings.webSearch.jinaSave"
              onClick={() => {
                if (provider) void onSave(provider, { apiKey, proxyMode });
              }}
            >
              {intl.formatMessage({ id: saving ? "common.saving" : "common.save" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
