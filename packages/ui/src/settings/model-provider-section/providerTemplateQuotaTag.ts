import {
  isDeepSeekProviderTemplateId,
  isMiniMaxTokenPlanProviderTemplateId,
  isOpenCodeProviderTemplateId,
  isOpenRouterProviderTemplateId,
} from "@zcode/shared";

/**
 * 卡片 Tag 用的小胶囊样式，与设置页既有的能力标签（`ModelInputCapabilityBadge`、
 * 模型选择器徽标）同源。`rounded-full` 在 DESIGN.md 里属于「刻意胶囊形」。
 */
export const PROVIDER_TEMPLATE_QUOTA_TAG_CLASS_NAME =
  "pointer-events-none inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-surface px-1 py-px align-middle text-ui-xs font-medium leading-normal text-foreground-subtle";

/**
 * 该模板配好凭据后，用户能否在 YCode 内看到这家账号的额度/余额。
 *
 * 判定唯一事实源是 `@zcode/shared` 中各能力自己的模板判定函数，这里只取并集：
 * DeepSeek 走 `isDeepSeekProviderTemplateId`，Go 走 `isOpenCodeGoProviderTemplateId`，
 * Zen 走 `isOpenCodeZenProviderTemplateId`，MiniMax Token Plan 走
 * `isMiniMaxTokenPlanProviderTemplateId`，OpenRouter 走 `isOpenRouterProviderTemplateId`。
 * 与输入框 context 浮层的显示条件同源，保证「卡片上标了」和「实际能看到」不会分叉。
 * 注意现有 `minimax` 平台模板无额度能力，不在并集内——挂 Tag 就是撒谎。
 *
 * 官方 Coding Plan / Start Plan 额度只挂在账号级 provider（`account:zai-*`）上，
 * 从模板新建出来的是普通个人 provider，因此不在此列——详见
 * docs/specs/provider-template-quota-tag.md。
 */
export function supportsTemplateQuotaDisplay(templateId: string): boolean {
  return (
    isOpenCodeProviderTemplateId(templateId) ||
    isDeepSeekProviderTemplateId(templateId) ||
    isMiniMaxTokenPlanProviderTemplateId(templateId) ||
    isOpenRouterProviderTemplateId(templateId)
  );
}

/**
 * Beta Tag：未经真实账号验证的能力（维护者没有该供应商的付费账号）。
 * 当前只有 `minimax-token-plan` 与 `openrouter`（见 docs/specs/minimax-quota.md 与
 * docs/specs/openrouter-balance.md）。去 Beta 条件：完成端到端验证后从白名单移除即可。
 * 注意 `isOpenCodeProviderTemplateId` 的宽泛前缀仍保留：新增 `opencode-*` 模板自动继承
 * quota Tag（Go/Zen 窄判定只影响数据组件挂载，不影响 Tag 并集）。
 */
export function supportsTemplateBetaTag(templateId: string): boolean {
  return (
    isMiniMaxTokenPlanProviderTemplateId(templateId) || isOpenRouterProviderTemplateId(templateId)
  );
}
