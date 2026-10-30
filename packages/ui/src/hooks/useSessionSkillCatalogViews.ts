import { useMemo } from "react";
import { useSkills } from "@/hooks/useSkills.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveSessionSkillCatalogViews,
  type SessionSkillCatalogViews,
} from "@/lib/skillCatalogViews.js";

/**
 * 会话级技能目录的两个只读视图（skill-title.md）：
 *
 * - `knownSkillNames`（小写集合）：消息气泡判定裸 `$name` 是否可以画成技能芯片；
 * - `skillDisplayNameByRef`（引用 → 展示名）：Skill 卡片主标题。
 *
 * 两者共用**同一个** `useSkills` 实例和同一次 `getSkillReferenceCatalog` 请求。
 * 该接口没有缓存层，逐条消息或每个视图各挂一个 hook 都会按消息数放大 RPC；这里必须
 * 在列表/会话级调用一次，再由 rowContext 下发。
 *
 * 白名单过滤口径复用 `filterSkillsForProvider`：`$` 面板也走这个过滤，白名单比面板宽
 * 会出现「气泡染色了但面板里选不到」的不一致。名字比较统一小写，因为目录 `name` 是
 * 用户可写的展示名，可能含大写。
 *
 * 目录未就绪、请求失败或只读视图时两个视图都是 `undefined`，调用方退回既有显示：
 * 气泡宁可暂时多染色，也不能让真实技能芯片整批消失；Skill 卡片则显示中性占位，
 * 不能提前露出原始 ref。只有 authoritative 结果（包括空目录）才产生派生表。
 */
export function useSessionSkillCatalogViews(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
}): SessionSkillCatalogViews {
  const { locale } = useZCodeIntl();
  const { skills, ready } = useSkills({
    workspacePath: options.workspacePath,
    workspaceIdentity: options.workspaceIdentity,
    sessionId: options.sessionId,
    enabled: options.enabled,
  });

  return useMemo(
    () =>
      deriveSessionSkillCatalogViews({
        enabled: options.enabled,
        ready,
        skills,
        locale,
      }),
    [locale, options.enabled, ready, skills],
  );
}
