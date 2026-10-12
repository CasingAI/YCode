import { useEffect, useMemo, useState } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import {
  TID_LOGIN_API_KEY_CANCEL_BUTTON,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_ERROR,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultTemplateId,
  resolveLoginApiKeyProviderLabel,
  resolveLoginApiKeyProviderOptions,
  shouldShowLoginApiKeyLink,
  type ApiKeyProviderChoice,
} from "@/login/LoginApiKeyForm.helpers.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

interface LoginApiKeyFormProps {
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onSkipped: () => void | Promise<void>;
}

export function LoginApiKeyForm({ onCancel, onSaved, onSkipped }: LoginApiKeyFormProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { modelSelectionService, providerSettingsService, settingService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // 可选供应商 = 设置页 quota Tag 口径的子集（单 Key 直查型），见
  // docs/specs/onboarding-quota-providers.md。模板列表就绪前先不预选，
  // 避免默认 bigmodel 与实际可用列表脱节。
  const providerOptions = useMemo(
    () => resolveLoginApiKeyProviderOptions(providerSettingsView?.providerTemplates),
    [providerSettingsView],
  );
  const [providerChoice, setProviderChoice] = useState<ApiKeyProviderChoice | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providerOptions.length === 0) {
      setProviderChoice(null);
      return;
    }
    setProviderChoice((current) => {
      if (current && providerOptions.some((option) => option.templateId === current)) {
        return current;
      }
      return (
        resolveLoginApiKeyDefaultTemplateId(
          locale,
          providerOptions.map((option) => option.templateId),
        ) ?? null
      );
    });
  }, [locale, providerOptions]);

  const selectedTemplate = providerChoice
    ? (providerOptions.find((option) => option.templateId === providerChoice) ??
      providerSettingsView?.providerTemplates.find(
        (template) => template.templateId === providerChoice,
      ))
    : null;
  const templateId = selectedTemplate?.templateId ?? providerChoice ?? "";
  const providerLabel = resolveLoginApiKeyProviderLabel(selectedTemplate, templateId, locale);
  const templateAccess = selectedTemplate?.config.access;
  const apiKeyUrl = isApiKeyAccess(templateAccess) ? templateAccess.apiKeyManagementUrl : undefined;
  // 用户已经输入或回填 API Key 后，右侧获取入口会挤占密码输入区域。
  const showApiKeyLink = shouldShowLoginApiKeyLink(apiKeyValue, apiKeyUrl ?? undefined);

  const saveApiKeyProvider = async () => {
    const apiKey = apiKeyValue.trim();
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }
    if (!selectedTemplate) {
      setError(
        intl.formatMessage({ id: "login.apiKey.providerMissingError" }, { provider: providerLabel }),
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const template = (await providerSettingsService.getView()).providerTemplates.find(
        (item) => item.templateId === selectedTemplate.templateId,
      );
      if (!template || !isApiKeyAccess(template.config.access)) {
        setError(
          intl.formatMessage(
            { id: "login.apiKey.providerMissingError" },
            { provider: providerLabel },
          ),
        );
        return;
      }

      const created = await providerSettingsService.createPersonalProvider({
        templateId: template.templateId,
        initialConfig: { access: { type: template.config.access.type, apiKey } },
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    } catch (saveError) {
      logger.error("[LoginEntry] 保存 API Key provider 失败", {
        templateId,
        error: saveError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const skipApiKeyProvider = async () => {
    setSkipping(true);
    setError(null);
    try {
      // 跳过只表示用户确认运行域，不能写入空 API Key
      // 或触发 API Key 登录成功事件，否则后续模型选择会误以为已有可用凭据。
      // 非智谱模板没有 providerFamilyDomain 归属，只关引导（见 helpers）。
      await settingService.update(buildLoginApiKeySkipSettings(templateId, Date.now()));
      await onSkipped();
    } catch (skipError) {
      logger.error("[LoginEntry] 跳过 API Key 登录失败", {
        providerChoice,
        error: skipError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.skipError" },
          {
            error: skipError instanceof Error ? skipError.message : String(skipError),
          },
        ),
      );
    } finally {
      setSkipping(false);
    }
  };

  const busy = saving || skipping;
  const canContinue = Boolean(apiKeyValue.trim() && selectedTemplate) && !busy;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.apiKey.title" })}
        </h2>
        <div className="space-y-2">
          <div>
            <Select
              value={providerChoice ?? ""}
              onValueChange={(value) => setProviderChoice(value as ApiKeyProviderChoice)}
              disabled={busy || providerOptions.length === 0}
            >
              <SelectTrigger
                id="login-api-key-provider"
                size="lg"
                className="h-10 w-full text-ui-base"
                data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
                aria-label={intl.formatMessage({
                  id: "login.apiKey.providerLabel",
                })}
              >
                <SelectValue
                  placeholder={intl.formatMessage({ id: "login.apiKey.providerMissingError" })}
                />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-lg">
                {providerOptions.map((option) => (
                  <SelectItem
                    key={option.templateId}
                    value={option.templateId}
                    className="rounded-md"
                    data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, option.templateId)}
                  >
                    <ProviderLogo logo={option.config.logo} className="size-4" />
                    {resolveLoginApiKeyProviderLabel(option, option.templateId, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Input
              id="login-api-key"
              type="password"
              size="lg"
              className={`h-10 w-full text-ui-base ${showApiKeyLink ? "pr-28" : ""}`}
              data-testid={TID_LOGIN_API_KEY_INPUT}
              aria-label={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              value={apiKeyValue}
              placeholder={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              autoComplete="off"
              onChange={(event) => {
                setApiKeyValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyValue.trim() && !busy) {
                  void saveApiKeyProvider();
                }
              }}
            />
            {showApiKeyLink ? (
              <button
                type="button"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ui-base font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (apiKeyUrl) {
                    platform.openExternal(apiKeyUrl);
                  }
                }}
              >
                {intl.formatMessage({ id: "login.apiKey.getApiKey" })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_API_KEY_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CONTINUE_BUTTON}
          disabled={!canContinue}
          onClick={() => void saveApiKeyProvider()}
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CANCEL_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "login.apiKey.cancel" })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_API_KEY_SKIP_BUTTON}
          disabled={busy}
          onClick={() => void skipApiKeyProvider()}
        >
          {skipping ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.skip" })}
        </Button>
      </div>
    </div>
  );
}
