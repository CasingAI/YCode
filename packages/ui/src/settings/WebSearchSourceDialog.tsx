// 独立搜索源实例的通用添加/编辑弹窗（docs/specs/web-search-provider-capability.md）。
// 目录与模板信息来自 shared 元数据 + 内置模板；Key 走 personalConfig.access 稀疏 overlay，
// 出站代理走 provider rule 的 proxyMode（语义同 per-provider 代理，由 CLI 执行器消费），
// 删除经 useModelProviders 的 deleteProvider；本组件不新增持久化路径，也不维护第二份搜索源配置存储。

import { useEffect, useRef, useState } from "react";
import type { ApiKeyAccessConfigObject } from "@zcode/provider";
import type { WebSearchCapableProviderTemplateId } from "@zcode/shared";
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
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  isWebSearchSourceDraftComplete,
  type WebSearchSourceTemplateOption,
} from "@/settings/webSearchSourceCatalog.js";

const PROXY_MODES = ["default", "proxy", "direct"] as const;
export type WebSearchProxyMode = (typeof PROXY_MODES)[number];

export interface WebSearchSourceCreateInput {
  templateId: WebSearchCapableProviderTemplateId;
  accessType: ApiKeyAccessConfigObject["type"];
  apiKey: string;
  proxyMode: WebSearchProxyMode;
}

export interface WebSearchSourcePatch {
  apiKey: string;
  proxyMode: WebSearchProxyMode;
}

export function WebSearchSourceDialog({
  open,
  mode,
  templates,
  provider,
  template,
  saving,
  errorMessage,
  retryProxyMode,
  onOpenChange,
  onCreate,
  onSave,
  onDelete,
}: {
  open: boolean;
  mode: "create" | "edit";
  /** 添加目录；编辑态仍用它解析模板名称与 Key 链接。 */
  templates: readonly WebSearchSourceTemplateOption[];
  /** 编辑态正在操作的实例；创建态为 null。 */
  provider: ProviderSettingsFormProvider | null;
  /** 编辑态实例对应的模板选项；模板元数据缺失时隐藏 Key 链接，仍允许编辑 Key。 */
  template?: WebSearchSourceTemplateOption;
  saving: boolean;
  errorMessage?: string;
  /** 创建成功后代理写入失败转编辑态时，保留用户已提交的代理选择。 */
  retryProxyMode?: WebSearchProxyMode;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: WebSearchSourceCreateInput) => Promise<void>;
  onSave: (provider: ProviderSettingsFormProvider, patch: WebSearchSourcePatch) => Promise<void>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [templateId, setTemplateId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [proxyMode, setProxyMode] = useState<WebSearchProxyMode>("default");
  const resetSessionRef = useRef<string | null>(null);

  // 草稿只在「打开会话 / 切换到另一个实例」时从权威状态重置。
  // 创建会话的 key 不包含 templateId：模板切换是同一会话内的草稿变更，由
  // onValueChange 明确清空 Key/代理，不能触发这里把所选模板弹回第一项。
  // provider/templates 的对象引用会随后台列表刷新变化，不能作为重置依据，
  // 否则用户在表单里输入的 Key 与代理会被无关刷新静默覆盖。
  useEffect(() => {
    if (!open) {
      resetSessionRef.current = null;
      return;
    }
    const sessionKey = mode === "edit" ? `edit:${provider?.providerId ?? ""}` : "create";
    if (resetSessionRef.current === sessionKey) return;
    resetSessionRef.current = sessionKey;
    if (mode === "edit") {
      // 实例已被其它窗口删除：不再重置草稿，由父级关闭弹窗。
      if (!provider) return;
      setTemplateId(provider.templateId ?? "");
      setApiKey(getProviderFormApiKey(provider));
      // 创建后代理写入失败转入编辑态时，provider 仍是默认代理；
      // 必须沿用用户刚提交的代理选择，否则重试会静默写回 default。
      setProxyMode(retryProxyMode ?? provider.proxyMode ?? "default");
      return;
    }
    setTemplateId(templates[0]?.templateId ?? "");
    setApiKey("");
    setProxyMode("default");
  }, [open, mode, provider, retryProxyMode, templates]);

  const selectedTemplate =
    templates.find((option) => option.templateId === templateId) ??
    (mode === "edit" ? template : undefined);
  const managementUrl = selectedTemplate?.apiKeyManagementUrl;
  const isCreate = mode === "create";
  const canSubmit = isCreate
    ? isWebSearchSourceDraftComplete({ templateId, apiKey })
    : provider !== null;
  // 编辑对象失效（provider 为空）时保存与删除都不可用，避免 handler 静默 return。
  const disabled = saving || !canSubmit;

  const handleDelete = async () => {
    if (!provider) return;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "settings.webSearch.deleteTitle" }),
      description: intl.formatMessage(
        { id: "settings.webSearch.deleteDescription" },
        { name: getProviderFormLabel(provider) },
      ),
      confirmLabel: intl.formatMessage({ id: "common.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    await onDelete(provider);
  };

  const handleSubmit = () => {
    if (isCreate) {
      if (!selectedTemplate) return;
      void onCreate({
        templateId: selectedTemplate.templateId,
        accessType: selectedTemplate.accessType,
        apiKey,
        proxyMode,
      });
      return;
    }
    if (provider) void onSave(provider, { apiKey, proxyMode });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="settings.webSearch.sourceDialog">
        <DialogHeader>
          <DialogTitle>
            {isCreate
              ? intl.formatMessage({ id: "settings.webSearch.addTitle" })
              : provider
                ? intl.formatMessage(
                    { id: "settings.webSearch.sourceSettingsTitle" },
                    { name: getProviderFormLabel(provider) },
                  )
                : null}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.webSearch.sourceSettingsDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {isCreate ? (
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "settings.webSearch.sourceTemplate" })}</Label>
              {templates.length > 1 ? (
                <Select
                  value={templateId}
                  disabled={saving}
                  onValueChange={(value) => {
                    if (value === templateId) return;
                    // 切换模板等于换一份草稿：上一个模板的 Key 与代理不适用，
                    // 显式清空；所选模板 id 保持用户选择，不在这里回退。
                    setTemplateId(value);
                    setApiKey("");
                    setProxyMode("default");
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid="settings.webSearch.sourceTemplateTrigger"
                    aria-label={intl.formatMessage({ id: "settings.webSearch.sourceTemplate" })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((option) => (
                      <SelectItem
                        key={option.templateId}
                        value={option.templateId}
                        data-testid={`settings.webSearch.sourceTemplateItem.${option.templateId}`}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                // 目录只有一个受允许模板时不摆单选控件，直接把模板名作为值展示。
                <div
                  className="flex h-8 items-center text-ui-base text-foreground"
                  data-testid="settings.webSearch.sourceTemplateValue"
                >
                  {selectedTemplate?.label ?? null}
                </div>
              )}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="web-search-source-api-key">
              {intl.formatMessage({ id: "settings.webSearch.apiKey" })}
            </Label>
            <Input
              id="web-search-source-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={saving}
              data-testid="settings.webSearch.sourceApiKeyInput"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <div className="flex items-center justify-end gap-3 text-ui-sm text-foreground-subtle">
              {managementUrl ? (
                <a
                  className="shrink-0 underline-offset-2 hover:underline"
                  href={managementUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {intl.formatMessage({ id: "settings.webSearch.getKey" })}
                </a>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "settings.webSearch.proxy" })}</Label>
            <Select
              value={proxyMode}
              disabled={saving}
              onValueChange={(value) => {
                if (value === "default" || value === "proxy" || value === "direct") {
                  setProxyMode(value);
                }
              }}
            >
              <SelectTrigger
                className="w-full"
                data-testid="settings.webSearch.sourceProxyTrigger"
                aria-label={intl.formatMessage({ id: "settings.webSearch.proxy" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_MODES.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    data-testid={`settings.webSearch.sourceProxyItem.${mode}`}
                  >
                    {intl.formatMessage({ id: `settings.webSearch.proxy.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {errorMessage ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>
        <DialogFooter
          className={`mt-2 items-center gap-2 ${
            isCreate ? "sm:justify-end" : "justify-between sm:justify-between"
          }`}
        >
          {" "}
          {isCreate ? null : (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={disabled}
              data-testid="settings.webSearch.sourceDelete"
              onClick={() => void handleDelete()}
            >
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          )}
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
              data-testid="settings.webSearch.sourceSave"
              onClick={handleSubmit}
            >
              {intl.formatMessage({
                id: saving
                  ? "common.saving"
                  : isCreate
                    ? "settings.webSearch.addAction"
                    : "common.save",
              })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
