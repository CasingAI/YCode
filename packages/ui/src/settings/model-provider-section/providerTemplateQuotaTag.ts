import { isDeepSeekProviderTemplateId, isOpenCodeProviderTemplateId } from "@zcode/shared";

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
 * DeepSeek 走 `isDeepSeekProviderTemplateId`，OpenCode 走前缀判定
 * `isOpenCodeProviderTemplateId`（新增 `opencode-*` 模板自动继承）。
 * 与输入框 context 浮层的显示条件同源，保证「卡片上标了」和「实际能看到」不会分叉。
 *
 * 官方 Coding Plan / Start Plan 额度只挂在账号级 provider（`account:zai-*`）上，
 * 从模板新建出来的是普通个人 provider，因此不在此列——详见
 * docs/specs/provider-template-quota-tag.md。
 */
export function supportsTemplateQuotaDisplay(templateId: string): boolean {
  return isOpenCodeProviderTemplateId(templateId) || isDeepSeekProviderTemplateId(templateId);
}
