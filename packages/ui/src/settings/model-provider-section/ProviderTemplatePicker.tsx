import type { ProviderSettingsView } from "@zcode/services";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { resolveProviderTemplateName } from "@zcode/provider";
import type { ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_BETA_HINT,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ProviderLogo } from "./ProviderLogo.js";
import {
  PROVIDER_TEMPLATE_QUOTA_TAG_CLASS_NAME,
  supportsTemplateBetaTag,
  supportsTemplateQuotaDisplay,
} from "./providerTemplateQuotaTag.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

type ProviderTemplateCreate = (templateId: string) => Promise<void>;
type CustomProviderCreate = (label: string) => Promise<void>;

export function ProviderTemplatePicker({
  templates,
  onBack,
  onCreateFromTemplate,
  onCreateCustom,
  creating,
  cliProxyCreationDisabled = false,
}: {
  templates: ProviderSettingsView["providerTemplates"];
  onBack: () => void;
  onCreateFromTemplate: ProviderTemplateCreate;
  onCreateCustom: CustomProviderCreate;
  creating: boolean;
  /**
   * CLI Proxy 新增仅限桌面本地：web/手机远控与远程 workspace 下禁用 cliproxy 分组。
   * 已存在条目的使用（聊天/额度/详情）不受影响，只禁新增入口。
   */
  cliProxyCreationDisabled?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const customLabel = intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  const cliproxyDesktopOnlyHint = cliProxyCreationDisabled
    ? intl.formatMessage({ id: "settings.modelProvider.cliproxyDesktopOnlyHint" })
    : null;
  const quotaTagLabel = intl.formatMessage({ id: "settings.modelProvider.templateQuotaTag" });
  const betaTagLabel = intl.formatMessage({ id: "settings.modelProvider.templateBetaTag" });
  const zhipuIds = ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"];
  // OpenCode 模板（opencode-go-* / opencode-zen-*）与侧栏一致拥有独立分组。
  // CLI Proxy 模板（cliproxy-*）同理：一个 Codex 账号 = 一个 provider 条目。
  const isOpenCodeTemplate = (templateId: string) => templateId.startsWith("opencode-");
  const isCliProxyTemplate = (templateId: string) => templateId.startsWith("cliproxy-");
  // 分组展示顺序：代理置顶、智谱置底。
  // ChatGPT Plan 分组自 2026-10-21 起不再展示：套餐剩余额度只在 legacy Codex
  // 凭据配合未公开端点时才能读到，SIWC 凭据无法进入该端点（见
  // docs/specs/openai-chatgpt-plan-provider.md「新增入口暂时隐藏」）。已配置的
  // provider 仍按既有详情分支渲染，恢复入口只需在此加回分组。
  const groups = [
    {
      id: "cliproxy",
      templates: templates.filter(
        (template) =>
          !zhipuIds.includes(template.templateId) && isCliProxyTemplate(template.templateId),
      ),
    },
    {
      id: "opencode",
      templates: templates.filter(
        (template) =>
          !zhipuIds.includes(template.templateId) && isOpenCodeTemplate(template.templateId),
      ),
    },
    {
      id: "other",
      templates: templates.filter(
        (template) =>
          !zhipuIds.includes(template.templateId) &&
          !isOpenCodeTemplate(template.templateId) &&
          !isCliProxyTemplate(template.templateId),
      ),
    },
    {
      id: "zhipu",
      templates: zhipuIds.flatMap((id) =>
        templates.filter((template) => template.templateId === id),
      ),
    },
  ] as const;
  const createWithFeedback = async (create: () => Promise<void>) => {
    const feedbackKey = "provider-template-create";
    dismissFeedback(feedbackKey);
    try {
      await create();
    } catch (error) {
      // Template 创建失败过去只写日志，用户留在选择页却看不到任何结果。
      // 失败继续留在当前页，并复用详情栏底部反馈横幅提供同一次创建的重试入口。
      // 完整 Schema issues 只进入统一 UI 日志；横幅保持可读摘要，避免原始数组撑满详情区。
      logger.error("[ProviderTemplatePicker] 创建供应商失败", error);
      const retry = () => void createWithFeedback(create);
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.templateCreateFailed" }),
        actionLabel: intl.formatMessage({ id: "settings.modelProvider.templateCreateRetry" }),
        onAction: retry,
        dismissible: true,
      });
    }
  };
  return (
    <section className="space-y-5" data-testid={TID_MODEL_PROVIDER_TEMPLATE_PICKER}>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.templatePickerTitle" })}
        </h2>
      </div>

      {/* Beta 风险提示固定显示：Beta 白名单是静态事实源，按当前可见卡片是否含 Beta
          条件渲染会引入第二条判定路径，白名单变动时容易漏改。 */}
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid={TID_MODEL_PROVIDER_TEMPLATE_BETA_HINT}
      >
        {intl.formatMessage({ id: "settings.modelProvider.templateBetaHint" })}
      </p>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.id} data-provider-template-group={group.id} className="space-y-3">
            <h3 className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `settings.modelProvider.templateGroup.${group.id}` })}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.id === "other" ? (
                <ProviderTemplateCard
                  label={intl.formatMessage({ id: "settings.modelProvider.createCustomProvider" })}
                  disabled={creating}
                  testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}
                  icon={
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover">
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </span>
                  }
                  onClick={() => void createWithFeedback(() => onCreateCustom(customLabel))}
                />
              ) : null}
              {group.templates.map((template) => {
                const label = resolveProviderTemplateName(template.templateId, template, locale);
                const cliproxyDisabled = group.id === "cliproxy" && cliProxyCreationDisabled;
                return (
                  <ProviderTemplateCard
                    key={template.templateId}
                    label={label}
                    tagLabel={
                      supportsTemplateQuotaDisplay(template.templateId) ? quotaTagLabel : undefined
                    }
                    betaTagLabel={
                      supportsTemplateBetaTag(template.templateId) ? betaTagLabel : undefined
                    }
                    hintLabel={cliproxyDisabled ? cliproxyDesktopOnlyHint : undefined}
                    disabled={creating || cliproxyDisabled}
                    testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId)}
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center">
                        <ProviderLogo logo={template.config.logo} className="size-8" />
                      </span>
                    }
                    onClick={() =>
                      void createWithFeedback(() => onCreateFromTemplate(template.templateId))
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ProviderTemplateCard({
  label,
  tagLabel,
  betaTagLabel,
  hintLabel,
  disabled,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  /** 已适配额度显示的标注；仅在模板确实具备额度/余额能力时传入。 */
  tagLabel?: string;
  /** Beta 标注：未经真实账号验证的能力，仅跟在 quota Tag 之后出现。 */
  betaTagLabel?: string;
  /** 禁用原因提示：cliproxy 在 web/远端下仅桌面可添加时展示。 */
  hintLabel?: string | null;
  disabled: boolean;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <button
        type="button"
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        {/* Tag 走行内流而不是 flex 子项：OpenCode 六张标题都是两行，flex 会把 Tag 甩到
            独立一行、和邻居卡片错位；行内流才能始终紧贴标题最后一行末尾。 */}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">
          {label}
          {tagLabel ? (
            <>
              {" "}
              <span className={PROVIDER_TEMPLATE_QUOTA_TAG_CLASS_NAME}>{tagLabel}</span>
            </>
          ) : null}
          {betaTagLabel ? (
            <>
              {" "}
              <span className={PROVIDER_TEMPLATE_QUOTA_TAG_CLASS_NAME}>{betaTagLabel}</span>
            </>
          ) : null}
          {hintLabel ? (
            <span className="mt-1 block text-ui-sm font-normal text-foreground-subtle">
              {hintLabel}
            </span>
          ) : null}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </ControlHintTooltip>
  );
}
